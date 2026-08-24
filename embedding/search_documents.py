"""
search_documents.py

Unified RAG Retrieval Engine for Dual Databases:
1. PGVector (Neon PostgreSQL) - Structured Legal Data (Articles, CaseLaws, Circulars, Legislation, Notifications, etc.)
2. Pinecone - Unstructured Legal Documents (CLA Books, PDFs)

Reads environment variables dynamically:
- NEON_DB_URI / DATABASE_URL
- PINECONE_API_KEY
- PINECONE_INDEX_NAME
- OPENAI_API_KEY

Embedding Model: text-embedding-3-small (1536 dimensions)
Retrieval Strategy: Top-5 from PGVector + Top-5 from Pinecone (Total 10 chunks combined).
"""

import os
import re
import json
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    sys.stderr.write("[ERROR] Missing required Python package 'psycopg2'. Please run: pip install psycopg2-binary\n")
    raise
from dotenv import load_dotenv
from openai import OpenAI

dotenv_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
if os.path.exists(dotenv_path):
    load_dotenv(dotenv_path)
else:
    load_dotenv()

# ---------- ENVIRONMENT CONFIGURATION ----------

NEON_DB_URI = os.getenv("NEON_DB_URI") or os.getenv("DATABASE_URL")
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "cla-online")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "1536"))

_openai_client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])
_pinecone_index = None


def get_db_connection():
    if not NEON_DB_URI:
        raise ValueError("NEON_DB_URI environment variable is not set.")
    try:
        return psycopg2.connect(NEON_DB_URI)
    except Exception as e:
        sys.stderr.write(f"[DB Warning] Primary DB connection failed ({e}). Retrying with direct host...\n")
        alt_uri = NEON_DB_URI.replace("-pooler", "")
        return psycopg2.connect(alt_uri)


def get_pinecone_index():
    global _pinecone_index
    if _pinecone_index is None:
        key = os.getenv("PINECONE_API_KEY")
        idx_name = os.getenv("PINECONE_INDEX_NAME", "cla-online")
        if not key:
            sys.stderr.write("[Pinecone Warning] PINECONE_API_KEY is not set in environment.\n")
            return None
        try:
            from pinecone import Pinecone
            pc = Pinecone(api_key=key)
            _pinecone_index = pc.Index(idx_name)
            sys.stderr.write(f"[Pinecone Success] Initialized Pinecone index '{idx_name}' successfully.\n")
        except Exception as e:
            sys.stderr.write(f"[Pinecone Error] Failed to initialize Pinecone index: {e}\n")
            _pinecone_index = None
    return _pinecone_index


def embed_query(query_text):
    """Generate query embedding using text-embedding-3-small (1536 dims)."""
    try:
        result = _openai_client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=[query_text],
            dimensions=EMBEDDING_DIMENSIONS
        )
        return result.data[0].embedding
    except Exception as e:
        sys.stderr.write(f"[Embedding Error] Failed to generate query embedding: {e}\n")
        raise e

# ---------- 1. PGVECTOR SEARCH (STRUCTURED DATA) ----------

def vector_search(conn, query_text, top_k=5, source_filter=None, query_vec=None):
    """Retrieve top-K chunks from Neon PostgreSQL via pgvector HNSW index (<=>)."""
    if query_vec is None:
        query_vec = embed_query(query_text)

    vec_str = "[" + ",".join(str(v) for v in query_vec) + "]"
    
    where_clause = ""
    full_params = [vec_str]
    
    if source_filter and not source_filter.startswith("!"):
        where_clause = ' WHERE "source_table" = %s'
        full_params.append(source_filter)
    elif source_filter and source_filter.startswith("!"):
        ex_table = source_filter[1:]
        where_clause = ' WHERE "source_table" != %s'
        full_params.append(ex_table)
        
    sql = f"""
        SELECT "embedding_id", "source_table", "record_id", "parent_id", "chunk_text",
               "category", "subject", "sections", "doc_title", "law_title", "doc_date",
               1 - ("embedding" <=> %s::vector) AS score
        FROM "document_embeddings"
        {where_clause}
        ORDER BY "embedding" <=> %s::vector ASC
        LIMIT %s;
    """
    full_params.extend([vec_str, top_k])

    cur = conn.cursor(cursor_factory=RealDictCursor)
    cur.execute(sql, full_params)
    rows = cur.fetchall()
    cur.close()

    results = []
    for r in rows:
        results.append({
            "embedding_id": r["embedding_id"],
            "source_table": r["source_table"],
            "record_id": r["record_id"],
            "parent_id": r["parent_id"],
            "chunk_text": r["chunk_text"],
            "category": r["category"],
            "subject": r["subject"],
            "sections": r["sections"],
            "doc_title": r["doc_title"],
            "law_title": r["law_title"],
            "doc_date": str(r["doc_date"]) if r["doc_date"] else None,
            "score": float(r["score"]) if r["score"] else 0.0,
            "database_source": "PGVector"
        })
    return results

