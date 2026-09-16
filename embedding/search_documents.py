"""
search_documents.py

Unified Pure Dual-Pinecone Vector Retrieval Engine:
1. Pinecone DB Index ('cla-online-db') - Structured Legal Data (Articles, CaseLaws, Circulars, Legislation, Notifications, Query, CLASE Commentary, CLASE Procedures) [171,500+ vectors]
2. Pinecone Books Index ('cla-online') - Unstructured Legal Documents (CLA Books & Publications PDFs) [17,500+ vectors]

Zero SQL/PostgreSQL/ODBC Dependencies.
All chunks, metadata, and citation details are served directly via Pinecone vector databases.
Embedding Model: text-embedding-3-small (1536 dimensions)
"""

import os
import re
import json
import sys
from urllib.parse import quote
from dotenv import load_dotenv
from openai import OpenAI
from pinecone import Pinecone

# Load environment variables
_root_env = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
if os.path.exists(_root_env):
    load_dotenv(_root_env)
else:
    load_dotenv()

# ---------- ENVIRONMENT & PINECONE CONFIGURATION ----------

PINECONE_API_KEY = os.getenv("PINECONE_API_KEY", "")
PINECONE_DB_INDEX_NAME = os.getenv("PINECONE_DB_INDEX_NAME", "cla-online-db")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "cla-online")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "1536"))

_openai_client = None
_pc_client = None
_pinecone_db_index = None
_pinecone_books_index = None
_embed_cache = {}


def get_openai_client():
    global _openai_client
    if _openai_client is None:
        api_key = os.getenv("OPENAI_API_KEY")
        if not api_key:
            raise ValueError("OPENAI_API_KEY environment variable is not set.")
        _openai_client = OpenAI(api_key=api_key)
    return _openai_client


def get_pc_client():
    global _pc_client
    if _pc_client is None:
        if not PINECONE_API_KEY:
            raise ValueError("PINECONE_API_KEY environment variable is not set.")
        _pc_client = Pinecone(api_key=PINECONE_API_KEY)
    return _pc_client


def get_pinecone_db_index():
    """Returns the Pinecone index for structured legal tables (cla-online-db)."""
    global _pinecone_db_index
    if _pinecone_db_index is None:
        try:
            pc = get_pc_client()
            _pinecone_db_index = pc.Index(PINECONE_DB_INDEX_NAME)
        except Exception as e:
            sys.stderr.write(f"[Pinecone Error] Failed to connect to DB index '{PINECONE_DB_INDEX_NAME}': {e}\n")
            _pinecone_db_index = None
    return _pinecone_db_index


def get_pinecone_books_index():
    """Returns the Pinecone index for unstructured CLA books/PDFs (cla-online)."""
    global _pinecone_books_index
    if _pinecone_books_index is None:
        try:
            pc = get_pc_client()
            _pinecone_books_index = pc.Index(PINECONE_INDEX_NAME)
        except Exception as e:
            sys.stderr.write(f"[Pinecone Error] Failed to connect to Books index '{PINECONE_INDEX_NAME}': {e}\n")
            _pinecone_books_index = None
    return _pinecone_books_index


# ---------- EMBEDDING UTILITY ----------

def embed_query(query_text):
    """Generate query embedding using text-embedding-3-small (1536 dims). Safely returns None on error."""
    cleaned_query = str(query_text or '').strip()[:8000]
    if not cleaned_query:
        cleaned_query = "legal search"
    if cleaned_query in _embed_cache:
        return _embed_cache[cleaned_query]

    try:
        client = get_openai_client()
        result = client.embeddings.create(
            model=EMBEDDING_MODEL,
            input=[cleaned_query],
            dimensions=EMBEDDING_DIMENSIONS
        )
        vec = result.data[0].embedding
        _embed_cache[cleaned_query] = vec
        return vec
    except Exception as e:
        sys.stderr.write(f"[Embedding Error] OpenAI embedding failed ({e})\n")
        return None


