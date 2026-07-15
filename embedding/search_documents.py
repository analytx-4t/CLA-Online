"""
search_documents.py
Hybrid (vector + keyword) search over dbo.DocumentEmbeddings, plus retrieval
of the full, untouched parent + child rows behind any hit — for citing exact
source data (case name, HeadNote, Judge, full Filetext, etc.) when answering
a user's question, not just the cleaned/chunked embedding text.

Embedding model: gemini-embedding-2 (see embed_documents.py — same model
MUST be used here, since embedding spaces between gemini-embedding-2 and
gemini-embedding-001 are not comparable).

Current scope: only the "Articles" source (Articles_2025 <-> Articles_data_2025)
has real embedded chunks right now (see ACTIVE_SOURCES in embed_documents.py).
Every other SourceTable will simply return zero rows until it's embedded too —
this file itself doesn't need to change when that happens, since it queries
DocumentEmbeddings generically by SourceTable, not by hardcoding "Articles".

Setup:
    pip install --upgrade pyodbc google-genai python-dotenv numpy
    Reuses the same .env as embed_documents.py (GEMINI_API_KEY, SQL_CONN_STR).

Run:
    python search_documents.py
"""

import os
import re
import struct
import json
import sys
import urllib.request
import numpy as np
import pyodbc
from dotenv import load_dotenv

load_dotenv()

SQL_CONN_STR = os.environ["SQL_CONN_STR"]
GEMINI_MODEL = "gemini-embedding-2"

# ---------- EMBEDDING THE USER'S QUERY ----------

def embed_query(query_text):
    """gemini-embedding-2 asymmetric-retrieval query format using built-in urllib.request."""
    formatted = f"task: search result | query: {query_text}"
    api_key = os.environ["GEMINI_API_KEY"]
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:embedContent?key={api_key}"
    
    payload = {
        "model": f"models/{GEMINI_MODEL}",
        "content": {
            "parts": [
                {"text": formatted}
            ]
        }
    }
    
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST"
    )
    
    with urllib.request.urlopen(req) as response:
        res_data = json.loads(response.read().decode("utf-8"))
        values = res_data["embedding"]["values"]
        return np.array(values, dtype=np.float32)


def _bytes_to_vector(b):
    n = len(b) // 4
    return np.array(struct.unpack(f"{n}f", b), dtype=np.float32)


def _cosine_similarity(a, b):
    denom = np.linalg.norm(a) * np.linalg.norm(b)
    return float(np.dot(a, b) / denom) if denom else 0.0

# ---------- VECTOR SEARCH ----------

_SELECT_COLS = """
    EmbeddingID, SourceTable, SourceRecordID, ParentID, ChunkText,
    Embedding, Category, Subject, Sections, DocTitle, LawTitle, DocDate
"""


def _row_to_result(row, extra=None):
    (embedding_id, source_table, record_id, parent_id, chunk_text,
     *rest) = row
    result = {
        "embedding_id": embedding_id, "source_table": source_table,
        "record_id": record_id, "parent_id": parent_id, "chunk_text": chunk_text,
    }
    if extra:
        result.update(extra)
    return result


CACHE_FILE = os.path.join(os.path.dirname(__file__), "embeddings_cache.npz")


