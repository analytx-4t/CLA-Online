"""
Bulk-embed legal documents from SQL Server into DocumentEmbeddings.

This script now uses the same shared OpenAI text-embedding-3-large embedding
service as the production chatbot and the evaluation pipeline so all retrieval
paths stay consistent.

Pipeline per row:
    1. Strip HTML tags (keeping the enclosed text) and decode HTML entities
    2. Split on legal structure (Section/Clause/Article/Chapter) if no clean
       label already exists in the source table; otherwise use that label directly
    3. Recursively fall back (paragraph -> sentence -> character) for oversized sections
    4. Prepend a contextual prefix (source, parent metadata, filename, section label)
       before embedding, so each chunk is self-contained when retrieved alone
    5. Attach structured filter metadata (Category/Subject/Sections/DocTitle/
       LawTitle/DocDate) as real columns on DocumentEmbeddings, so a RAG app can
       filter (SUGGESTED_FILTERS) BEFORE or alongside the vector scan instead of
       re-joining 8 parent tables at query time.

Changes vs. the original version:
    - SOURCE_QUERIES now return 13 columns per source (was 6) — the extra 7 are
      the structured filter metadata described above.
    - Uses OpenAI's text-embedding-3-large instead of Gemini. Vector spaces
      between different embedding models are NOT comparable — DocumentEmbeddings
      was empty when this switch was made, so no truncate/re-embed was needed.
      If it ever has rows from another model, TRUNCATE before re-running.
    - text-embedding-3-large returns one embedding per input string, in the
      same order as the input list — no aggregation quirk to work around
      (unlike gemini-embedding-2), and up to 2048 inputs per call.
    - All 8 sources are active (see ACTIVE_SOURCES) — not just Articles.
    - Existing (SourceRecordID, ChunkIndex) pairs are loaded once per source
      into a Python set instead of one SELECT per chunk.

Setup:
    pip install --upgrade pyodbc openai python-dateutil python-dotenv

    Create a .env file in this same folder with:
        OPENAI_API_KEY=...
        SQL_CONN_STR=...

Run:
    python embed_documents.py
"""

import os
import re
import sys
import html
import struct
import time
import pyodbc
from dateutil import parser as dateparser
from dotenv import load_dotenv
from openai import OpenAI, RateLimitError, APIError, APIConnectionError

load_dotenv()  # reads .env in the current working directory into os.environ

# ---------- CONFIG ----------

SQL_CONN_STR = os.environ.get("SQL_CONN_STR") or (
    "DRIVER={ODBC Driver 18 for SQL Server};"
    "SERVER=your-rds-endpoint.rds.amazonaws.com,1433;"
    "DATABASE=your_db_name;"
    "UID=your_username;"
    "PWD=your_password;"
    "Encrypt=yes;TrustServerCertificate=yes;"
)

EMBEDDING_MODEL = "text-embedding-3-large"

# text-embedding-3-large defaults to 3072 dims (best quality). Set to a smaller
# int (e.g. 1024, 1536) to have OpenAI truncate+renormalize server-side and
# save storage, if you don't need max quality.
OUTPUT_DIMENSIONALITY = None  # None = default 3072

MAX_CHUNK_CHARS = 1400
CHUNK_OVERLAP_CHARS = 200
BATCH_SIZE = 100  # chunks per OpenAI call / per DB insert batch (API allows up to 2048 inputs/call)

client = OpenAI(api_key=os.environ["OPENAI_API_KEY"])

# All 8 sources run by default now that the OpenAI switch is in place. Remove
# a name from this list to skip that source on a given run.
ACTIVE_SOURCES = [
    "Articles", "CaseLaws", "Circular", "Legislation",
    "Notifications", "Query", "CLASE_Commentary", "CLASE_Procedure_Details",
]

# ---------- SOURCE QUERIES ----------
# Every query returns the same 13 columns, in this order:
#   RecordID, ParentID, FileName, Label, ContextPrefix, RawText,
#   Category, Subject, Sections, DocTitle, LawTitle, DateStructured, DateRaw
# This lets one processing loop below handle all 8 sources uniformly.
# DateStructured is a real datetime column where the source table has one;
# DateRaw is free text (e.g. "15th June 2026" or just an issue year) used as
# a fallback when no structured date exists. resolve_doc_date() below picks
# whichever is usable.

