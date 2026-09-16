"""
transfer_to_pinecone.py

Transfers all legal content from the Neon PostgreSQL database (DATABASE_URL / NEON_DB_URI)
into the Pinecone index 'cla-online-db', using the SAME structure-aware chunking pipeline
already established in embeded_documents.py (imported, not modified).

Covers all 8 content clusters:
  Articles, CaseLaws, Circular, Legislation, Notifications, Query,
  CLASE_Commentary, CLASE_Procedure_Details

Fix vs. the original pipeline: caselaws_data_2025 (child full-text table) is currently EMPTY,
so the original CaseLaws query returns 0 rows. This script's CaseLaws query LEFT JOINs instead
of INNER JOINs and falls back to caselaws_2025.HeadNote when no child Filetext exists, so all
15,991 case laws actually get embedded.

This script only READS from Postgres and WRITES to Pinecone + OpenAI's embeddings API.
It does not touch document_embeddings or any existing table/code.

Usage:
    python embedding/transfer_to_pinecone.py
"""

import os
import sys
import time
import pickle
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv
from pinecone import Pinecone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from embeded_documents import (  # noqa: E402  (reusing existing pipeline logic, not modifying it)
    SOURCE_QUERIES,
    strip_html,
    build_chunks,
    resolve_doc_date,
    with_context_prefix,
    embed_chunks_batch,
    EMBEDDING_MODEL,
    EMBEDDING_DIMENSIONS,
    BATCH_SIZE,
)

_ROOT_ENV = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
load_dotenv(_ROOT_ENV)

NEON_DB_URI = os.getenv("NEON_DB_URI") or os.getenv("DATABASE_URL")
PINECONE_API_KEY = os.environ["PINECONE_API_KEY"]
PINECONE_INDEX_NAME = os.getenv("PINECONE_DB_INDEX_NAME", "cla-online-db")

UPSERT_BATCH_SIZE = 100

# Some of these tables have no index on their JOIN columns, so a query can take 10+ minutes
# to transfer over a slow/unstable link, and has been observed to drop mid-transfer
# (SSL connection closed, Pinecone write timeout). Cache each source's rows locally the
# first time they're successfully read, so a crash/restart never has to pay that cost again.
QUERY_CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pg_query_cache")
os.makedirs(QUERY_CACHE_DIR, exist_ok=True)


def connect_db(retries=6):
    for attempt in range(retries):
        try:
            return psycopg2.connect(
                NEON_DB_URI,
                keepalives=1,
                keepalives_idle=20,
                keepalives_interval=10,
                keepalives_count=6,
                connect_timeout=30,
            )
        except psycopg2.OperationalError as e:
            wait = min(2 ** attempt * 5, 60)
            print(f"    Postgres connect error (attempt {attempt + 1}/{retries}): {e} -- retrying in {wait}s...",
                  flush=True)
            time.sleep(wait)
    raise RuntimeError("Could not connect to Postgres after max retries.")


def fetch_rows_cached(source_name, query, retries=5):
    """Read a source's rows from Postgres, with a local on-disk cache so a crash/restart
    doesn't have to re-run a slow, occasionally-flaky query."""
    cache_path = os.path.join(QUERY_CACHE_DIR, f"{source_name}.pkl")
    if os.path.exists(cache_path):
        with open(cache_path, "rb") as f:
            rows = pickle.load(f)
        print(f"[{time.strftime('%H:%M:%S')}] [{source_name}] Loaded {len(rows)} rows from local cache "
              f"({cache_path}) -- skipping Postgres query.", flush=True)
        return rows

    last_err = None
    for attempt in range(retries):
        conn = None
        try:
            conn = connect_db()
            cur = conn.cursor(cursor_factory=RealDictCursor)
            cur.execute(query)
            rows = cur.fetchall()
            cur.close()
            conn.close()
            rows = [dict(r) for r in rows]
            with open(cache_path, "wb") as f:
                pickle.dump(rows, f)
            return rows
        except psycopg2.OperationalError as e:
            last_err = e
            if conn is not None:
                try:
                    conn.close()
                except Exception:
                    pass
            wait = min(2 ** attempt * 5, 60)
            print(f"    [{source_name}] Postgres query error (attempt {attempt + 1}/{retries}): {e} "
                  f"-- reconnecting and retrying in {wait}s...", flush=True)
            time.sleep(wait)
    raise RuntimeError(f"[{source_name}] Query failed after max retries: {last_err}")

