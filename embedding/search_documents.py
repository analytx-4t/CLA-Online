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
import sys
try:
    import psycopg2
    from psycopg2.extras import RealDictCursor
except ImportError:
    sys.stderr.write("[ERROR] Missing required Python package 'psycopg2'. Please run: pip install psycopg2-binary\n")
    raise
from dotenv import load_dotenv
from openai import OpenAI
from urllib.parse import quote

_embed_cache = {}

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
    """Generate query embedding using text-embedding-3-small (1536 dims). Safely returns None on API error."""
    cleaned_query = str(query_text or '').strip()[:8000]
    if not cleaned_query:
        cleaned_query = "legal search"
    if cleaned_query in _embed_cache:
        return _embed_cache[cleaned_query]

    try:
        result = _openai_client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=[cleaned_query],
            dimensions=EMBEDDING_DIMENSIONS
        )
        vec = result.data[0].embedding
        _embed_cache[cleaned_query] = vec
        return vec
    except Exception as e:
        sys.stderr.write(f"[Embedding Warning] OpenAI embedding failed ({e}). Falling back to relational & text search.\n")
        return None


def postgres_text_fallback_search(conn, query_text, limit=5):
    """Fallback text search in PostgreSQL when vector embedding service is unavailable or quota exceeded."""
    results = []
    words = [w for w in re.findall(r'\w+', str(query_text or '')) if len(w) > 3 and w.lower() not in ['what', 'where', 'which', 'every', 'also', 'under', 'with', 'from', 'this', 'that', 'have', 'been', 'were']]
    if not words:
        return results

    cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        first_word = f"%{words[0]}%"
        second_word = f"%{words[1]}%" if len(words) > 1 else first_word
        cur.execute('''
            SELECT "embedding_id", "source_table", "record_id", "parent_id", "chunk_text",
                   "category", "subject", "sections", "doc_title", "law_title", "doc_date"
            FROM "document_embeddings"
            WHERE "chunk_text" ILIKE %s AND "chunk_text" ILIKE %s
            LIMIT %s;
        ''', (first_word, second_word, limit))
        rows = cur.fetchall()
        for r in rows:
            results.append({
                "embedding_id": str(r["embedding_id"]),
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
                "score": 0.80,
                "database_source": "PG_Text_Fallback"
            })
    except Exception as e:
        sys.stderr.write(f"[Postgres Text Fallback Error] {e}\n")
    finally:
        cur.close()
    return results




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
            file_name = meta.get("file_name") or (f"{book_name}.pdf" if not str(book_name).endswith(".pdf") else str(book_name))
            page_no = meta.get("page_number") or meta.get("page_no") or 1
            section_label = meta.get("section_label") or meta.get("source")
            s3_url = f"/api/view-pdf?file={quote(file_name)}&page={page_no}#page={page_no}"


            if not chunk_text.startswith("["):
                header_parts = ["CLA Books", f"Book: {book_name}"]
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
                "source_table": "CLA Books",
                "record_id": str(match.id),
                "parent_id": page_no,
                "chunk_text": enriched_text,
                "category": "Legal Reference Books & Publications",
                "subject": book_name,
                "sections": section_label,
                "doc_title": book_name,
                "law_title": f"{book_name} (Page {page_no})",
                "file_name": file_name,
                "filename": file_name,
                "page_number": page_no,
                "s3_url": s3_url,
                "is_book": True,
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

                            meta_fn = meta.get("file_name") or (f"{doc_title}.pdf" if not str(doc_title).endswith(".pdf") else str(doc_title))
                            meta_pn = meta.get("page_number") or meta.get("page_no") or parent_id or 1
                            s3_url = f"/api/view-pdf?file={quote(meta_fn)}&page={meta_pn}#page={meta_pn}"

                            parent["Title"] = doc_title
                            parent["Sections"] = sec_info
                            parent["Subject"] = meta.get("subject") or doc_title
                            parent["FileName"] = meta_fn
                            parent["s3_url"] = s3_url
                            parent["is_book"] = True

                            child["FileName"] = meta_fn
                            child["Sections"] = sec_info
                            child["chunk_text"] = chunk_txt
                            child["Filetext"] = chunk_txt
                            child["Article_Text"] = chunk_txt
                            child["s3_url"] = s3_url
                            child["is_book"] = True
                            return {"child": child, "parent": parent, "text": chunk_txt, "is_book": True, "s3_url": s3_url}
            except Exception as pc_err:
                sys.stderr.write(f"[Pinecone Citation Detail Error] {pc_err}\n")
            return {"child": child, "parent": parent}

    except Exception as e:
        sys.stderr.write(f"[Source Detail Error] {source_table} ID {record_id}: {e}\n")
    finally:
        cur.close()
    return None