SOURCE_QUERIES = {
    "Articles": """
        SELECT d.ID, d.Article_ID, d.FileName, CAST(NULL AS NVARCHAR(200)) AS Label,
               CONCAT('Title: ', ISNULL(a.Title,''), ' | Category: ', ISNULL(a.Category,''),
                      ' | Subject: ', ISNULL(a.Subject,''), ' | Sections: ', ISNULL(a.Sections,'')) AS ContextPrefix,
               d.Filetext AS RawText,
               a.Category, a.Subject, a.Sections, a.Title AS DocTitle,
               CAST(NULL AS NVARCHAR(200)) AS LawTitle,
               CAST(NULL AS DATETIME2) AS DateStructured,
               CONCAT(ISNULL(a.IssueMonth,''), ' ', ISNULL(a.IssueYear,'')) AS DateRaw
        FROM dbo.Articles_data_2025 d
        JOIN dbo.Articles_2025 a ON a.ID = d.Article_ID
        WHERE d.Filetext IS NOT NULL
    """,
    "CaseLaws": """
        SELECT d.ID, d.CaseLawID, d.FileName, CAST(NULL AS NVARCHAR(200)) AS Label,
               CONCAT('Versus: ', ISNULL(c.Versus,''), ' | Category: ', ISNULL(c.Category,''),
                      ' | Subject: ', ISNULL(c.Subject,''), ' | Citation: ', ISNULL(c.Citation,''),
                      ' | Judge: ', ISNULL(c.Judge,''), ' | Sections: ', ISNULL(c.Sections,''),
                      -- HeadNote can run to tens of thousands of chars on some rows; this
                      -- header is repeated on EVERY chunk of the row, so it must stay short
                      -- (a full-length HeadNote here blew a CaseLaws batch past OpenAI's
                      -- 300k-tokens-per-request cap). LEFT() to a short teaser only.
                      ' | HeadNote: ', LEFT(ISNULL(c.HeadNote,''), 300)) AS ContextPrefix,
               d.Filetext AS RawText,
               c.Category, c.Subject, c.Sections, c.Versus AS DocTitle,
               CAST(NULL AS NVARCHAR(200)) AS LawTitle,
               c.Judgement_date_new AS DateStructured,
               c.Date_of_Judgement AS DateRaw
        FROM dbo.caselaws_data_2025 d
        JOIN dbo.caselaws_2025 c ON c.id = d.CaseLawID
        WHERE d.Filetext IS NOT NULL
    """,
    "Circular": """
        SELECT d.ID, d.Notification_ID, d.FileName, CAST(NULL AS NVARCHAR(200)) AS Label,
               CONCAT('Title: ', ISNULL(c.Title,''), ' | Category: ', ISNULL(c.Category,''),
                      ' | Subject: ', ISNULL(c.Subject,''), ' | Sections: ', ISNULL(c.Sections,'')) AS ContextPrefix,
               d.Filetext AS RawText,
               c.Category, c.Subject, c.Sections, c.Title AS DocTitle,
               CAST(NULL AS NVARCHAR(200)) AS LawTitle,
               CAST(NULL AS DATETIME2) AS DateStructured,
               c.CircDate AS DateRaw
        FROM dbo.Circular_data_2025 d
        JOIN dbo.Circular_2025 c ON c.id = d.Notification_ID
        WHERE d.Filetext IS NOT NULL
    """,
    "Legislation": """
        SELECT d.ID, d.Legislation_ID, d.FileName, CAST(NULL AS NVARCHAR(200)) AS Label,
               CONCAT('Title: ', ISNULL(l.Title,''), ' | Category: ', ISNULL(l.Category,''),
                      ' | Subject: ', ISNULL(l.Subject,''), ' | Chapter: ', ISNULL(l.ChapterHeading,''),
                      ' | Sections: ', ISNULL(l.Sections,'')) AS ContextPrefix,
               d.Filetext AS RawText,
               l.Category, l.Subject, l.Sections, l.Title AS DocTitle,
               l.Legislation AS LawTitle,
               CAST(NULL AS DATETIME2) AS DateStructured,
               CAST(l.IssueYear AS NVARCHAR(10)) AS DateRaw
        FROM dbo.legislation_data_2025 d
        JOIN dbo.Legislation_2025 l ON l.id = d.Legislation_ID
        WHERE d.Filetext IS NOT NULL
    """,
    "Notifications": """
        SELECT d.ID, d.Notification_ID, d.FileName, CAST(NULL AS NVARCHAR(200)) AS Label,
               CONCAT('Title: ', ISNULL(n.Title,''), ' | Category: ', ISNULL(n.Category,''),
                      ' | Subject: ', ISNULL(n.Subject,''), ' | Sections: ', ISNULL(n.Sections,'')) AS ContextPrefix,
               d.Filetext AS RawText,
               n.Category, n.Subject, n.Sections, n.Title AS DocTitle,
               CAST(NULL AS NVARCHAR(200)) AS LawTitle,
               CAST(NULL AS DATETIME2) AS DateStructured,
               n.NotificationDate AS DateRaw
        FROM dbo.notifications_data_2025 d
        JOIN dbo.notifications_2025 n ON n.Id = d.Notification_ID
        WHERE d.Filetext IS NOT NULL
    """,
    "Query": """
        SELECT d.ID, d.Query_ID, d.FileName, CAST(NULL AS NVARCHAR(200)) AS Label,
               CONCAT('Title: ', ISNULL(q.Title,''), ' | Subject: ', ISNULL(q.Subject,''),
                      ' | Topics: ', ISNULL(q.Topics,''), ' | Sections: ', ISNULL(q.Sections,'')) AS ContextPrefix,
               d.Filetext AS RawText,
               CAST(NULL AS NVARCHAR(510)) AS Category, q.Subject, q.Sections, q.Title AS DocTitle,
               CAST(NULL AS NVARCHAR(200)) AS LawTitle,
               CAST(NULL AS DATETIME2) AS DateStructured,
               q.IssueYear AS DateRaw
        FROM dbo.query_data d
        JOIN dbo.Query q ON q.ID = d.Query_ID
        WHERE d.Filetext IS NOT NULL
    """,
    "CLASE_Commentary": """
        SELECT cm.ID, cm.commentary_ActID, CAST(NULL AS NVARCHAR(200)) AS FileName, cm.Section AS Label,
               CONCAT('Title: ', ISNULL(cm.Title,''), ' | Act: ', ISNULL(act.Title,'')) AS ContextPrefix,
               cm.Commentary_Details AS RawText,
               CAST(NULL AS NVARCHAR(510)) AS Category, CAST(NULL AS NVARCHAR(510)) AS Subject,
               cm.Section AS Sections, cm.Title AS DocTitle,
               act.Title AS LawTitle,
               cm.Inserted_Date AS DateStructured,
               CAST(NULL AS NVARCHAR(200)) AS DateRaw
        FROM dbo.CLASE_Commentary cm
        LEFT JOIN dbo.CLASE_Commentary_Act act ON act.ID = cm.commentary_ActID
        WHERE cm.Commentary_Details IS NOT NULL AND cm.IsActive = 1
        -- IsActive filter kept here (column still exists on this table) to
        -- avoid embedding withdrawn/inactive commentary.
    """,
    "CLASE_Procedure_Details": """
        SELECT p.ID, CAST(NULL AS INT) AS ParentID, CAST(NULL AS NVARCHAR(200)) AS FileName, p.Heading AS Label,
               CONCAT('Title: ', ISNULL(p.Title,''), ' | Law: ', ISNULL(p.LawTitle,'')) AS ContextPrefix,
               CONCAT(ISNULL(p.[Procedure],''),
                      CASE WHEN p.Resolution IS NOT NULL AND LEN(p.Resolution) > 0
                           THEN CONCAT(CHAR(13), CHAR(13), 'Resolution: ', p.Resolution)
                           ELSE '' END) AS RawText,
               CAST(NULL AS NVARCHAR(510)) AS Category, CAST(NULL AS NVARCHAR(510)) AS Subject,
               CAST(NULL AS NVARCHAR(200)) AS Sections, p.Title AS DocTitle,
               p.LawTitle AS LawTitle,
               CAST(NULL AS DATETIME2) AS DateStructured,
               CAST(NULL AS NVARCHAR(200)) AS DateRaw
        FROM dbo.CLASE_Procedure_Details_2025 p
        WHERE p.[Procedure] IS NOT NULL OR p.Resolution IS NOT NULL
        -- NOTE: no IsActive filter here — the column was dropped from this
        -- table (see DATA_DICTIONARY.md open item #2). Add it back if the
        -- column is restored.
        -- NOTE: no Inserted_Date column either on this table, unlike
        -- CLASE_Commentary — DateStructured is always NULL for this source.
    """,
}