# ---------- 2. PINECONE SEARCH (UNSTRUCTURED DATA) ----------

def pinecone_search(query_text, top_k=5, query_vec=None):
    """Retrieve top-K chunks from Pinecone unstructured vector database (cla-online)."""
    index = get_pinecone_index()
    if index is None:
        return []

    if query_vec is None:
        query_vec = embed_query(query_text)

    try:
        res = index.query(
            vector=query_vec,
            top_k=top_k,
            include_metadata=True
        )

        results = []
        for match in res.matches:
            meta = match.metadata or {}
            chunk_text = meta.get("text") or meta.get("raw_text") or ""
            book_name = meta.get("book_name") or meta.get("file_name") or "Unstructured Document"
            page_no = meta.get("page_number")
            section_label = meta.get("section_label") or meta.get("source")

            if not chunk_text.startswith("["):
                header_parts = ["Pinecone Unstructured", f"Book: {book_name}"]
                if page_no:
                    header_parts.append(f"Page: {page_no}")
                if section_label:
                    header_parts.append(f"Section: {section_label}")
                prefix = "[" + " | ".join(header_parts) + "]\n"
                enriched_text = prefix + chunk_text
            else:
                enriched_text = chunk_text

            results.append({
                "embedding_id": str(match.id),
                "source_table": meta.get("source") or "Pinecone_Unstructured",
                "record_id": str(match.id),
                "parent_id": page_no,
                "chunk_text": enriched_text,
                "category": "Unstructured Books / Documents",
                "subject": book_name,
                "sections": section_label,
                "doc_title": book_name,
                "law_title": f"Book Page {page_no}" if page_no else "Unstructured PDF",
                "doc_date": None,
                "score": float(match.score),
                "database_source": "Pinecone"
            })
        return results
    except Exception as e:
        sys.stderr.write(f"[Pinecone Search Error] {e}\n")
        return []

# ---------- 3. DUAL RETRIEVAL & HYBRID PIPELINE ----------

