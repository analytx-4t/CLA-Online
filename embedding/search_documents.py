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
        # Imported here: the import takes about two seconds and source lookups never embed.
        from openai import OpenAI
        _openai_client = OpenAI(api_key=api_key)
    return _openai_client


def get_pc_client():
    global _pc_client
    if _pc_client is None:
        if not PINECONE_API_KEY:
            raise ValueError("PINECONE_API_KEY environment variable is not set.")
        _pc_client = Pinecone(api_key=PINECONE_API_KEY)
    return _pc_client


# This script runs once per request, and opening an index by name costs a control-plane
# round trip (2-3 seconds) to look up its host. The host never changes for the life of an
# index, so it is remembered on disk and the index is opened by host from then on.
_INDEX_HOSTS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".index_hosts.json")


def _read_index_hosts():
    try:
        with open(_INDEX_HOSTS_PATH, encoding="utf-8") as f:
            hosts = json.load(f)
        return hosts if isinstance(hosts, dict) else {}
    except Exception:
        return {}


def _write_index_hosts(hosts):
    try:
        tmp_path = f"{_INDEX_HOSTS_PATH}.{os.getpid()}.tmp"
        with open(tmp_path, "w", encoding="utf-8") as f:
            json.dump(hosts, f)
        os.replace(tmp_path, _INDEX_HOSTS_PATH)
    except Exception:
        pass  # the cache is only a speed-up


def forget_index_hosts():
    """Called after a failed Pinecone request so the next run looks the hosts up afresh."""
    try:
        os.remove(_INDEX_HOSTS_PATH)
    except OSError:
        pass


def _open_index(name):
    pc = get_pc_client()
    hosts = _read_index_hosts()
    host = hosts.get(name)
    if not host:
        host = pc.describe_index(name).host
        hosts[name] = host
        _write_index_hosts(hosts)
    return pc.Index(host=host)


def get_pinecone_db_index():
    """Returns the Pinecone index for structured legal tables (cla-online-db)."""
    global _pinecone_db_index
    if _pinecone_db_index is None:
        try:
            _pinecone_db_index = _open_index(PINECONE_DB_INDEX_NAME)
        except Exception as e:
            sys.stderr.write(f"[Pinecone Error] Failed to connect to DB index '{PINECONE_DB_INDEX_NAME}': {e}\n")
            _pinecone_db_index = None
    return _pinecone_db_index


def get_pinecone_books_index():
    """Returns the Pinecone index for unstructured CLA books/PDFs (cla-online)."""
    global _pinecone_books_index
    if _pinecone_books_index is None:
        try:
            _pinecone_books_index = _open_index(PINECONE_INDEX_NAME)
        except Exception as e:
            sys.stderr.write(f"[Pinecone Error] Failed to connect to Books index '{PINECONE_INDEX_NAME}': {e}\n")
            _pinecone_books_index = None
    return _pinecone_books_index


# ---------- CHUNK HEADERS, TITLES & LEGISLATION LABELS ----------

_LEGISLATION_LABELS = None
_LABELS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "legislation_labels.json")


def get_legislation_labels():
    """file name (lower case) -> {"title", "type"} for every legislation file.

    Many legislation vectors were indexed with another Act's title (the bulk load joined the
    file text to the wrong row). The stored file name is right, so the title is corrected from
    this map whenever a legislation chunk is read. Built by build_legislation_labels.py."""
    global _LEGISLATION_LABELS
    if _LEGISLATION_LABELS is None:
        try:
            with open(_LABELS_PATH, encoding="utf-8") as f:
                _LEGISLATION_LABELS = json.load(f)
        except Exception as e:
            sys.stderr.write(f"[Legislation Labels] {_LABELS_PATH} not loaded ({e}); titles are used as indexed.\n")
            _LEGISLATION_LABELS = {}
    return _LEGISLATION_LABELS


