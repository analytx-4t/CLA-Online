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
import numpy as np
import pyodbc
from dotenv import load_dotenv
from google import genai
from google.genai import types

load_dotenv()

SQL_CONN_STR = os.environ["SQL_CONN_STR"]
GEMINI_MODEL = "gemini-embedding-2"
client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

# ---------- EMBEDDING THE USER'S QUERY ----------

def embed_query(query_text):
    """gemini-embedding-2 asymmetric-retrieval query format. Must match the
    'title: ... | text: ...' document-side format used in embed_documents.py —
    mismatched formatting between query and document embeddings measurably
    hurts retrieval quality even though nothing errors out."""
    formatted = f"task: search result | query: {query_text}"
    result = client.models.embed_content(
        model=GEMINI_MODEL,
        contents=[types.Content(parts=[types.Part.from_text(text=formatted)])],
    )
    return np.array(result.embeddings[0].values, dtype=np.float32)


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


def vector_search(query_text, top_k=5, source_filter=None):
    """Cosine similarity over every stored embedding. At current scale
    (hundreds to low thousands of chunks) fetching all rows and scoring in
    Python is fine. This becomes the wrong approach past ~50k chunks — see
    PROJECT_HANDOFF.md's original scale note — at which point either move to
    a real vector DB or (cheaper first step) at minimum push the
    Category/Subject/DocDate filters into the SQL WHERE clause so the Python
    scoring loop runs over a smaller candidate set, not all rows."""
    query_vec = embed_query(query_text)

    cnx = pyodbc.connect(SQL_CONN_STR)
    try:
        cur = cnx.cursor()
        sql = f"SELECT {_SELECT_COLS} FROM dbo.DocumentEmbeddings WITH (NOLOCK)"
        params = []
        if source_filter:
            sql += " WHERE SourceTable = ?"
            params.append(source_filter)
        cur.execute(sql, params)
        rows = cur.fetchall()
    finally:
        cnx.close()

    scored = []
    for row in rows:
        emb_bytes = row[5]
        vec = _bytes_to_vector(emb_bytes)
        score = _cosine_similarity(query_vec, vec)
        extra = {
            "category": row[6], "subject": row[7], "sections": row[8],
            "doc_title": row[9], "law_title": row[10], "doc_date": str(row[11]) if row[11] else None,
            "score": score,
        }
        scored.append(_row_to_result(row[:5], extra))

    scored.sort(key=lambda r: r["score"], reverse=True)
    return scored[:top_k]

# ---------- KEYWORD SEARCH ----------

def keyword_search(query_text, top_k=5, source_filter=None):
    """Tries SQL Server full-text search (CONTAINSTABLE) first. Falls back
    automatically to a simple LIKE-based match if the full-text catalog/index
    hasn't been created yet (see schema_upgrade.sql / your handoff doc section 7) —
    so this doesn't hard-fail just because that setup step wasn't run."""
    cnx = pyodbc.connect(SQL_CONN_STR)
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
        return [
            _row_to_result(r[:5], {
                "category": r[5], "subject": r[6], "sections": r[7],
                "doc_title": r[8], "law_title": r[9], "doc_date": str(r[10]) if r[10] else None, "rank": r[11],
            })
            for r in rows
        ]
    except pyodbc.Error:
        return _keyword_search_fallback(query_text, top_k, source_filter)
    finally:
        cnx.close()


def _keyword_search_fallback(query_text, top_k, source_filter):
    terms = [t for t in re.findall(r"\w+", query_text) if len(t) > 2]
    if not terms:
        return []

    cnx = pyodbc.connect(SQL_CONN_STR)
    try:
        cur = cnx.cursor()
        like_clauses = " OR ".join(["ChunkText LIKE ?"] * len(terms))
        sql = f"""
            SELECT TOP (?) {_SELECT_COLS.replace('Embedding,', '')}
            FROM dbo.DocumentEmbeddings WITH (NOLOCK)
            WHERE ({like_clauses})
        """
        # fetch more than top_k since we re-rank by term-match count below
        params = [top_k * 4] + [f"%{t}%" for t in terms]
        if source_filter:
            sql += " AND SourceTable = ?"
            params.append(source_filter)
        cur.execute(sql, params)
        rows = cur.fetchall()
    finally:
        cnx.close()

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
    """Merge by rank position, not raw score — cosine similarity and full-text
    RANK aren't on comparable scales, so combining them directly would be
    meaningless. A strong keyword-only hit (exact 'Section 147' match) can
    still win even if it scored low on pure semantic similarity, and vice versa."""
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
    # convert any non-serializable objects (like datetime or decimal)
    res = {}
    for col, val in zip(cols, row):
        if val is not None and not isinstance(val, (int, float, str, bool)):
            res[col] = str(val)
        else:
            res[col] = val
    return res


def get_original_content(source_table, source_record_id, parent_id=None):
    """Fetch the full, untouched child row (and parent row, if one exists for
    this source) — every column, not just what was folded into ChunkText."""
    mapping = _SOURCE_TABLE_MAP.get(source_table)
    if not mapping:
        raise ValueError(f"Unknown SourceTable: {source_table!r}")

    cnx = pyodbc.connect(SQL_CONN_STR)
    try:
        cur = cnx.cursor()
        cur.execute(f"SELECT * FROM dbo.{mapping['child']} WITH (NOLOCK) WHERE {mapping['child_pk']} = ?",
                    source_record_id)
        child = _row_to_dict(cur, cur.fetchone())

        parent = None
        if mapping["parent"] and parent_id is not None:
            cur.execute(f"SELECT * FROM dbo.{mapping['parent']} WITH (NOLOCK) WHERE {mapping['parent_pk']} = ?",
                        parent_id)
            parent = _row_to_dict(cur, cur.fetchone())
    finally:
        cnx.close()

    return {"child": child, "parent": parent}

# ---------- MAIN ENTRY POINT ----------

def search(query_text, top_k=5, hybrid=True, source_filter=None, with_original_content=True):
    """Primary function a backend endpoint should call. Returns a list of
    dicts, each with the chunk, its structured metadata, an RRF/vector score,
    and (optionally) the full original parent+child rows for citation."""
    vector_results = vector_search(query_text, top_k=top_k * 3, source_filter=source_filter)

    if hybrid:
        keyword_results = keyword_search(query_text, top_k=top_k * 3, source_filter=source_filter)
        results = reciprocal_rank_fusion(vector_results, keyword_results, top_k=top_k)
    else:
        results = vector_results[:top_k]

    if with_original_content:
        for r in results:
            r["original"] = get_original_content(r["source_table"], r["record_id"], r.get("parent_id"))

    return results


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--json":
        # Read query from stdin
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