# ---------- Sources to process ----------
# Same 8 clusters as embeded_documents.py, but CaseLaws gets a fixed query
# (LEFT JOIN + HeadNote fallback) since caselaws_data_2025 is empty.

CASELAWS_FIXED_QUERY = """
    SELECT c."id" AS record_id, c."id" AS parent_id,
           COALESCE(NULLIF(d."FileName", ''), c."FileName") AS file_name,
           CAST(NULL AS VARCHAR(200)) AS label,
           CONCAT('Versus: ', COALESCE(c."Versus",''), ' | Category: ', COALESCE(c."Category",''),
                  ' | Subject: ', COALESCE(c."Subject",''), ' | Citation: ', COALESCE(c."Citation",''),
                  ' | Judge: ', COALESCE(c."Judge",''), ' | Court: ', COALESCE(c."CourtName",''),
                  ' | Sections: ', COALESCE(c."Sections",'')) AS context_prefix,
           COALESCE(NULLIF(d."Filetext", ''), c."HeadNote") AS raw_text,
           c."Category" AS category, c."Subject" AS subject, c."Sections" AS sections,
           c."Versus" AS doc_title, CAST(NULL AS VARCHAR(200)) AS law_title,
           c."Judgement_date_new" AS date_structured,
           c."Date_of_Judgement" AS date_raw
    FROM "caselaws_2025" c
    LEFT JOIN "caselaws_data_2025" d ON d."CaseLawID" = c."id"
    WHERE COALESCE(NULLIF(d."Filetext", ''), c."HeadNote") IS NOT NULL
"""

SOURCES = dict(SOURCE_QUERIES)
SOURCES["CaseLaws"] = CASELAWS_FIXED_QUERY

SOURCE_ORDER = [
    "Articles", "CaseLaws", "Circular", "Legislation",
    "Notifications", "Query", "CLASE_Commentary", "CLASE_Procedure_Details",
]


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def upsert_with_retry(index, vectors, retries=8):
    """Upsert to Pinecone with retry/backoff — the network link to this DB/Pinecone
    has shown intermittent slow throughput, which can trip httpx write timeouts."""
    for attempt in range(retries):
        try:
            index.upsert(vectors=vectors, timeout=120)
            return
        except Exception as e:
            wait = min(2 ** attempt * 3, 60)
            log(f"    Pinecone upsert error (attempt {attempt + 1}/{retries}): {e} -- retrying in {wait}s...")
            time.sleep(wait)
    raise RuntimeError("Pinecone upsert failed after max retries.")


def load_existing_ids(index, source_name, retries=5):
    """List all vector IDs already upserted for this source (ID-only, no vector data —
    far cheaper than fetch()), so a resumed run skips chunks already in Pinecone without
    re-embedding (cost) or re-upserting (time) them. A few paginated calls total, instead
    of one fetch() round-trip per batch."""
    for attempt in range(retries):
        try:
            existing = set()
            for page in index.list(prefix=f"{source_name}|", limit=100):
                items = page.vectors if hasattr(page, "vectors") else page
                for item in items:
                    existing.add(item.id if hasattr(item, "id") else item)
            return existing
        except Exception as e:
            wait = min(2 ** attempt * 3, 30)
            log(f"    Pinecone list error (attempt {attempt + 1}/{retries}): {e} -- retrying in {wait}s...")
            time.sleep(wait)
    log("    Warning: could not list existing IDs after retries, assuming none exist.")
    return set()


def build_metadata(source_name, record_id, parent_id, filename, idx, stored_text,
                    category, subject, sections, doc_title, law_title, doc_date):
    meta = {
        "source_table": source_name,
        "record_id": int(record_id),
        "chunk_index": int(idx),
        "chunk_text": stored_text,
        "embedding_model": EMBEDDING_MODEL,
    }
    if parent_id is not None:
        meta["parent_id"] = int(parent_id)
    if filename:
        meta["file_name"] = str(filename)
    if category:
        meta["category"] = str(category)
    if subject:
        meta["subject"] = str(subject)
    if sections:
        meta["sections"] = str(sections)
    if doc_title:
        meta["doc_title"] = str(doc_title)
    if law_title:
        meta["law_title"] = str(law_title)
    if doc_date:
        meta["doc_date"] = doc_date.isoformat()
    return meta


