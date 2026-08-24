"""
embeded_documents.py

Structure-Aware Chunking & Embedding Pipeline for Neon PostgreSQL + pgvector.

Reads from Neon PostgreSQL database (NEON_DB_URI / DATABASE_URL) across 8 legal source clusters:
1. Articles (Articles_data_2025 JOIN Articles_2025)
2. CaseLaws (caselaws_data_2025 JOIN caselaws_2025)
3. Circular (Circular_data_2025 JOIN Circular_2025)
4. Legislation (Legislation_data_2025 JOIN Legislation_2025)
5. Notifications (notifications_data_2025 JOIN notifications_2025)
6. Query (query_data JOIN Query)
7. CLASE_Commentary (CLASE_Commentary LEFT JOIN CLASE_Commentary_Act)
8. CLASE_Procedure_Details (CLASE_Procedure_Details_2025)

Generates 1536-dimensional embeddings using OpenAI's 'text-embedding-3-small' model,
and inserts them directly into the 'document_embeddings' table with native pgvector indexing.
"""

import os
import re
import sys
import html
import time
import psycopg2
from psycopg2.extras import execute_values, RealDictCursor
from dateutil import parser as dateparser
from dotenv import load_dotenv
from openai import OpenAI, RateLimitError, APIError, APIConnectionError

load_dotenv()

# ---------- CONFIGURATION ----------

NEON_DB_URI = os.getenv("NEON_DB_URI") or os.getenv("DATABASE_URL") or (
    "postgresql://neondb_owner:npg_V2epn6DfNqmJ@ep-wandering-fog-ayy57526-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
)

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "1536"))

MAX_CHUNK_CHARS = 1400
CHUNK_OVERLAP_CHARS = 200
BATCH_SIZE = 100  # Chunks per OpenAI embedding request & DB batch insert

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

ACTIVE_SOURCES = [
    "Articles", "CaseLaws", "Circular", "Legislation",
    "Notifications", "Query", "CLASE_Commentary", "CLASE_Procedure_Details",
]

# ---------- SOURCE QUERIES (PostgreSQL SQL) ----------