def load_or_refresh_embeddings(cnx=None):
    """Load embeddings from local cache if it exists, otherwise refresh cache from DB."""
    if os.path.exists(CACHE_FILE):
        try:
            data = np.load(CACHE_FILE, allow_pickle=True)
            if "vectors" in data and "metadata" in data:
                return data["vectors"], data["metadata"]
        except Exception as e:
            sys.stderr.write(f"Cache read error: {e}. Re-fetching from database...\n")

    if cnx is None:
        raise ValueError("Embeddings cache file is missing/corrupted, and no DB connection was provided to rebuild it.")

    # Fetch all embeddings and metadata from the database
    sys.stderr.write("Cache missing or invalid. Rebuilding local embeddings cache...\n")
    cur = cnx.cursor()
    sql = f"SELECT {_SELECT_COLS} FROM dbo.DocumentEmbeddings WITH (NOLOCK)"
    cur.execute(sql)
    rows = cur.fetchall()
    cur.close()

    vectors = []
    metadata = []
    for row in rows:
        emb_bytes = row[5]
        vec = _bytes_to_vector(emb_bytes)
        vectors.append(vec)
        
        metadata.append({
            "embedding_id": row[0],
            "source_table": row[1],
            "record_id": row[2],
            "parent_id": row[3],
            "chunk_text": row[4],
            "category": row[6],
            "subject": row[7],
            "sections": row[8],
            "doc_title": row[9],
            "law_title": row[10],
            "doc_date": str(row[11]) if row[11] else None
        })

    vectors = np.array(vectors, dtype=np.float32)
    metadata = np.array(metadata, dtype=object)

    try:
        np.savez_compressed(CACHE_FILE, vectors=vectors, metadata=metadata)
    except Exception as e:
        sys.stderr.write(f"Cache write error: {e}\n")

    return vectors, metadata


def vector_search(cnx, query_text, top_k=5, source_filter=None, query_vec=None, vectors=None, metadata=None):
    """Cosine similarity over cached embeddings with fallback query count verification."""
    if query_vec is None:
        query_vec = embed_query(query_text)
    
    if vectors is None or metadata is None:
        vectors, metadata = load_or_refresh_embeddings(cnx)
        
    if len(vectors) == 0:
        return []

    # Calculate cosine similarity in vectorized NumPy
    norms = np.linalg.norm(vectors, axis=1)
    query_norm = np.linalg.norm(query_vec)
    denoms = norms * query_norm
    denoms[denoms == 0] = 1.0 # Prevent division by zero
    
    scores = np.dot(vectors, query_vec) / denoms

    scored = []
    for idx, score in enumerate(scores):
        meta = metadata[idx]
        if source_filter and meta["source_table"] != source_filter:
            continue
        
        res = dict(meta)
        res["score"] = float(score)
        scored.append(res)

    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored[:top_k]

# ---------- KEYWORD SEARCH ----------

def keyword_search(cnx, query_text, top_k=5, source_filter=None):
    """Tries SQL Server full-text search (CONTAINSTABLE) first. Falls back
    automatically to a simple LIKE-based match if full-text search fails."""
    try:
        cur = cnx.cursor()
        sql = f"""
            SELECT TOP (?) d.EmbeddingID, d.SourceTable, d.SourceRecordID, d.ParentID,
                   d.ChunkText, d.Category, d.Subject, d.Sections, d.DocTitle,
                   d.LawTitle, d.DocDate, ft.RANK
            FROM dbo.DocumentEmbeddings d WITH (NOLOCK)
            INNER JOIN CONTAINSTABLE(dbo.DocumentEmbeddings, ChunkText, ?) ft
                ON d.EmbeddingID = ft.[KEY]
        """
        params = [top_k, query_text]
        if source_filter:
            sql += " WHERE d.SourceTable = ?"
            params.append(source_filter)
        sql += " ORDER BY ft.RANK DESC"
        cur.execute(sql, params)
        rows = cur.fetchall()
        cur.close()
        return [
            _row_to_result(r[:5], {
                "category": r[5], "subject": r[6], "sections": r[7],
                "doc_title": r[8], "law_title": r[9], "doc_date": str(r[10]) if r[10] else None, "rank": r[11],
            })
            for r in rows
        ]
    except pyodbc.Error:
        return _keyword_search_fallback(cnx, query_text, top_k, source_filter)