# ---------- PINECONE STRUCTURED DB SEARCH ----------

def search_pinecone_db(query_vec, top_k=15, source_filter=None):
    """
    Retrieve top-K chunks from Pinecone structured DB index ('cla-online-db').
    Contains all 8 tables: Articles, CaseLaws, Circular, Legislation, Notifications, Query, CLASE_Commentary, CLASE_Procedure_Details.
    """
    index = get_pinecone_db_index()
    if index is None or query_vec is None:
        return []

    query_params = {
        "vector": query_vec,
        "top_k": top_k,
        "include_metadata": True,
    }

    if source_filter and isinstance(source_filter, str):
        if source_filter.startswith("!"):
            ex_table = source_filter[1:]
            query_params["filter"] = {"source_table": {"$ne": ex_table}}
        elif source_filter.lower() not in ["all", ""]:
            query_params["filter"] = {"source_table": {"$eq": source_filter}}

    try:
        res = index.query(**query_params)
        results = []
        for match in res.matches:
            meta = match.metadata or {}
            source_table = meta.get("source_table") or "Unknown"
            record_id = meta.get("record_id")
            parent_id = meta.get("parent_id")
            chunk_text = meta.get("chunk_text") or meta.get("text") or meta.get("raw_text") or ""
            doc_title = meta.get("doc_title") or meta.get("law_title") or meta.get("subject") or f"{source_table} #{record_id}"
            law_title = meta.get("law_title") or doc_title
            category = meta.get("category") or source_table
            subject = meta.get("subject") or doc_title
            sections = meta.get("sections")
            file_name = meta.get("file_name") or f"{record_id}.html"
            doc_date = meta.get("doc_date")

            parent_obj = {
                "Title": doc_title,
                "Category": category,
                "Subject": subject,
                "Sections": sections or "General",
                "FileName": file_name,
                "DocDate": doc_date,
            }
            child_obj = {
                "FileName": file_name,
                "Sections": sections or "General",
                "Category": category,
                "Article_Text": chunk_text,
                "Filetext": chunk_text,
                "chunk_text": chunk_text,
            }

            results.append({
                "embedding_id": str(match.id),
                "source_table": source_table,
                "record_id": record_id if record_id is not None else str(match.id),
                "parent_id": parent_id if parent_id is not None else record_id,
                "chunk_text": chunk_text,
                "category": category,
                "subject": subject,
                "sections": sections,
                "doc_title": doc_title,
                "law_title": law_title,
                "file_name": file_name,
                "filename": file_name,
                "doc_date": doc_date,
                "score": float(match.score),
                "database_source": "Pinecone_DB",
                "is_book": False,
                "original": {
                    "child": child_obj,
                    "parent": parent_obj,
                }
            })
        return results
    except Exception as e:
        sys.stderr.write(f"[Pinecone DB Search Error] {e}\n")
        return []


# ---------- PINECONE UNSTRUCTURED BOOKS SEARCH ----------

def search_pinecone_books(query_vec, top_k=8):
    """
    Retrieve top-K chunks from Pinecone unstructured books index ('cla-online').
    Contains CLA Publications & Reference Books with page-level PDF coordinates.
    """
    index = get_pinecone_books_index()
    if index is None or query_vec is None:
        return []

    try:
        res = index.query(
            vector=query_vec,
            top_k=top_k,
            include_metadata=True
        )

        results = []
        for match in res.matches:
            meta = match.metadata or {}
            chunk_text = meta.get("text") or meta.get("raw_text") or meta.get("chunk_text") or ""
            book_name = meta.get("book_name") or meta.get("file_name") or "CLA Reference Book"
            file_name = meta.get("file_name") or (f"{book_name}.pdf" if not str(book_name).endswith(".pdf") else str(book_name))
            page_no = meta.get("page_number") or meta.get("page_no") or 1
            section_label = meta.get("section_label") or meta.get("source") or f"Page {page_no}"
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

            parent_obj = {
                "Title": book_name,
                "Category": "Book / PDF (Pinecone)",
                "FileName": file_name,
                "Author": "Corporate Law Adviser",
                "Sections": section_label,
            }
            child_obj = {
                "FileName": file_name,
                "Sections": section_label,
                "Category": "Book / PDF (Pinecone)",
                "Article_Text": chunk_text,
                "Filetext": chunk_text,
                "chunk_text": chunk_text,
                "page_number": page_no,
                "s3_url": s3_url,
            }

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
                "database_source": "Pinecone_Books",
                "original": {
                    "child": child_obj,
                    "parent": parent_obj,
                }
            })
        return results
    except Exception as e:
        sys.stderr.write(f"[Pinecone Books Search Error] {e}\n")
        return []