SOURCE_QUERIES = {
    "Articles": """
        SELECT d."ID" AS record_id, d."Article_ID" AS parent_id, d."FileName" AS file_name,
               CAST(NULL AS VARCHAR(200)) AS label,
               CONCAT('Title: ', COALESCE(a."Title",''), ' | Category: ', COALESCE(a."Category",''),
                      ' | Subject: ', COALESCE(a."Subject",''), ' | Sections: ', COALESCE(a."Sections",'')) AS context_prefix,
               d."Filetext" AS raw_text,
               a."Category" AS category, a."Subject" AS subject, a."Sections" AS sections,
               a."Title" AS doc_title, CAST(NULL AS VARCHAR(200)) AS law_title,
               a."InsertedDate" AS date_structured,
               CONCAT(COALESCE(a."IssueMonth",''), ' ', COALESCE(a."IssueYear",'')) AS date_raw
        FROM "Articles_data_2025" d
        JOIN "Articles_2025" a ON a."ID" = d."Article_ID"
        WHERE d."Filetext" IS NOT NULL
    """,
    "CaseLaws": """
        SELECT d."ID" AS record_id, d."CaseLawID" AS parent_id, d."FileName" AS file_name,
               CAST(NULL AS VARCHAR(200)) AS label,
               CONCAT('Versus: ', COALESCE(c."Versus",''), ' | Category: ', COALESCE(c."Category",''),
                      ' | Subject: ', COALESCE(c."Subject",''), ' | Citation: ', COALESCE(c."Citation",''),
                      ' | Judge: ', COALESCE(c."Judge",''), ' | Sections: ', COALESCE(c."Sections",''),
                      ' | HeadNote: ', LEFT(COALESCE(c."HeadNote",''), 300)) AS context_prefix,
               d."Filetext" AS raw_text,
               c."Category" AS category, c."Subject" AS subject, c."Sections" AS sections,
               c."Versus" AS doc_title, CAST(NULL AS VARCHAR(200)) AS law_title,
               c."Judgement_date_new" AS date_structured,
               c."Date_of_Judgement" AS date_raw
        FROM "caselaws_data_2025" d
        JOIN "caselaws_2025" c ON c."id" = d."CaseLawID"
        WHERE d."Filetext" IS NOT NULL
    """,
    "Circular": """
        SELECT d."ID" AS record_id, d."Notification_ID" AS parent_id, d."FileName" AS file_name,
               CAST(NULL AS VARCHAR(200)) AS label,
               CONCAT('Title: ', COALESCE(c."Title",''), ' | Category: ', COALESCE(c."Category",''),
                      ' | Subject: ', COALESCE(c."Subject",''), ' | Sections: ', COALESCE(c."Sections",'')) AS context_prefix,
               d."Filetext" AS raw_text,
               c."Category" AS category, c."Subject" AS subject, c."Sections" AS sections,
               c."Title" AS doc_title, CAST(NULL AS VARCHAR(200)) AS law_title,
               c."CircDate_new" AS date_structured,
               c."CircDate" AS date_raw
        FROM "Circular_data_2025" d
        JOIN "Circular_2025" c ON c."id" = d."Notification_ID"
        WHERE d."Filetext" IS NOT NULL
    """,
    "Legislation": """
        SELECT d."ID" AS record_id, d."Legislation_ID" AS parent_id, d."FileName" AS file_name,
               CAST(NULL AS VARCHAR(200)) AS label,
               CONCAT('Title: ', COALESCE(l."Title",''), ' | Category: ', COALESCE(l."Category",''),
                      ' | Subject: ', COALESCE(l."Subject",''), ' | Chapter: ', COALESCE(l."ChapterHeading",''),
                      ' | Sections: ', COALESCE(l."Sections",'')) AS context_prefix,
               d."Filetext" AS raw_text,
               l."Category" AS category, l."Subject" AS subject, l."Sections" AS sections,
               l."Title" AS doc_title, l."Legislation" AS law_title,
               l."InsertedDate" AS date_structured,
               CAST(l."IssueYear" AS VARCHAR(20)) AS date_raw
        FROM "Legislation_data_2025" d
        JOIN "Legislation_2025" l ON l."id" = d."Legislation_ID"
        WHERE d."Filetext" IS NOT NULL
    """,
    "Notifications": """
        SELECT d."ID" AS record_id, d."Notification_ID" AS parent_id, d."FileName" AS file_name,
               CAST(NULL AS VARCHAR(200)) AS label,
               CONCAT('Title: ', COALESCE(n."Title",''), ' | Category: ', COALESCE(n."Category",''),
                      ' | Subject: ', COALESCE(n."Subject",''), ' | Sections: ', COALESCE(n."Sections",'')) AS context_prefix,
               d."Filetext" AS raw_text,
               n."Category" AS category, n."Subject" AS subject, n."Sections" AS sections,
               n."Title" AS doc_title, CAST(NULL AS VARCHAR(200)) AS law_title,
               n."NotificationDate_new" AS date_structured,
               n."NotificationDate" AS date_raw
        FROM "notifications_data_2025" d
        JOIN "notifications_2025" n ON n."Id" = d."Notification_ID"
        WHERE d."Filetext" IS NOT NULL
    """,
    "Query": """
        SELECT d."ID" AS record_id, d."Query_ID" AS parent_id, d."FileName" AS file_name,
               CAST(NULL AS VARCHAR(200)) AS label,
               CONCAT('Title: ', COALESCE(q."Title",''), ' | Subject: ', COALESCE(q."Subject",''),
                      ' | Topics: ', COALESCE(q."Topics",''), ' | Sections: ', COALESCE(q."Sections",'')) AS context_prefix,
               d."Filetext" AS raw_text,
               CAST(NULL AS VARCHAR(510)) AS category, q."Subject" AS subject, q."Sections" AS sections,
               q."Title" AS doc_title, CAST(NULL AS VARCHAR(200)) AS law_title,
               q."InsertedDate" AS date_structured,
               q."IssueYear" AS date_raw
        FROM "query_data" d
        JOIN "Query" q ON q."ID" = d."Query_ID"
        WHERE d."Filetext" IS NOT NULL
    """,
    "CLASE_Commentary": """
        SELECT cm."ID" AS record_id, cm."commentary_ActID" AS parent_id,
               CAST(NULL AS VARCHAR(200)) AS file_name, cm."Section" AS label,
               CONCAT('Title: ', COALESCE(cm."Title",''), ' | Act: ', COALESCE(act."Title",'')) AS context_prefix,
               cm."Commentary_Details" AS raw_text,
               CAST(NULL AS VARCHAR(510)) AS category, CAST(NULL AS VARCHAR(510)) AS subject,
               cm."Section" AS sections, cm."Title" AS doc_title, act."Title" AS law_title,
               cm."Inserted_Date" AS date_structured,
               CAST(NULL AS VARCHAR(200)) AS date_raw
        FROM "CLASE_Commentary" cm
        LEFT JOIN "CLASE_Commentary_Act" act ON act."ID" = cm."commentary_ActID"
        WHERE cm."Commentary_Details" IS NOT NULL AND cm."IsActive" = TRUE
    """,
    "CLASE_Procedure_Details": """
        SELECT p."ID" AS record_id, CAST(NULL AS INT) AS parent_id,
               CAST(NULL AS VARCHAR(200)) AS file_name, p."Heading" AS label,
               CONCAT('Title: ', COALESCE(p."Title",''), ' | Law: ', COALESCE(p."LawTitle",'')) AS context_prefix,
               CONCAT(COALESCE(p."Procedure",''),
                      CASE WHEN p."Resolution" IS NOT NULL AND LENGTH(p."Resolution") > 0
                           THEN CONCAT(E'\n\n', 'Resolution: ', p."Resolution")
                           ELSE '' END) AS raw_text,
               CAST(NULL AS VARCHAR(510)) AS category, CAST(NULL AS VARCHAR(510)) AS subject,
               CAST(NULL AS VARCHAR(200)) AS sections, p."Title" AS doc_title,
               p."LawTitle" AS law_title,
               CAST(NULL AS TIMESTAMP) AS date_structured,
               CAST(NULL AS VARCHAR(200)) AS date_raw
        FROM "CLASE_Procedure_Details_2025" p
        WHERE p."Procedure" IS NOT NULL OR p."Resolution" IS NOT NULL
    """,
}