def _keyword_search_fallback(cnx, query_text, top_k, source_filter):
    terms = [t for t in re.findall(r"\w+", query_text) if len(t) > 2]
    if not terms:
        return []

    cur = cnx.cursor()
    like_clauses = " OR ".join(["ChunkText LIKE ?"] * len(terms))
    sql = f"""
        SELECT TOP (?) {_SELECT_COLS.replace('Embedding,', '')}
        FROM dbo.DocumentEmbeddings WITH (NOLOCK)
        WHERE ({like_clauses})
    """
    params = [top_k * 4] + [f"%{t}%" for t in terms]
    if source_filter:
        sql += " AND SourceTable = ?"
        params.append(source_filter)
    cur.execute(sql, params)
    rows = cur.fetchall()
    cur.close()

    results = []
    for row in rows:
        chunk_text = row[4]
        match_count = sum(1 for t in terms if t.lower() in chunk_text.lower())
        extra = {
            "category": row[5], "subject": row[6], "sections": row[7],
            "doc_title": row[8], "law_title": row[9], "doc_date": str(row[10]) if row[10] else None,
            "rank": match_count,
        }
        results.append(_row_to_result(row[:5], extra))
    results.sort(key=lambda r: r["rank"], reverse=True)
    return results[:top_k]

# ---------- RECIPROCAL RANK FUSION ----------

def reciprocal_rank_fusion(vector_results, keyword_results, k=60, top_k=5):
    """Merge by rank position, not raw score."""
    scores = {}
    items = {}
    for rank, r in enumerate(vector_results):
        eid = r["embedding_id"]
        scores[eid] = scores.get(eid, 0) + 1 / (k + rank + 1)
        items.setdefault(eid, r)
    for rank, r in enumerate(keyword_results):
        eid = r["embedding_id"]
        scores[eid] = scores.get(eid, 0) + 1 / (k + rank + 1)
        items.setdefault(eid, r)

    merged = sorted(scores.items(), key=lambda x: x[1], reverse=True)
    return [{**items[eid], "rrf_score": score} for eid, score in merged[:top_k]]

# ---------- ORIGINAL ROW RETRIEVAL (parent + child, every column) ----------

_SOURCE_TABLE_MAP = {
    "Articles": {"child": "Articles_data_2025", "child_pk": "ID",
                 "parent": "Articles_2025", "parent_pk": "ID"},
    "CaseLaws": {"child": "caselaws_data_2025", "child_pk": "ID",
                 "parent": "caselaws_2025", "parent_pk": "id"},
    "Circular": {"child": "Circular_data_2025", "child_pk": "ID",
                 "parent": "Circular_2025", "parent_pk": "id"},
    "Legislation": {"child": "legislation_data_2025", "child_pk": "ID",
                     "parent": "Legislation_2025", "parent_pk": "id"},
    "Notifications": {"child": "notifications_data_2025", "child_pk": "ID",
                        "parent": "notifications_2025", "parent_pk": "Id"},
    "Query": {"child": "query_data", "child_pk": "ID",
              "parent": "Query", "parent_pk": "ID"},
    "CLASE_Commentary": {"child": "CLASE_Commentary", "child_pk": "ID",
                          "parent": "CLASE_Commentary_Act", "parent_pk": "ID"},
    "CLASE_Procedure_Details": {"child": "CLASE_Procedure_Details_2025", "child_pk": "ID",
                                  "parent": None, "parent_pk": None},
}


def _row_to_dict(cur, row):
    if row is None:
        return None
    cols = [c[0] for c in cur.description]
    res = {}
    for col, val in zip(cols, row):
        if val is not None and not isinstance(val, (int, float, str, bool)):
            res[col] = str(val)
        else:
            res[col] = val
    return res