def fetch_source_details(conn, source_table, record_id, parent_id):
    """Retrieve untouched parent and child source records directly from Neon PostgreSQL or Pinecone."""
    cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        if source_table == "Articles":
            cur.execute('SELECT * FROM "Articles_data_2025" WHERE "ID" = %s;', (record_id,))
            child = cur.fetchone()
            cur.execute('SELECT * FROM "Articles_2025" WHERE "ID" = %s;', (parent_id,))
            parent = cur.fetchone()
            return {"child": child, "parent": parent}

        elif source_table == "CaseLaws":
            cur.execute('SELECT * FROM "caselaws_data_2025" WHERE "ID" = %s;', (record_id,))
            child = cur.fetchone()
            cur.execute('SELECT * FROM "caselaws_2025" WHERE "id" = %s;', (parent_id,))
            parent = cur.fetchone()
            return {"child": child, "parent": parent}

        elif source_table == "Circular":
            cur.execute('SELECT * FROM "Circular_data_2025" WHERE "ID" = %s;', (record_id,))
            child = cur.fetchone()
            cur.execute('SELECT * FROM "Circular_2025" WHERE "id" = %s;', (parent_id,))
            parent = cur.fetchone()
            return {"child": child, "parent": parent}

        elif source_table == "Legislation":
            cur.execute('SELECT * FROM "legislation_data_2025" WHERE "ID" = %s;', (record_id,))
            child = cur.fetchone()
            cur.execute('SELECT * FROM "Legislation_2025" WHERE "id" = %s;', (parent_id,))
            parent = cur.fetchone()
            return {"child": child, "parent": parent}

        elif source_table == "Notifications":
            cur.execute('SELECT * FROM "notifications_data_2025" WHERE "ID" = %s;', (record_id,))
            child = cur.fetchone()
            cur.execute('SELECT * FROM "notifications_2025" WHERE "Id" = %s;', (parent_id,))
            parent = cur.fetchone()
            return {"child": child, "parent": parent}

        elif source_table == "Query":
            cur.execute('SELECT * FROM "query_data" WHERE "ID" = %s;', (record_id,))
            child = cur.fetchone()
            cur.execute('SELECT * FROM "Query" WHERE "ID" = %s;', (parent_id,))
            parent = cur.fetchone()
            return {"child": child, "parent": parent}

        elif source_table == "CLASE_Commentary":
            cur.execute('SELECT * FROM "CLASE_Commentary" WHERE "ID" = %s;', (record_id,))
            comm = cur.fetchone()
            act = None
            if comm and comm.get("commentary_ActID"):
                cur.execute('SELECT * FROM "CLASE_Commentary_Act" WHERE "ID" = %s;', (comm["commentary_ActID"],))
                act = cur.fetchone()
            return {"commentary": comm, "act": act}

        elif source_table == "CLASE_Procedure_Details":
            cur.execute('SELECT * FROM "CLASE_Procedure_Details_2025" WHERE "ID" = %s;', (record_id,))
            proc = cur.fetchone()
            return {"procedure": proc}

        elif not source_table or source_table in ["CLA Books", "Pinecone", "Pinecone_Unstructured", "Pinecone Unstructured"] or "pinecone" in str(source_table).lower() or "book" in str(source_table).lower():
            parent = {
                "Title": "CLA Books & Unstructured Documents",
                "Category": "Book / PDF (Pinecone)",
                "FileName": "CLA Books Library",
                "Author": "Corporate Law Adviser",
                "Sections": f"Page {parent_id}" if parent_id else "Unstructured Document",
            }
            child = {
                "FileName": "CLA Books Library",
                "Sections": f"Page {parent_id}" if parent_id else "Unstructured Document",
                "Category": "Book / PDF (Pinecone)",
            }
            
            # First attempt: Lookup in PGVector document_embeddings table for cached chunk text
            try:
                rec_str = str(record_id) if record_id is not None else ""
                cur.execute('''
                    SELECT "chunk_text", "doc_title", "law_title", "sections", "category", "subject"
                    FROM "document_embeddings"
                    WHERE "embedding_id" = %s OR "record_id"::text = %s
                    LIMIT 1;
                ''', (rec_str, rec_str))
                db_row = cur.fetchone()
                if db_row and db_row.get("chunk_text"):
                    chunk_txt = db_row["chunk_text"]
                    doc_title = db_row.get("doc_title") or db_row.get("law_title") or parent["Title"]
                    sec_info = db_row.get("sections") or parent["Sections"]
                    parent["Title"] = doc_title
                    parent["Sections"] = sec_info
                    parent["Subject"] = db_row.get("subject") or doc_title
                    child["Sections"] = sec_info
                    child["chunk_text"] = chunk_txt
                    child["Filetext"] = chunk_txt
                    child["Article_Text"] = chunk_txt
                    return {"child": child, "parent": parent, "text": chunk_txt}
            except Exception as db_err:
                sys.stderr.write(f"[PGVector Citation Lookup Warning] {db_err}\n")

            # Second attempt: Lookup via Pinecone index fetch
            try:
                pc_idx = get_pinecone_index()
                if pc_idx and record_id:
                    ids_to_try = [str(record_id)]
                    if parent_id:
                        ids_to_try.append(str(parent_id))
                    fetch_res = pc_idx.fetch(ids=ids_to_try)
                    vectors_map = getattr(fetch_res, "vectors", {}) if hasattr(fetch_res, "vectors") else (fetch_res.get("vectors") if isinstance(fetch_res, dict) else {})
                    for vid in ids_to_try:
                        if vectors_map and vid in vectors_map:
                            vec = vectors_map[vid]
                            meta = getattr(vec, "metadata", {}) if hasattr(vec, "metadata") else (vec.get("metadata", {}) if isinstance(vec, dict) else {})
                            chunk_txt = meta.get("chunk_text") or meta.get("text") or meta.get("raw_text") or ""
                            doc_title = meta.get("doc_title") or meta.get("subject") or meta.get("book_name") or "CLA Books & Unstructured Documents"
                            sec_info = meta.get("sections") or f"Page {meta.get('page_no') or parent_id or 'N/A'}"

                            parent["Title"] = doc_title
                            parent["Sections"] = sec_info
                            parent["Subject"] = meta.get("subject") or doc_title
                            child["Sections"] = sec_info
                            child["chunk_text"] = chunk_txt
                            child["Filetext"] = chunk_txt
                            child["Article_Text"] = chunk_txt
                            return {"child": child, "parent": parent, "text": chunk_txt}
            except Exception as pc_err:
                sys.stderr.write(f"[Pinecone Citation Detail Error] {pc_err}\n")
            return {"child": child, "parent": parent}
    except Exception as e:
        sys.stderr.write(f"[Source Detail Error] {source_table} ID {record_id}: {e}\n")
    finally:
        cur.close()
    return None