def relational_statute_search(conn, query_text, source_filter=None, limit=5):
    """
    Direct relational lookup in PostgreSQL primary tables for statutory Acts, Case Laws, 
    Commentaries, Notifications, Circulars, Procedures, and Q&A to resolve vector DB coverage gaps.
    """
    results = []
    sec_matches = re.findall(r'\b(?:section|sec\.?|s\.?)\s*(\d+[a-z]?|\d+\(\d+\)(?:\([a-z]\))?)\b', query_text, re.I)
    sections = list(set([s.lower() for s in sec_matches]))
    num_matches = re.findall(r'\b(\d{2,3})\b', query_text)
    for nm in num_matches:
        if nm not in sections and int(nm) <= 500:
            sections.append(nm)

    is_companies_act = bool(re.search(r'\b(?:companies\s*act|ca\s*2013|ca\s*1956|mgt-7|buyback|borrowing|oppression|body\s*corporate|dematerialised|liaison)\b', query_text, re.I))
    is_ibc = bool(re.search(r'\b(?:ibc|insolvency|cirp|moratorium|corporate\s*applicant|guarantor)\b', query_text, re.I))
    is_ni_act = bool(re.search(r'\b(?:negotiable|ni\s*act|138|cheque|bounce|non-executive)\b', query_text, re.I))

    cur = conn.cursor(cursor_factory=RealDictCursor)
    try:
        # Priority 1: Legislation (Acts & Rules)
        if not source_filter or source_filter.lower() in ['legislation', 'all', 'acts']:
            act_title = None
            if is_companies_act:
                act_title = 'Companies Act 2013'
            elif is_ibc:
                act_title = 'Insolvency and Bankruptcy Code, 2016'
            elif is_ni_act:
                act_title = 'Negotiable Instruments Act 1881'

            chapter_map = {
                '2': 'Companies_Act_CHAPTER_1.htm',
                '29': 'Companies_Act_CHAPTER_3.htm',
                '58': 'Companies_Act_CHAPTER_4.htm',
                '68': 'Companies_Act_CHAPTER_4.htm',
                '70': 'Companies_Act_CHAPTER_4.htm',
                '73': 'Companies_Act_CHAPTER_5.htm',
                '92': 'Companies_Act_CHAPTER_7.htm',
                '139': 'Companies_Act_CHAPTER_10.htm',
                '164': 'Companies_Act_CHAPTER_11.htm',
                '167': 'Companies_Act_CHAPTER_11.htm',
                '180': 'Companies_Act_CHAPTER_12.htm',
                '188': 'Companies_Act_CHAPTER_12.htm',
                '241': 'Companies_Act_CHAPTER_16.htm',
                '242': 'Companies_Act_CHAPTER_16.htm',
                '244': 'Companies_Act_CHAPTER_16.htm',
                '380': 'Companies_Act_CHAPTER_22.htm'
            }

            for sec in sections:
                target_file = chapter_map.get(sec)
                if target_file and act_title == 'Companies Act 2013':
                    cur.execute('''
                        SELECT l."id", l."Title", l."Headings", ld."Filetext", ld."FileName"
                        FROM "Legislation_2025" l
                        JOIN "Legislation_data_2025" ld ON l."Filename" = ld."FileName"
                        WHERE l."Title" = %s AND ld."FileName" = %s
                        LIMIT 1;
                    ''', (act_title, target_file))
                    row = cur.fetchone()
                    if row:
                        txt = row["Filetext"] or ""
                        pos = txt.find(f"{sec}.")
                        if pos == -1:
                            pos = txt.find(f"Section {sec}")
                        snippet = txt[max(0, pos-100):pos+1500] if pos != -1 else txt[:1500]
                        results.append({
                            "embedding_id": f"rel-leg-{row['id']}-{sec}",
                            "source_table": "Legislation",
                            "record_id": row["id"],
                            "parent_id": row["id"],
                            "chunk_text": f"Act: {act_title} | Section {sec} | Heading: {row['Headings']}\nText:\n{snippet}",
                            "category": "Statute / Primary Legislation",
                            "subject": act_title,
                            "sections": f"Section {sec}",
                            "doc_title": f"{act_title} - Section {sec}",
                            "law_title": act_title,
                            "doc_date": "2013-08-29",
                            "score": 0.99,
                            "legal_priority_rank": 1,
                            "database_source": "PG_Relational_Legislation"
                        })
                elif act_title:
                    cur.execute('''
                        SELECT l."id", l."Title", l."Headings", ld."Filetext", ld."FileName"
                        FROM "Legislation_2025" l
                        LEFT JOIN "Legislation_data_2025" ld ON l."id" = ld."Legislation_ID" OR l."Filename" = ld."FileName"
                        WHERE l."Title" ILIKE %s AND (l."Headings" ILIKE %s OR ld."Filetext" ILIKE %s)
                        LIMIT 2;
                    ''', (f'%{act_title}%', f'%{sec}%', f'%{sec}%'))
                    for row in cur.fetchall():
                        txt = row["Filetext"] or ""
                        results.append({
                            "embedding_id": f"rel-leg-{row['id']}-{sec}",
                            "source_table": "Legislation",
                            "record_id": row["id"],
                            "parent_id": row["id"],
                            "chunk_text": f"Act: {row['Title']} | Heading: {row['Headings']}\nText:\n{txt[:1200]}",
                            "category": "Statute / Primary Legislation",
                            "subject": row['Title'],
                            "sections": f"Section {sec}",
                            "doc_title": f"{row['Title']} - {row['Headings']}",
                            "law_title": row['Title'],
                            "doc_date": None,
                            "score": 0.98,
                            "legal_priority_rank": 1,
                            "database_source": "PG_Relational_Legislation"
                        })

        # Priority 2: CLASE Commentary
        if not source_filter or source_filter.lower() in ['commentary', 'clase_commentary', 'all']:
            for sec in sections:
                cur.execute('''
                    SELECT "ID", "Title", "Section", "Commentary_Details"
                    FROM "CLASE_Commentary"
                    WHERE "Section" ILIKE %s OR "Title" ILIKE %s
                    LIMIT 2;
                ''', (f'%{sec}%', f'%{sec}%'))
                for r in cur.fetchall():
                    results.append({
                        "embedding_id": f"rel-comm-{r['ID']}",
                        "source_table": "CLASE_Commentary",
                        "record_id": r['ID'],
                        "parent_id": r['ID'],
                        "chunk_text": f"Commentary Title: {r['Title']} | Section: {r['Section']}\nDetails:\n{r['Commentary_Details'][:1000]}",
                        "category": "Section Commentary",
                        "subject": r['Title'],
                        "sections": r['Section'],
                        "doc_title": r['Title'],
                        "law_title": r['Title'],
                        "doc_date": None,
                        "score": 0.95,
                        "legal_priority_rank": 2,
                        "database_source": "PG_Relational_Commentary"
                    })

        # Priority 3: CaseLaws
        if not source_filter or source_filter.lower() in ['caselaw', 'caselaws', 'all']:
            for sec in sections:
                cur.execute('''
                    SELECT "id", "Versus", "Sections", "Citation", "HeadNote"
                    FROM "caselaws_2025"
                    WHERE "Sections" ILIKE %s OR "HeadNote" ILIKE %s
                    LIMIT 2;
                ''', (f'%{sec}%', f'%section {sec}%'))
                for r in cur.fetchall():
                    results.append({
                        "embedding_id": f"rel-case-{r['id']}",
                        "source_table": "CaseLaws",
                        "record_id": r['id'],
                        "parent_id": r['id'],
                        "chunk_text": f"Case: {r['Versus']} | Citation: {r['Citation'] or 'N/A'} | Sections: {r['Sections']}\nHeadNote:\n{r['HeadNote'][:1000]}",
                        "category": "Judicial Precedent",
                        "subject": r['Versus'],
                        "sections": r['Sections'],
                        "doc_title": r['Versus'],
                        "law_title": r['Versus'],
                        "doc_date": None,
                        "score": 0.92,
                        "legal_priority_rank": 3,
                        "database_source": "PG_Relational_CaseLaws"
                    })

        # Priority 4: Notifications & Circulars
        if not source_filter or source_filter.lower() in ['notifications', 'circular', 'all']:
            for sec in sections:
                cur.execute('''
                    SELECT n."Id", n."Title", n."NotificationNo", nd."Filetext"
                    FROM "notifications_2025" n
                    LEFT JOIN "notifications_data_2025" nd ON n."Id" = nd."Notification_ID"
                    WHERE n."Sections" ILIKE %s OR n."Title" ILIKE %s
                    LIMIT 2;
                ''', (f'%{sec}%', f'%{sec}%'))
                for r in cur.fetchall():
                    txt = r["Filetext"] or ""
                    results.append({
                        "embedding_id": f"rel-notif-{r['Id']}",
                        "source_table": "Notifications",
                        "record_id": r['Id'],
                        "parent_id": r['Id'],
                        "chunk_text": f"Notification: {r['Title']} | No: {r['NotificationNo'] or 'N/A'}\nText:\n{txt[:1000]}",
                        "category": "Government Notification",
                        "subject": r['Title'],
                        "sections": f"Section {sec}",
                        "doc_title": r['Title'],
                        "law_title": r['Title'],
                        "doc_date": None,
                        "score": 0.88,
                        "legal_priority_rank": 4,
                        "database_source": "PG_Relational_Notifications"
                    })

        # Priority 5: Procedures & Q&A
        if not source_filter or source_filter.lower() in ['procedure', 'query', 'all']:
            for sec in sections:
                cur.execute('''
                    SELECT "ID", "Title", "Heading", "Procedure", "LawTitle"
                    FROM "CLASE_Procedure_Details_2025"
                    WHERE "Heading" ILIKE %s OR "Title" ILIKE %s OR "Procedure" ILIKE %s
                    LIMIT 2;
                ''', (f'%{sec}%', f'%{sec}%', f'%{sec}%'))
                for r in cur.fetchall():
                    results.append({
                        "embedding_id": f"rel-proc-{r['ID']}",
                        "source_table": "CLASE_Procedure_Details",
                        "record_id": r['ID'],
                        "parent_id": r['ID'],
                        "chunk_text": f"Procedure Title: {r['Title']} | Heading: {r['Heading']}\nSteps:\n{str(r['Procedure'])[:1000]}",
                        "category": "Legal Procedure & Compliance",
                        "subject": r['Title'],
                        "sections": f"Section {sec}",
                        "doc_title": r['Title'],
                        "law_title": r['LawTitle'] or r['Title'],
                        "doc_date": None,
                        "score": 0.85,
                        "legal_priority_rank": 5,
                        "database_source": "PG_Relational_Procedure"
                    })

    except Exception as e:
        sys.stderr.write(f"[Relational Search Error] {e}\n")
    finally:
        cur.close()

    return results