def get_original_content_bulk(cnx, results):
    """Fetch the full untouched parent/child rows for all results in bulk to minimize roundtrips."""
    # Group results by source_table
    by_source = {}
    for r in results:
        by_source.setdefault(r["source_table"], []).append(r)

    for source_table, items in by_source.items():
        mapping = _SOURCE_TABLE_MAP.get(source_table)
        if not mapping:
            continue

        # Get all child record IDs
        child_ids = [it["record_id"] for it in items]
        if not child_ids:
            continue

        cur = cnx.cursor()
        # Fetch child rows in bulk
        placeholders = ",".join(["?"] * len(child_ids))
        cur.execute(f"SELECT * FROM dbo.{mapping['child']} WITH (NOLOCK) WHERE {mapping['child_pk']} IN ({placeholders})",
                    child_ids)
        child_rows = cur.fetchall()
        
        # Index children by ID
        child_by_id = {}
        for row in child_rows:
            d = _row_to_dict(cur, row)
            if d:
                pk_val = d[mapping['child_pk']]
                child_by_id[pk_val] = d

        # Get all parent IDs
        parent_ids = [it["parent_id"] for it in items if it.get("parent_id") is not None]
        parent_by_id = {}
        if mapping["parent"] and parent_ids:
            parent_ids = list(set(parent_ids))
            parent_placeholders = ",".join(["?"] * len(parent_ids))
            cur.execute(f"SELECT * FROM dbo.{mapping['parent']} WITH (NOLOCK) WHERE {mapping['parent_pk']} IN ({parent_placeholders})",
                        parent_ids)
            parent_rows = cur.fetchall()
            for row in parent_rows:
                d = _row_to_dict(cur, row)
                if d:
                    pk_val = d[mapping['parent_pk']]
                    parent_by_id[pk_val] = d

        cur.close()

        # Assign back to items
        for it in items:
            it["original"] = {
                "child": child_by_id.get(it["record_id"]),
                "parent": parent_by_id.get(it["parent_id"]) if it.get("parent_id") is not None else None
            }

# ---------- MAIN ENTRY POINT ----------

def search(query_text, top_k=5, hybrid=True, source_filter=None, with_original_content=True):
    """Primary function a backend endpoint should call. Reuse single database connection."""
    from concurrent.futures import ThreadPoolExecutor

    # Run database connection, query embedding, and cache loading in parallel to optimize latency
    with ThreadPoolExecutor(max_workers=3) as executor:
        future_cnx = executor.submit(pyodbc.connect, SQL_CONN_STR)
        future_embed = executor.submit(embed_query, query_text)
        future_cache = executor.submit(load_or_refresh_embeddings, None)

        # Retrieve outputs of tasks
        query_vec = future_embed.result()
        
        try:
            vectors, metadata = future_cache.result()
        except Exception as cache_err:
            # If cache loading failed or was missing, connect to DB and refresh cache
            sys.stderr.write(f"Cache load fail or missing: {cache_err}. Re-fetching...\n")
            cnx = future_cnx.result()
            vectors, metadata = load_or_refresh_embeddings(cnx)

        cnx = future_cnx.result()

    try:
        vector_results = vector_search(cnx, query_text, top_k=top_k * 3, source_filter=source_filter,
                                       query_vec=query_vec, vectors=vectors, metadata=metadata)

        if hybrid:
            keyword_results = keyword_search(cnx, query_text, top_k=top_k * 3, source_filter=source_filter)
            results = reciprocal_rank_fusion(vector_results, keyword_results, top_k=top_k)
        else:
            results = vector_results[:top_k]

        if with_original_content:
            get_original_content_bulk(cnx, results)
    finally:
        cnx.close()

    return results


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--json":
        try:
            input_data = json.load(sys.stdin)
            query = input_data.get("query", "")
            top_k = input_data.get("top_k", 5)
            hybrid = input_data.get("hybrid", True)
            source_filter = input_data.get("source_filter", None)
            
            results = search(query, top_k=top_k, hybrid=hybrid, source_filter=source_filter)
            print(json.dumps({"results": results}))
        except Exception as e:
            print(json.dumps({"error": str(e)}), file=sys.stderr)
        return

    query = input("Ask a legal question: ").strip()
    if not query:
        print("Empty query.")
        return

    results = search(query, top_k=5, hybrid=True)
    if not results:
        print("No matches found in the embedded data.")
        return

    for i, r in enumerate(results, 1):
        print(f"\n[{i}] {r['source_table']} | {r.get('doc_title') or 'untitled'} "
              f"| Category: {r.get('category')} | Sections: {r.get('sections')} "
              f"| score: {r.get('score', r.get('rrf_score', 0)):.4f}")
        print(r["chunk_text"][:400] + ("..." if len(r["chunk_text"]) > 400 else ""))


if __name__ == "__main__":
    main()