def dual_retrieval(conn, query_text, top_k_pgvector=5, top_k_pinecone=5, source_filter=None, fetch_full_sources=True):
    """
    Retrieve Top-K chunks from BOTH PGVector (structured data) AND Pinecone (unstructured data).
    Combines Top-5 from PGVector + Top-5 from Pinecone (Total 10 chunks).
    """
    query_vec = embed_query(query_text)

    # 1. Retrieve PGVector chunks (structured data)
    try:
        pg_chunks = vector_search(conn, query_text, top_k=top_k_pgvector, source_filter=source_filter, query_vec=query_vec)
    except Exception as e:
        sys.stderr.write(f"[PGVector Search Error] {e}\n")
        pg_chunks = []

    # Attach full source data for PGVector hits if requested
    if fetch_full_sources and pg_chunks:
        for hit in pg_chunks:
            full_data = fetch_source_details(conn, hit["source_table"], hit["record_id"], hit["parent_id"])
            hit["full_source"] = full_data

    # 2. Retrieve Pinecone chunks (unstructured data)
    pc_chunks = []
    if not source_filter or source_filter.startswith("!") or "pinecone" in str(source_filter).lower() or "book" in str(source_filter).lower() or "cla" in str(source_filter).lower():
        pc_chunks = pinecone_search(query_text, top_k=top_k_pinecone, query_vec=query_vec)

    # Combine both Top-5 PGVector + Top-5 Pinecone chunks
    combined_results = pg_chunks + pc_chunks
    return combined_results


def hybrid_search(conn, query_text, top_k=5, source_filter=None, fetch_full_sources=True):
    """Backward compatible wrapper that calls dual_retrieval."""
    return dual_retrieval(
        conn=conn,
        query_text=query_text,
        top_k_pgvector=top_k,
        top_k_pinecone=top_k,
        source_filter=source_filter,
        fetch_full_sources=fetch_full_sources
    )

# ---------- CLI / STDIN INTERFACE FOR NODE.JS INTEGRATION ----------

def handle_json_input():
    raw_input = sys.stdin.read()
    if not raw_input or not raw_input.strip():
        print(json.dumps({"error": "Empty stdin payload"}))
        return

    try:
        payload = json.loads(raw_input)
    except Exception as e:
        print(json.dumps({"error": f"Invalid JSON payload: {e}"}))
        return

    action = payload.get("action", "search")

    conn = get_db_connection()
    try:
        if action == "get_citation":
            source_table = payload.get("source_table")
            record_id = payload.get("record_id")
            parent_id = payload.get("parent_id")
            details = fetch_source_details(conn, source_table, record_id, parent_id)
            print(json.dumps({"results": details}, default=str))
        else:
            query = payload.get("query", "")
            top_k = payload.get("top_k", 5)
            source_filter = payload.get("source_filter")
            
            fetch_full_sources = payload.get("fetch_full_sources", False)
            results = dual_retrieval(
                conn=conn,
                query_text=query,
                top_k_pgvector=top_k,
                top_k_pinecone=top_k,
                source_filter=source_filter,
                fetch_full_sources=fetch_full_sources
            )
            print(json.dumps({"results": results}, default=str))
    except Exception as e:
        print(json.dumps({"error": str(e)}))
    finally:
        conn.close()


def main():
    if "--json" in sys.argv:
        handle_json_input()
        return

    query = None
    if len(sys.argv) > 1:
        query = " ".join([arg for arg in sys.argv[1:] if arg != "--json"])

    if not query and not sys.stdin.isatty():
        handle_json_input()
        return

    if not query:
        query = "What are the rules regarding company deposits under Companies Act 2013?"

    conn = get_db_connection()
    try:
        results = dual_retrieval(conn, query, top_k_pgvector=5, top_k_pinecone=5)
        print(json.dumps(results, indent=2, default=str))
    finally:
        conn.close()


if __name__ == "__main__":
    main()