def dual_retrieval(conn, query_text, top_k_pgvector=8, top_k_pinecone=10, source_filter=None, fetch_full_sources=True):
    """
    Retrieve candidate chunks from BOTH PGVector / PostgreSQL (Structured Legal Tables) AND Pinecone (Unstructured PDFs).
    Enforces a strict 5-Tier Legal Table Prioritization while ensuring Pinecone PDF candidates are mandatory candidates when matched.
    The Cohere Re-ranker makes the final decision on relevance.
    """
    import re

    # Extract sub-queries for multi-part / multi-question prompts
    raw_sub_queries = re.split(r'(?:\?|\n+|(?:^|\s+)\d+[\.\)]\s*)', str(query_text or ''))
    clean_sub_queries = [q.strip() for q in raw_sub_queries if q and len(q.strip()) > 8]
    
    # Deduplicated list of search queries: full query + sub-queries (up to 4 sub-queries)
    search_queries = list(dict.fromkeys([query_text] + clean_sub_queries[:4]))

    all_relational_chunks = []
    all_pg_chunks = []
    all_pc_chunks = []

    sf = str(source_filter or "").lower()
    should_search_pinecone = not sf or sf.startswith("!") or any(k in sf for k in ["pinecone", "book", "cla", "commentary", "all", "procedure", "article", "query"])

    for sub_q in search_queries:
        if not sub_q or not sub_q.strip():
            continue
            
        q_vec = embed_query(sub_q)

        # 1. Relational statutory search for exact section/Act lookup across prioritized tables
        try:
            rel_hits = relational_statute_search(conn, sub_q, source_filter=source_filter, limit=5)
            all_relational_chunks.extend(rel_hits)
        except Exception as e:
            sys.stderr.write(f"[Relational Search Sub-query Error] {e}\n")

        # 2. Retrieve PGVector chunks (structured data)
        if q_vec is not None:
            try:
                pg_hits = vector_search(conn, sub_q, top_k=top_k_pgvector, source_filter=source_filter, query_vec=q_vec)
                all_pg_chunks.extend(pg_hits)
            except Exception as e:
                sys.stderr.write(f"[PGVector Search Sub-query Error] {e}\n")
        else:
            try:
                text_hits = postgres_text_fallback_search(conn, sub_q, limit=6)
                all_pg_chunks.extend(text_hits)
            except Exception as e:
                sys.stderr.write(f"[Postgres Text Fallback Sub-query Error] {e}\n")

        # 3. Retrieve Pinecone chunks (unstructured PDFs/books)
        if should_search_pinecone and q_vec is not None:
            try:
                pc_hits = pinecone_search(sub_q, top_k=top_k_pinecone, query_vec=q_vec)
                all_pc_chunks.extend(pc_hits)
            except Exception as e:
                sys.stderr.write(f"[Pinecone Search Sub-query Error] {e}\n")

    # Attach full source details for PGVector hits
    if fetch_full_sources and all_pg_chunks:
        for hit in all_pg_chunks:
            if "full_source" not in hit:
                full_data = fetch_source_details(conn, hit["source_table"], hit["record_id"], hit["parent_id"])
                hit["full_source"] = full_data

    # Combine all retrieval channels
    combined_results = all_relational_chunks + all_pg_chunks + all_pc_chunks

    # Deduplicate by title & excerpt prefix
    seen = set()
    unique_results = []
    for doc in combined_results:
        key = (doc.get("doc_title") or "") + "::" + (doc.get("chunk_text") or "")[:100]
        if key not in seen:
            seen.add(key)
            unique_results.append(doc)

    # Categorize into Priority Buckets:
    # Tier 1: Legislation
    tier1_legislation = [d for d in unique_results if "legis" in str(d.get("source_table")).lower() or "statute" in str(d.get("category")).lower()]
    # Tier 2: CLASE Commentary
    tier2_commentary = [d for d in unique_results if "comm" in str(d.get("source_table")).lower() or "commentary" in str(d.get("category")).lower()]
    # Tier 3: Case Laws
    tier3_caselaws = [d for d in unique_results if "case" in str(d.get("source_table")).lower() or "precedent" in str(d.get("category")).lower()]
    # Tier 4: Notifications & Circulars
    tier4_regulatory = [d for d in unique_results if any(k in str(d.get("source_table")).lower() for k in ["notif", "circ"])]
    # Tier 5: Procedures, Queries & Articles
    tier5_procedures_articles = [d for d in unique_results if any(k in str(d.get("source_table")).lower() for k in ["proc", "query", "art"])]
    # Pinecone PDFs & Unstructured Books
    pinecone_books = [d for d in unique_results if d.get("is_book") or "book" in str(d.get("source_table")).lower() or "pinecone" in str(d.get("database_source")).lower()]
    # Unmatched / catch-all
    others = [d for d in unique_results if d not in tier1_legislation and d not in tier2_commentary and d not in tier3_caselaws and d not in tier4_regulatory and d not in tier5_procedures_articles and d not in pinecone_books]

    # Assemble multi-tier candidate pool (Up to 30 candidates for Cohere Reranker)
    balanced_pool = (
        tier1_legislation[:8] +
        tier2_commentary[:6] +
        tier3_caselaws[:6] +
        tier4_regulatory[:4] +
        tier5_procedures_articles[:4] +
        pinecone_books[:8] +
        others[:4]
    )

    # Fill up to 30 if pool has room
    if len(balanced_pool) < 30:
        remaining = [d for d in unique_results if d not in balanced_pool]
        balanced_pool.extend(remaining[:30 - len(balanced_pool)])

    return balanced_pool[:30]




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