# ---------- DUAL RETRIEVAL & PRIORITY BUCKETING ----------

def dual_retrieval(query_text, top_k_db=15, top_k_books=8, source_filter=None, inferred_sections=None, primary_act=None):
    """
    Simultaneously retrieves from both 'cla-online-db' (structured tables) and 'cla-online' (books).
    Applies multi-query expansion and strict legal prioritization before passing candidates to the reranker.
    """
    raw_sub_queries = re.split(r'(?:\?|\n+|(?:^|\s+)\d+[\.\)]\s*)', str(query_text or ''))
    clean_sub_queries = [q.strip() for q in raw_sub_queries if q and len(q.strip()) > 8]
    search_queries = list(dict.fromkeys([query_text] + clean_sub_queries[:3]))

    all_db_chunks = []
    all_books_chunks = []

    for sub_q in search_queries:
        if not sub_q or not sub_q.strip():
            continue

        q_vec = embed_query(sub_q)
        if q_vec is None:
            continue

        # 1. Search Structured Legal DB (cla-online-db)
        db_hits = search_pinecone_db(q_vec, top_k=top_k_db, source_filter=source_filter)
        all_db_chunks.extend(db_hits)

        # 2. Search Books & Publications (cla-online)
        sf = str(source_filter or "").lower()
        should_search_books = not sf or sf.startswith("!") or any(k in sf for k in ["pinecone", "book", "cla", "all"])
        if should_search_books:
            books_hits = search_pinecone_books(q_vec, top_k=top_k_books)
            all_books_chunks.extend(books_hits)

    # Deduplicate chunks by embedding_id or text fingerprint
    seen_ids = set()
    unique_results = []
    for chunk in all_db_chunks + all_books_chunks:
        cid = chunk.get("embedding_id") or chunk.get("chunk_text")[:80]
        if cid not in seen_ids:
            seen_ids.add(cid)
            unique_results.append(chunk)

    if not unique_results:
        return []

    # Sort results by raw score descending
    unique_results.sort(key=lambda x: x.get("score", 0.0), reverse=True)

    # Categorize into Strict 6-Tier Priority Buckets:
    # Tier 1: Law (Legislation / Statutes)
    tier1_law = [d for d in unique_results if "legis" in str(d.get("source_table", "")).lower() or "statute" in str(d.get("category", "")).lower()]
    # Tier 2: CaseLaw (Judicial Precedents)
    tier2_caselaw = [d for d in unique_results if "case" in str(d.get("source_table", "")).lower() or "precedent" in str(d.get("category", "")).lower()]
    # Tier 3: Article (Legal Analysis & Articles)
    tier3_article = [d for d in unique_results if "art" in str(d.get("source_table", "")).lower() or "article" in str(d.get("category", "")).lower()]
    # Tier 4: Commentary (Section Commentaries)
    tier4_commentary = [d for d in unique_results if "comm" in str(d.get("source_table", "")).lower() or "commentary" in str(d.get("category", "")).lower()]
    # Tier 5: Notification & Circular (Regulatory Notifications & Circulars)
    tier5_notification = [d for d in unique_results if any(k in str(d.get("source_table", "")).lower() for k in ["notif", "circ"])]
    # Tier 6: Procedures, Queries & CLA Books (PDFs)
    tier6_etc = [d for d in unique_results if d not in tier1_law and d not in tier2_caselaw and d not in tier3_article and d not in tier4_commentary and d not in tier5_notification]

    # Assemble balanced multi-tier candidate pool prioritizing statutory law, case precedents, and books
    balanced_pool = (
        tier1_law[:8] +
        tier2_caselaw[:6] +
        tier3_article[:5] +
        tier4_commentary[:4] +
        tier5_notification[:4] +
        tier6_etc[:6]
    )

    # Fill up to 30 candidates if room allows
    if len(balanced_pool) < 30:
        remaining = [d for d in unique_results if d not in balanced_pool]
        balanced_pool.extend(remaining[:30 - len(balanced_pool)])

    return balanced_pool[:30]