def process_source(index, source_name, query, totals):
    rows = fetch_rows_cached(source_name, query)
    log(f"[{source_name}] Loaded {len(rows)} source records from PostgreSQL.")

    pending = []
    for row in rows:
        record_id = row["record_id"]
        parent_id = row["parent_id"]
        filename = row["file_name"]
        sql_label = row["label"]
        context_prefix = row["context_prefix"]
        raw_text = row["raw_text"]

        clean_text = strip_html(raw_text)
        chunks = build_chunks(clean_text, override_label=sql_label)
        doc_date = resolve_doc_date(row["date_structured"], row["date_raw"])

        for idx, (label, chunk_body) in enumerate(chunks):
            enriched_text = with_context_prefix(source_name, context_prefix, filename, label, chunk_body)
            pending.append({
                "id": f"{source_name}|{record_id}|{idx}",
                "record_id": record_id,
                "parent_id": parent_id,
                "filename": filename,
                "idx": idx,
                "stored_text": enriched_text,
                "category": row["category"],
                "subject": row["subject"],
                "sections": row["sections"],
                "doc_title": row["doc_title"],
                "law_title": row["law_title"],
                "doc_date": doc_date,
            })

    log(f"[{source_name}] -> {len(pending)} chunks to embed and upsert.")
    totals["chunks_planned"] += len(pending)

    log(f"[{source_name}] Checking Pinecone for already-upserted chunks (resume support)...")
    existing_ids = load_existing_ids(index, source_name)
    log(f"[{source_name}] {len(existing_ids)} chunks already in Pinecone from a prior run; will skip those.")

    for batch_start in range(0, len(pending), BATCH_SIZE):
        batch = pending[batch_start:batch_start + BATCH_SIZE]

        new_batch = [item for item in batch if item["id"] not in existing_ids]
        totals["chunks_done"] += len(batch) - len(new_batch)

        if new_batch:
            texts = [item["stored_text"] for item in new_batch]
            vectors = embed_chunks_batch(texts)

            pinecone_vectors = []
            for item, vector in zip(new_batch, vectors):
                meta = build_metadata(
                    source_name, item["record_id"], item["parent_id"], item["filename"],
                    item["idx"], item["stored_text"], item["category"], item["subject"],
                    item["sections"], item["doc_title"], item["law_title"], item["doc_date"],
                )
                pinecone_vectors.append({"id": item["id"], "values": vector, "metadata": meta})

            for up_start in range(0, len(pinecone_vectors), UPSERT_BATCH_SIZE):
                up_batch = pinecone_vectors[up_start:up_start + UPSERT_BATCH_SIZE]
                upsert_with_retry(index, up_batch)

            totals["chunks_done"] += len(new_batch)

        skipped_note = f" ({len(batch) - len(new_batch)} already done, skipped)" if len(new_batch) != len(batch) else ""
        totals["embedded_tokens_batches"] += 1
        log(f"[{source_name}] Embedded+upserted {batch_start + len(batch)} / {len(pending)} chunks{skipped_note} "
            f"(overall: {totals['chunks_done']}/{totals['chunks_planned'] if totals['chunks_planned'] else '?'})")


def main():
    start = time.time()
    log(f"Connecting to Pinecone index '{PINECONE_INDEX_NAME}'...")
    pc = Pinecone(api_key=PINECONE_API_KEY)
    index = pc.Index(PINECONE_INDEX_NAME)
    stats_before = index.describe_index_stats()
    log(f"Index stats before: {stats_before.total_vector_count} vectors")

    totals = {"chunks_planned": 0, "chunks_done": 0, "embedded_tokens_batches": 0}

    for source_name in SOURCE_ORDER:
        query = SOURCES[source_name]
        t0 = time.time()
        process_source(index, source_name, query, totals)
        log(f"[{source_name}] Done in {time.time() - t0:.1f}s. "
            f"Running total: {totals['chunks_done']} chunks upserted.")

    elapsed = time.time() - start
    log(f"\n--- Transfer complete: {totals['chunks_done']} chunks embedded and upserted "
        f"to Pinecone index '{PINECONE_INDEX_NAME}' in {elapsed:.1f}s ---")

    time.sleep(2)  # let Pinecone stats settle
    stats_after = index.describe_index_stats()
    log(f"Index stats after: {stats_after.total_vector_count} vectors")


if __name__ == "__main__":
    main()