def split_chunk_header(text):
    """Indexed chunks start with a one-off context header, "[Source | Key: value | ...]\n".
    Returns (fields, body). The header can itself contain "]" (case citations) and line
    breaks (chapter headings), so it ends at the first "]" that closes a line."""
    text = str(text or "")
    if not text.startswith("["):
        return {}, text
    end = text.find("]\n")
    if end == -1:
        if not text.rstrip().endswith("]"):
            return {}, text
        end = len(text.rstrip()) - 1
    fields = {}
    for part in text[1:end].split(" | "):
        key, sep, value = part.partition(": ")
        if sep and key.strip() and key.strip() not in fields:
            fields[key.strip()] = " ".join(value.split())
    return fields, text[end + 1:].lstrip("\r\n")


def clean_title(source_table, title):
    """Collapse whitespace and repair case names stored without spaces ("A Ltd.v.B Ltd.")."""
    title = " ".join(str(title or "").split())
    if title and "case" in str(source_table or "").lower():
        if not re.search(r"\s(?:v|vs|versus)\.?\s", title, re.IGNORECASE):
            title = re.sub(r"(?<=[A-Za-z.)])\s*(v\.|V\.)\s*(?=[A-Z(])", r" \1 ", title, count=1)
        title = " ".join(title.split())
    return title


def describe_db_chunk(vector_id, meta):
    """One structured-index vector -> the fields the backend needs, with the legislation title
    corrected and the context header separated from the passage text."""
    meta = meta or {}
    source_table = meta.get("source_table") or "Unknown"
    record_id = meta.get("record_id")
    if isinstance(record_id, float) and record_id.is_integer():
        record_id = int(record_id)
    parent_id = meta.get("parent_id")
    if isinstance(parent_id, float) and parent_id.is_integer():
        parent_id = int(parent_id)
    chunk_index = meta.get("chunk_index")
    if isinstance(chunk_index, float):
        chunk_index = int(chunk_index)

    stored_text = meta.get("chunk_text") or meta.get("text") or meta.get("raw_text") or ""
    header, body = split_chunk_header(stored_text)
    file_name = meta.get("file_name") or header.get("File") or None

    doc_title = meta.get("doc_title") or header.get("Title") or header.get("Versus")
    law_title = meta.get("law_title")
    instrument_type = None
    chunk_text = stored_text

    if source_table == "Legislation":
        label = get_legislation_labels().get(str(file_name or "").strip().lower())
        if label:
            doc_title = label["title"]
            law_title = label["title"]
            instrument_type = label.get("type")
            # Rebuild the header: the indexed one names the wrong Act and chapter.
            parts = ["Legislation", f"Title: {doc_title}"]
            if file_name:
                parts.append(f"File: {file_name}")
            if header.get("Section"):
                parts.append(f"Section: {header['Section']}")
            chunk_text = "[" + " | ".join(parts) + "]\n" + body

    doc_title = clean_title(source_table, doc_title) or f"{source_table} #{record_id}"
    sections = meta.get("sections") or header.get("Sections") or None

    return {
        "embedding_id": str(vector_id),
        "source_table": source_table,
        "record_id": record_id if record_id is not None else str(vector_id),
        "parent_id": parent_id if parent_id is not None else record_id,
        "chunk_index": chunk_index if chunk_index is not None else 0,
        "chunk_text": chunk_text,
        "chunk_body": body,
        "section_label": header.get("Section") or None,
        "category": meta.get("category") or header.get("Category") or source_table,
        "subject": meta.get("subject") or header.get("Subject") or None,
        "sections": sections,
        "doc_title": doc_title,
        "law_title": law_title or doc_title,
        "instrument_type": instrument_type,
        "citation": header.get("Citation") or None,
        "court": header.get("Court") or None,
        "judge": header.get("Judge") or None,
        "file_name": file_name or f"{record_id}.html",
        "doc_date": meta.get("doc_date"),
    }


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
            doc = describe_db_chunk(match.id, match.metadata)
            parent_obj = {
                "Title": doc["doc_title"],
                "Category": doc["category"],
                "Subject": doc["subject"] or doc["doc_title"],
                "Sections": doc["sections"] or "General",
                "FileName": doc["file_name"],
                "DocDate": doc["doc_date"],
            }
            child_obj = {
                "FileName": doc["file_name"],
                "Sections": doc["sections"] or "General",
                "Category": doc["category"],
                "Article_Text": doc["chunk_text"],
                "Filetext": doc["chunk_text"],
                "chunk_text": doc["chunk_text"],
            }
            doc.update({
                "subject": doc["subject"] or doc["doc_title"],
                "filename": doc["file_name"],
                "score": float(match.score),
                "database_source": "Pinecone_DB",
                "is_book": False,
                "original": {"child": child_obj, "parent": parent_obj},
            })
            results.append(doc)
        return results
    except Exception as e:
        sys.stderr.write(f"[Pinecone DB Search Error] {e}\n")
        forget_index_hosts()
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
                "chunk_body": meta.get("raw_text") or split_chunk_header(chunk_text)[1],
                "chunk_index": int(meta.get("chunk_index") or 0),
                "section_label": section_label,
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
        forget_index_hosts()
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