# ---------- TEXT CLEANING & DATE PARSING ----------

def strip_html(text):
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def resolve_doc_date(date_structured, date_raw):
    if date_structured:
        return date_structured
    if date_raw and str(date_raw).strip():
        cleaned = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", str(date_raw), flags=re.IGNORECASE)
        try:
            return dateparser.parse(cleaned, fuzzy=True, default=None)
        except (ValueError, OverflowError):
            return None
    return None

# ---------- STRUCTURE-AWARE CHUNKING ----------

SECTION_MARKER_RE = re.compile(
    r"(?=(?:\A|\n)[ \t]*(?:Section|Sec\.?|Clause|Article|Chapter|Regulation|Rule)\s+[0-9IVXLCM]+[A-Za-z]?\b)",
    re.IGNORECASE,
)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def split_by_structure(text):
    pieces = SECTION_MARKER_RE.split(text)
    pieces = [p.strip() for p in pieces if p and p.strip()]

    if len(pieces) < 2:
        stripped = text.strip()
        label = stripped.split("\n", 1)[0][:80].strip() if re.match(
            r"^\s*(?:Section|Sec\.?|Clause|Article|Chapter|Regulation|Rule)\s+[0-9IVXLCM]+[A-Za-z]?\b",
            stripped, re.IGNORECASE,
        ) else None
        return [(label, stripped)]

    sections = []
    for piece in pieces:
        first_line = piece.split("\n", 1)[0][:80].strip()
        sections.append((first_line, piece))
    return sections