# ---------- HTML / TEXT CLEANING ----------

def strip_html(text):
    """Remove HTML tags (keeping enclosed text) and decode entities like &nbsp;/&lsquo;."""
    if not text:
        return text
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


def resolve_doc_date(date_structured, date_raw):
    """Prefer a real datetime column; fall back to parsing free text (handles
    ordinals like '15th June 2026' and bare years like '2018'). Returns None
    if neither is usable — better an honest NULL than a wrong date."""
    if date_structured:
        return date_structured
    if date_raw and str(date_raw).strip():
        cleaned = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", str(date_raw), flags=re.IGNORECASE)
        try:
            return dateparser.parse(cleaned, fuzzy=True, default=None)
        except (ValueError, OverflowError):
            return None
    return None

# ---------- CHUNKING ----------

SECTION_MARKER_RE = re.compile(
    r"(?=(?:\A|\n)[ \t]*(?:Section|Sec\.?|Clause|Article|Chapter)\s+[0-9IVXLCM]+[A-Za-z]?\b)",
    re.IGNORECASE,
)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def split_by_structure(text):
    pieces = SECTION_MARKER_RE.split(text)
    pieces = [p.strip() for p in pieces if p and p.strip()]

    if len(pieces) < 2:
        stripped = text.strip()
        label = stripped.split("\n", 1)[0][:80].strip() if re.match(
            r"^\s*(?:Section|Sec\.?|Clause|Article|Chapter)\s+[0-9IVXLCM]+[A-Za-z]?\b",
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
    """override_label: use this label as-is (skip structure detection) when the
    source table already provides a clean one (e.g. CLASE_Commentary.Section)."""
    if not text or not text.strip():
        return []

    sections = [(override_label, text.strip())] if override_label else split_by_structure(text)
    final_chunks = []
    for label, body in sections:
        for piece in recursive_split(body):
            final_chunks.append((label, piece))
    return final_chunks


MAX_CONTEXT_PREFIX_CHARS = 500  # safety cap: this header is repeated on EVERY chunk of a
# row, so one oversized metadata field (e.g. a 27k-char HeadNote seen on one CaseLaws row)
# must never reach it uncapped, even if a future source query forgets to LEFT() it in SQL.


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

# ---------- EMBEDDING ----------

def prepare_document_text(content, title=None):
    """OpenAI's embedding models have no task_type / asymmetric-retrieval format
    (unlike gemini-embedding-2) — the raw text is embedded as-is. Kept as a
    passthrough function (instead of inlining) so search_documents.py's
    embed_query() has an obvious symmetric counterpart to point at."""
    return content


def _extract_retry_delay(error, default=20):
    """Pull the server-suggested wait time out of a 429 response if present
    (OpenAI sends a Retry-After header), else fall back to a flat default."""
    try:
        retry_after = error.response.headers.get("retry-after")
        if retry_after:
            return float(retry_after)
    except AttributeError:
        pass
    return default


def embed_chunks_batch(texts, retries=5):
    """Embed a list of texts as ONE call. OpenAI's embeddings API returns one
    embedding per input string, in the same input order — no aggregation
    quirk to work around here (up to 2048 inputs per call)."""
    kwargs = {"model": EMBEDDING_MODEL, "input": texts}
    if OUTPUT_DIMENSIONALITY:
        kwargs["dimensions"] = OUTPUT_DIMENSIONALITY

    for attempt in range(retries):
        try:
            result = client.embeddings.create(**kwargs)
            vectors = [d.embedding for d in result.data]
            if len(vectors) != len(texts):
                raise RuntimeError(
                    f"Expected {len(texts)} embeddings back, got {len(vectors)}."
                )
            return vectors
        except RateLimitError as e:
            wait = _extract_retry_delay(e, default=2 ** attempt * 5)
            print(f"    rate limited (attempt {attempt + 1}/{retries}): retrying in {wait:.0f}s")
            time.sleep(wait)
        except (APIError, APIConnectionError) as e:
            wait = 2 ** attempt
            print(f"    embed error (attempt {attempt + 1}/{retries}): {e} -- retrying in {wait:.0f}s")
            time.sleep(wait)
    raise RuntimeError("Embedding failed after retries")


def vector_to_bytes(vector):
    return struct.pack(f"{len(vector)}f", *vector)

# ---------- DB ----------

def load_existing_keys(cur, source_name):
    """One query per source instead of one per chunk."""
    cur.execute(
        "SELECT SourceRecordID, ChunkIndex FROM dbo.DocumentEmbeddings WHERE SourceTable = ?",
        source_name,
    )
    return {(row[0], row[1]) for row in cur.fetchall()}


INSERT_SQL = """
    INSERT INTO dbo.DocumentEmbeddings
        (SourceTable, SourceRecordID, ParentID, FileName, ChunkIndex,
         ChunkText, Embedding, EmbeddingModel, EmbeddingDim,
         Category, Subject, Sections, DocTitle, LawTitle, DocDate)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
"""


def process_source(cnx, source_name, query):
    read_cur = cnx.cursor()
    read_cur.execute(query)
    rows = read_cur.fetchall()
    print(f"\n{source_name}: {len(rows)} rows to process")

    write_cur = cnx.cursor()
    existing_keys = load_existing_keys(write_cur, source_name)

    # Build the full list of pending (not-yet-embedded) chunks for this source first,
    # so embedding + inserting can happen in batches rather than per chunk.
    pending = []
    for row in rows:
        (record_id, parent_id, filename, sql_label, context_prefix, raw_text,
         category, subject, sections, doc_title, law_title, date_structured, date_raw) = row

        clean_text = strip_html(raw_text)
        chunks = build_chunks(clean_text, override_label=sql_label)
        doc_date = resolve_doc_date(date_structured, date_raw)

        for idx, (label, chunk_body) in enumerate(chunks):
            if (record_id, idx) in existing_keys:
                continue
            enriched_text = with_context_prefix(source_name, context_prefix, filename, label, chunk_body)
            embed_text = prepare_document_text(enriched_text, title=doc_title or source_name)
            pending.append({
                "record_id": record_id, "parent_id": parent_id, "filename": filename,
                "idx": idx, "stored_text": enriched_text, "embed_text": embed_text,
                "category": category, "subject": subject, "sections": sections,
                "doc_title": doc_title, "law_title": law_title, "doc_date": doc_date,
            })

    print(f"  {len(pending)} new chunk(s) to embed")

    for batch_start in range(0, len(pending), BATCH_SIZE):
        batch = pending[batch_start:batch_start + BATCH_SIZE]
        vectors = embed_chunks_batch([item["embed_text"] for item in batch])

        insert_rows = []
        for item, vector in zip(batch, vectors):
            insert_rows.append((
                # ChunkText stores the clean contextual-prefix version; the
                # embed_text sent to the API (see prepare_document_text) is
                # currently identical, but kept separate in case that changes.
                source_name, item["record_id"], item["parent_id"], item["filename"], item["idx"],
                item["stored_text"], vector_to_bytes(vector), EMBEDDING_MODEL, len(vector),
                item["category"], item["subject"], item["sections"],
                item["doc_title"], item["law_title"], item["doc_date"],
            ))
        write_cur.executemany(INSERT_SQL, insert_rows)
        cnx.commit()
        print(f"  inserted {len(insert_rows)} chunk(s) "
              f"({batch_start + len(insert_rows)}/{len(pending)})")


def count_chunks_only():
    """Dry run: read + chunk everything, print exact counts per source, skip
    embedding entirely. No API calls are made, so this finishes in well under
    a minute and tells you exactly how many chunks the real run will embed."""
    cnx = pyodbc.connect(SQL_CONN_STR)
    try:
        grand_total = 0
        for source_name, query in SOURCE_QUERIES.items():
            if source_name not in ACTIVE_SOURCES:
                continue
            cur = cnx.cursor()
            cur.execute(query)
            rows = cur.fetchall()
            total = 0
            for row in rows:
                raw_text = row[5]  # RawText is always column index 5
                clean_text = strip_html(raw_text)
                sql_label = row[3]  # Label is always column index 3
                total += len(build_chunks(clean_text, override_label=sql_label))
            print(f"{source_name}: {len(rows)} rows -> {total} chunks")
            grand_total += total
        print(f"\nTOTAL: {grand_total} chunks")
        est_calls = grand_total / BATCH_SIZE
        print(f"At {BATCH_SIZE} chunks/call: ~{est_calls:.0f} API calls "
              f"(actual time depends on your OpenAI rate-limit tier)")
    finally:
        cnx.close()


def main():
    cnx = pyodbc.connect(SQL_CONN_STR)
    try:
        for source_name, query in SOURCE_QUERIES.items():
            if source_name not in ACTIVE_SOURCES:
                print(f"Skipping {source_name} (not in ACTIVE_SOURCES)")
                continue
            process_source(cnx, source_name, query)
    finally:
        cnx.close()
    print("\nDone.")


if __name__ == "__main__":
    if "--count-only" in sys.argv:
        count_chunks_only()
    else:
        main()