# Filter-only lookups still need a query vector; any non-zero one will do.
_PROBE_VECTOR = [0.001] * EMBEDDING_DIMENSIONS
MAX_DOCUMENT_CHUNKS = 1000
LONG_DOCUMENT_WINDOW = 150  # chunks shown either side of a cited chunk in a very long record
LONG_DOCUMENT_MAX_CHUNKS = 6000
HARD_CUT_OVERLAP = 220      # chunks cut mid-sentence repeat up to 200 characters of the previous one
BOOK_PAGES_AROUND = 1       # pages shown before and after the cited book page


def _trim_overlap(previous_body, body):
    """Drop the start of a chunk when it repeats the end of the previous one."""
    limit = min(len(previous_body), len(body), HARD_CUT_OVERLAP)
    for size in range(limit, 19, -1):
        if previous_body.endswith(body[:size]):
            return body[size:]
    return body


def _as_int(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _vector_metadata(fetch_result, vector_id):
    vectors = getattr(fetch_result, "vectors", None)
    if vectors is None and isinstance(fetch_result, dict):
        vectors = fetch_result.get("vectors")
    vector = (vectors or {}).get(vector_id)
    if vector is None:
        return {}
    meta = getattr(vector, "metadata", None)
    if meta is None and isinstance(vector, dict):
        meta = vector.get("metadata")
    return meta or {}


def fetch_book_pages(record_id, page_hint=None, file_name=None):
    """The cited book page plus its neighbours, in reading order, from the books index.
    Looked up by the cited chunk's id, or by file name and page for links that only carry those."""
    index = get_pinecone_books_index()
    if index is None or not (record_id or file_name):
        return None

    meta = _vector_metadata(index.fetch(ids=[str(record_id)]), str(record_id)) if record_id else {}
    file_name = meta.get("file_name") or file_name
    page = _as_int(meta.get("page_number") or meta.get("page_no") or page_hint)
    if not file_name or page is None:
        return None

    res = index.query(
        vector=_PROBE_VECTOR, top_k=200, include_metadata=True,
        filter={"file_name": {"$eq": file_name},
                "page_number": {"$gte": page - BOOK_PAGES_AROUND, "$lte": page + BOOK_PAGES_AROUND}})
    rows = []
    for match in res.matches or []:
        m = match.metadata or {}
        rows.append((_as_int(m.get("page_number")) or 0, _as_int(m.get("chunk_index")) or 0, str(match.id), m))
    if not rows:
        if not meta:
            return None
        rows = [(page, _as_int(meta.get("chunk_index")) or 0, str(record_id), meta)]
    rows.sort(key=lambda r: (r[0], r[1]))
    if not meta:
        meta = next((m for page_no, _, _, m in rows if page_no == page), rows[0][3])

    chunks = []
    for page_no, chunk_index, vid, m in rows:
        text = m.get("raw_text") or split_chunk_header(m.get("text") or m.get("chunk_text") or "")[1]
        chunks.append({"id": vid, "index": chunk_index, "page": page_no, "text": text, "full_text": text,
                       "label": f"Page {page_no}"})

    book_name = meta.get("book_name") or re.sub(r"\.pdf$", "", file_name, flags=re.IGNORECASE)
    return {
        "document": {
            "title": book_name, "source_table": "CLA Books", "record_id": str(record_id or ""),
            "file_name": file_name, "is_book": True, "page_number": page,
            "total_pages": _as_int(meta.get("total_pages")),
            "sections": meta.get("section_label") or None,
        },
        "chunks": chunks,
        "complete": False,
    }


def fetch_structured_document(source_table, record_id, focus_indices=None):
    """The chunks of one structured record, in order, with the context headers removed.

    Most records fit in one request and are returned whole. A few statutes run to more than
    MAX_DOCUMENT_CHUNKS chunks: for those, the part around the cited chunks (focus_indices)
    is returned, or the whole record page by page when no cited chunk is known."""
    index = get_pinecone_db_index()
    if index is None or record_id in (None, ""):
        return None

    numeric_id = _as_int(record_id)
    record_filter = {"source_table": {"$eq": source_table},
                     "record_id": {"$eq": numeric_id if numeric_id is not None else record_id}}

    def query(extra_filter=None):
        flt = dict(record_filter)
        if extra_filter:
            flt["chunk_index"] = extra_filter
        res = index.query(vector=_PROBE_VECTOR, top_k=MAX_DOCUMENT_CHUNKS, include_metadata=True, filter=flt)
        return [describe_db_chunk(match.id, match.metadata) for match in (res.matches or [])]

    described = query()
    if not described:
        return None

    complete = len(described) < MAX_DOCUMENT_CHUNKS
    if not complete:
        # A filter-only query returns an arbitrary MAX_DOCUMENT_CHUNKS of a longer record,
        # so it is read again by chunk position instead.
        focus = sorted({i for i in (_as_int(v) for v in (focus_indices or [])) if i is not None})
        by_id = {}
        if focus:
            for position in focus:
                window = {"$gte": max(0, position - LONG_DOCUMENT_WINDOW), "$lte": position + LONG_DOCUMENT_WINDOW}
                for doc in query(window):
                    by_id[doc["embedding_id"]] = doc
        else:
            start = 0
            while start < LONG_DOCUMENT_MAX_CHUNKS:
                page = query({"$gte": start, "$lte": start + MAX_DOCUMENT_CHUNKS - 1})
                for doc in page:
                    by_id[doc["embedding_id"]] = doc
                if len(page) < MAX_DOCUMENT_CHUNKS:
                    complete = True
                    break
                start += MAX_DOCUMENT_CHUNKS
        if by_id:
            described = list(by_id.values())
    described.sort(key=lambda d: d["chunk_index"])

    chunks, previous_body, previous_index = [], "", None
    for doc in described:
        body = doc["chunk_body"]
        adjacent = previous_index is not None and doc["chunk_index"] == previous_index + 1
        text = _trim_overlap(previous_body, body) if adjacent else body
        previous_body, previous_index = body, doc["chunk_index"]
        chunks.append({"id": doc["embedding_id"], "index": doc["chunk_index"], "text": text,
                       "full_text": body, "label": doc["section_label"]})

    first = described[0]
    return {
        "document": {
            "title": first["doc_title"], "source_table": source_table, "record_id": first["record_id"],
            "file_name": first["file_name"], "is_book": False,
            "category": first["category"], "subject": first["subject"], "sections": first["sections"],
            "law_title": first["law_title"], "instrument_type": first["instrument_type"],
            "citation": first["citation"], "court": first["court"], "judge": first["judge"],
            "doc_date": first["doc_date"],
        },
        "chunks": chunks,
        "complete": complete,
    }


def fetch_source_details(source_table, record_id, parent_id=None, file_name=None, focus_indices=None):
    """Full text of a cited source, taken from Pinecone: the whole record for the structured
    tables, the cited page and its neighbours for books. None when nothing is indexed."""
    st_lower = str(source_table or "").lower()
    try:
        if "book" in st_lower or "pinecone" in st_lower:
            return fetch_book_pages(record_id, parent_id, file_name)
        return fetch_structured_document(source_table, record_id, focus_indices)
    except Exception as e:
        sys.stderr.write(f"[Citation Lookup Error] {source_table} {record_id}: {e}\n")
        forget_index_hosts()
        return None


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
        details = fetch_source_details(source_table, record_id, parent_id, payload.get("file_name"),
                                       payload.get("focus_indices"))
        if details is None:
            print(json.dumps({"error": "Source not found in the index."}))
        else:
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