def recursive_split(text, max_chars=MAX_CHUNK_CHARS, overlap=CHUNK_OVERLAP_CHARS):
    if len(text) <= max_chars:
        return [text]
    paragraphs = [p.strip() for p in text.split("\n\n") if p.strip()]
    if len(paragraphs) > 1:
        return _pack_pieces(paragraphs, max_chars, overlap, deeper=_split_sentences)
    return _split_sentences(text, max_chars, overlap)


def _split_sentences(text, max_chars=MAX_CHUNK_CHARS, overlap=CHUNK_OVERLAP_CHARS):
    sentences = [s.strip() for s in SENTENCE_SPLIT_RE.split(text) if s.strip()]
    if len(sentences) > 1:
        return _pack_pieces(sentences, max_chars, overlap, deeper=_hard_cut)
    return _hard_cut(text, max_chars, overlap)


def _hard_cut(text, max_chars=MAX_CHUNK_CHARS, overlap=CHUNK_OVERLAP_CHARS):
    chunks = []
    start = 0
    while start < len(text):
        end = start + max_chars
        chunks.append(text[start:end])
        start = end - overlap
    return chunks


def _pack_pieces(pieces, max_chars, overlap, deeper):
    chunks = []
    current = ""
    for piece in pieces:
        if len(piece) > max_chars:
            if current:
                chunks.append(current)
                current = ""
            chunks.extend(deeper(piece, max_chars, overlap))
            continue
        candidate = (current + " " + piece).strip() if current else piece
        if len(candidate) <= max_chars:
            current = candidate
        else:
            if current:
                chunks.append(current)
            current = piece
    if current:
        chunks.append(current)
    return chunks


def build_chunks(text, override_label=None):
    if not text or not text.strip():
        return []

    sections = [(override_label, text.strip())] if override_label else split_by_structure(text)
    final_chunks = []
    for label, body in sections:
        for piece in recursive_split(body):
            final_chunks.append((label, piece))
    return final_chunks


MAX_CONTEXT_PREFIX_CHARS = 500


def with_context_prefix(source_name, context_prefix, filename, label, chunk_body):
    parts = [source_name]
    if context_prefix:
        if len(context_prefix) > MAX_CONTEXT_PREFIX_CHARS:
            context_prefix = context_prefix[:MAX_CONTEXT_PREFIX_CHARS] + "..."
        parts.append(context_prefix)
    if filename:
        parts.append(f"File: {filename}")
    if label:
        parts.append(f"Section: {label}")
    header = "[" + " | ".join(parts) + "]\n"
    return header + chunk_body

# ---------- EMBEDDING API ----------

def embed_chunks_batch(texts, retries=5):
    """Call OpenAI text-embedding-3-small for a batch of strings."""
    kwargs = {
        "model": EMBEDDING_MODEL,
        "input": texts,
        "dimensions": EMBEDDING_DIMENSIONS,
    }

    for attempt in range(retries):
        try:
            result = client.embeddings.create(**kwargs)
            vectors = [d.embedding for d in result.data]
            if len(vectors) != len(texts):
                raise RuntimeError(f"Expected {len(texts)} embeddings, got {len(vectors)}.")
            return vectors
        except RateLimitError as e:
            wait = 2 ** attempt * 5
            print(f"    Rate limited (attempt {attempt + 1}/{retries}): retrying in {wait}s...")
            time.sleep(wait)
        except (APIError, APIConnectionError) as e:
            wait = 2 ** attempt
            print(f"    API error (attempt {attempt + 1}/{retries}): {e} -- retrying in {wait}s...")
            time.sleep(wait)
    raise RuntimeError("Embedding failed after max retries.")

# ---------- POSTGRESQL DB INGESTION ----------