# ---------- CITATION & SOURCE DETAILS RESOLUTION ----------

def fetch_source_details(source_table, record_id, parent_id=None):
    """
    Retrieve full citation text, parent, and child metadata directly from Pinecone.
    Zero SQL dependency.
    """
    st_lower = str(source_table or "").lower()
    is_book = "book" in st_lower or "pinecone" in st_lower or (source_table == "CLA Books")

    # 1. CLA Books / PDF Citations (from 'cla-online')
    if is_book:
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

        books_idx = get_pinecone_books_index()
        if books_idx and record_id:
            try:
                ids_to_try = [str(record_id)]
                if parent_id:
                    ids_to_try.append(str(parent_id))
                fetch_res = books_idx.fetch(ids=ids_to_try)
                vectors_map = getattr(fetch_res, "vectors", {}) if hasattr(fetch_res, "vectors") else (fetch_res.get("vectors") if isinstance(fetch_res, dict) else {})
                for vid in ids_to_try:
                    if vectors_map and vid in vectors_map:
                        vec = vectors_map[vid]
                        meta = getattr(vec, "metadata", {}) if hasattr(vec, "metadata") else (vec.get("metadata", {}) if isinstance(vec, dict) else {})
                        chunk_txt = meta.get("chunk_text") or meta.get("text") or meta.get("raw_text") or ""
                        doc_title = meta.get("book_name") or meta.get("doc_title") or meta.get("subject") or "CLA Books & Unstructured Documents"
                        sec_info = meta.get("section_label") or meta.get("sections") or f"Page {meta.get('page_number') or parent_id or 1}"
                        meta_fn = meta.get("file_name") or (f"{doc_title}.pdf" if not str(doc_title).endswith(".pdf") else str(doc_title))
                        meta_pn = meta.get("page_number") or meta.get("page_no") or parent_id or 1
                        s3_url = f"/api/view-pdf?file={quote(meta_fn)}&page={meta_pn}#page={meta_pn}"

                        parent["Title"] = doc_title
                        parent["Sections"] = sec_info
                        parent["Subject"] = doc_title
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
            except Exception as e:
                sys.stderr.write(f"[Pinecone Books Citation Lookup Error] {e}\n")

        return {"child": child, "parent": parent}

    # 2. Structured Table Citations (from 'cla-online-db')
    db_idx = get_pinecone_db_index()
    if db_idx and record_id:
        try:
            ids_to_try = [
                str(record_id),
                f"{source_table}|{record_id}|0",
                f"{source_table}|{record_id}|1",
                f"{source_table}|{record_id}|2",
                f"{source_table}_{record_id}",
            ]
            fetch_res = db_idx.fetch(ids=ids_to_try)
            vectors_map = getattr(fetch_res, "vectors", {}) if hasattr(fetch_res, "vectors") else (fetch_res.get("vectors") if isinstance(fetch_res, dict) else {})

            matched_meta = None
            for vid in ids_to_try:
                if vectors_map and vid in vectors_map:
                    vec = vectors_map[vid]
                    matched_meta = getattr(vec, "metadata", {}) if hasattr(vec, "metadata") else (vec.get("metadata", {}) if isinstance(vec, dict) else {})
                    if matched_meta:
                        break

            # If not matched by direct ID, search with metadata filter
            if not matched_meta:
                try:
                    num_id = int(record_id) if str(record_id).isdigit() else record_id
                    filter_dict = {"source_table": {"$eq": source_table}, "record_id": {"$eq": num_id}}
                    q_res = db_idx.query(vector=[0.0] * 1536, top_k=3, filter=filter_dict, include_metadata=True)
                    if q_res and q_res.matches:
                        matched_meta = q_res.matches[0].metadata or {}
                except Exception as filter_err:
                    sys.stderr.write(f"[Pinecone DB Filter Query Note] {filter_err}\n")

            if matched_meta:
                doc_title = matched_meta.get("doc_title") or matched_meta.get("law_title") or f"{source_table} #{record_id}"
                category = matched_meta.get("category") or source_table
                subject = matched_meta.get("subject") or doc_title
                sections = matched_meta.get("sections") or "General"
                file_name = matched_meta.get("file_name") or f"{record_id}.html"
                chunk_txt = matched_meta.get("chunk_text") or ""
                doc_date = matched_meta.get("doc_date")

                parent = {
                    "Title": doc_title,
                    "Category": category,
                    "Subject": subject,
                    "Sections": sections,
                    "FileName": file_name,
                    "DocDate": doc_date,
                    "law_title": matched_meta.get("law_title") or doc_title,
                }
                child = {
                    "FileName": file_name,
                    "Sections": sections,
                    "Category": category,
                    "Article_Text": chunk_txt,
                    "Filetext": chunk_txt,
                    "chunk_text": chunk_txt,
                }
                return {"child": child, "parent": parent, "text": chunk_txt}
        except Exception as e:
            sys.stderr.write(f"[Pinecone DB Citation Lookup Error] {e}\n")

    # Fallback placeholder if vector not found by exact ID
    fallback_parent = {
        "Title": f"{source_table} Record #{record_id}",
        "Category": source_table,
        "Subject": source_table,
        "Sections": "General",
        "FileName": f"{record_id}.html",
    }
    fallback_child = {
        "FileName": f"{record_id}.html",
        "Sections": "General",
        "Category": source_table,
        "Article_Text": f"Cited record from {source_table} (ID: {record_id}).",
        "Filetext": f"Cited record from {source_table} (ID: {record_id}).",
        "chunk_text": f"Cited record from {source_table} (ID: {record_id}).",
    }
    return {"child": fallback_child, "parent": fallback_parent, "text": fallback_child["chunk_text"]}


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

    if action == "get_citation":
        source_table = payload.get("source_table")
        record_id = payload.get("record_id")
        parent_id = payload.get("parent_id")
        details = fetch_source_details(source_table, record_id, parent_id)
        print(json.dumps({"results": details}, default=str))
    else:
        query = payload.get("query", "")
        top_k = payload.get("top_k", 10)
        source_filter = payload.get("source_filter")
        inferred_sections = payload.get("inferred_sections", [])
        primary_act = payload.get("primary_act", None)

        results = dual_retrieval(
            query_text=query,
            top_k_db=top_k,
            top_k_books=8,
            source_filter=source_filter,
            inferred_sections=inferred_sections,
            primary_act=primary_act
        )
        print(json.dumps({"results": results}, default=str))


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
        query = "Whether promoters of a corporate debtor are eligible to file an application for initiation of CIRP under IBC 2016"

    print(f"Executing search for query: {query}", file=sys.stderr)
    results = dual_retrieval(query)
    print(json.dumps(results, indent=2, default=str))


if __name__ == "__main__":
    main()