def load_existing_keys(cur, source_name):
    cur.execute(
        'SELECT "record_id", "chunk_index" FROM "document_embeddings" WHERE "source_table" = %s;',
        (source_name,),
    )
    return {(row[0], row[1]) for row in cur.fetchall()}


INSERT_SQL = """
    INSERT INTO "document_embeddings"
        ("source_table", "record_id", "parent_id", "file_name", "chunk_index",
         "chunk_text", "embedding", "embedding_model", "embedding_dim",
         "category", "subject", "sections", "doc_title", "law_title", "doc_date")
    VALUES %s
    ON CONFLICT ("source_table", "record_id", "chunk_index") DO UPDATE SET
        "chunk_text" = EXCLUDED."chunk_text",
        "embedding" = EXCLUDED."embedding",
        "doc_title" = EXCLUDED."doc_title",
        "doc_date" = EXCLUDED."doc_date";
"""


def process_source(conn, source_name, query):
    read_cur = conn.cursor(cursor_factory=RealDictCursor)
    read_cur.execute(query)
    rows = read_cur.fetchall()
    print(f"\n[{source_name}] Loaded {len(rows)} source records from PostgreSQL.")

    write_cur = conn.cursor()
    existing_keys = load_existing_keys(write_cur, source_name)

    pending = []
    for row in rows:
        record_id = row["record_id"]
        parent_id = row["parent_id"]
        filename = row["file_name"]
        sql_label = row["label"]
        context_prefix = row["context_prefix"]
        raw_text = row["raw_text"]
        category = row["category"]
        subject = row["subject"]
        sections = row["sections"]
        doc_title = row["doc_title"]
        law_title = row["law_title"]
        date_structured = row["date_structured"]
        date_raw = row["date_raw"]

        clean_text = strip_html(raw_text)
        chunks = build_chunks(clean_text, override_label=sql_label)
        doc_date = resolve_doc_date(date_structured, date_raw)

        for idx, (label, chunk_body) in enumerate(chunks):
            if (record_id, idx) in existing_keys:
                continue
            enriched_text = with_context_prefix(source_name, context_prefix, filename, label, chunk_body)
            pending.append({
                "record_id": record_id,
                "parent_id": parent_id,
                "filename": filename,
                "idx": idx,
                "stored_text": enriched_text,
                "category": category,
                "subject": subject,
                "sections": sections,
                "doc_title": doc_title,
                "law_title": law_title,
                "doc_date": doc_date,
            })

    print(f"  -> {len(pending)} new chunks to embed and index into pgvector.")

    for batch_start in range(0, len(pending), BATCH_SIZE):
        batch = pending[batch_start:batch_start + BATCH_SIZE]
        texts = [item["stored_text"] for item in batch]
        vectors = embed_chunks_batch(texts)

        insert_rows = []
        for item, vector in zip(batch, vectors):
            # Format vector as postgres vector string literal: '[0.1, 0.2, ...]'
            vec_str = "[" + ",".join(str(v) for v in vector) + "]"
            insert_rows.append((
                source_name,
                item["record_id"],
                item["parent_id"],
                item["filename"],
                item["idx"],
                item["stored_text"],
                vec_str,
                EMBEDDING_MODEL,
                len(vector),
                item["category"],
                item["subject"],
                item["sections"],
                item["doc_title"],
                item["law_title"],
                item["doc_date"],
            ))

        execute_values(write_cur, INSERT_SQL, insert_rows, page_size=BATCH_SIZE)
        conn.commit()
        print(f"  Inserted {batch_start + len(insert_rows)} / {len(pending)} chunks...")

    read_cur.close()
    write_cur.close()


def main():
    conn = psycopg2.connect(NEON_DB_URI)
    try:
        for source_name in ACTIVE_SOURCES:
            query = SOURCE_QUERIES.get(source_name)
            if not query:
                continue
            process_source(conn, source_name, query)
    finally:
        conn.close()
    print("\n--- Neon PostgreSQL pgvector Ingestion Completed Successfully! ---")


if __name__ == "__main__":
    main()