"""
Bulk-embed legal documents from SQL Server into DocumentEmbeddings.

Covers 8 content sources across your 15 tables:
    Articles, CaseLaws, Circular, Legislation, Notifications, Query
    (each: a "_data" child table joined to its parent table for context)
    CLASE_Commentary  (joined to CLASE_Commentary_Act for the Act name)
    CLASE_Procedure_Details_2025 (Procedure + Resolution combined)

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
    - Uses gemini-embedding-2, not gemini-embedding-001. The two models' vector
      spaces are NOT comparable — if you ever embedded anything with 001, you
      must TRUNCATE and fully re-embed, not mix the two in one table.
    - gemini-embedding-2 has no task_type parameter; task instructions go into
      the text itself. Documents are formatted as 'title: {title} | text: {content}'
      before being sent to the API (see prepare_document_text()) — the stored
      ChunkText stays clean, only the embedding call sees the wrapped version.
    - Gemini embedding calls and DB inserts are now batched (BATCH_SIZE chunks
      at a time). Each chunk is wrapped in its own types.Content object, because
      gemini-embedding-2 aggregates a plain list of strings into ONE embedding
      instead of returning one per string (see embed_chunks_batch()).
    - Existing (SourceRecordID, ChunkIndex) pairs are loaded once per source
      into a Python set instead of one SELECT per chunk.

Setup:
    pip install --upgrade pyodbc google-genai python-dateutil python-dotenv
    # --upgrade matters: gemini-embedding-2 is recent (April 2026), an older
    # cached google-genai package may not know the model name yet.

    Create a .env file in this same folder (see .env.example) with:
        GEMINI_API_KEY=...
        SQL_CONN_STR=...
    The script loads it automatically via load_dotenv() below — no need to
    `set`/`export` these manually, though that still works too if you'd rather
    not use a .env file (real environment variables take priority over .env).

Before running for the first time against this schema version, run
schema_upgrade.sql once (adds the new columns + indexes).

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
from google import genai
from google.genai import types

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

GEMINI_MODEL = "gemini-embedding-2"

# gemini-embedding-2 defaults to 3072 dims (best quality, auto-normalized).
# Set to 768 or 1536 to save storage if you don't need max quality —
# both are auto-normalized by this model, unlike gemini-embedding-001.
OUTPUT_DIMENSIONALITY = None  # None = default 3072

MAX_CHUNK_CHARS = 1400
CHUNK_OVERLAP_CHARS = 200
BATCH_SIZE = 16  # chunks per Gemini call / per DB insert batch

client = genai.Client(api_key=os.environ["GEMINI_API_KEY"])

# Only these sources actually run. All 8 queries stay fully defined below so
# nothing has to be rewritten later — just add names back here (e.g. "CaseLaws",
# "Circular", ...) once Articles is confirmed working end-to-end in your product.
ACTIVE_SOURCES = ["Articles"]

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
                      ' | HeadNote: ', ISNULL(c.HeadNote,'')) AS ContextPrefix,
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
               n.NotificationDate_new AS DateStructured,
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
               p.Inserted_Date AS DateStructured,
               CAST(NULL AS NVARCHAR(200)) AS DateRaw
        FROM dbo.CLASE_Procedure_Details_2025 p
        WHERE p.[Procedure] IS NOT NULL OR p.Resolution IS NOT NULL
        -- NOTE: no IsActive filter here — the column was dropped from this
        -- table (see DATA_DICTIONARY.md open item #2). Add it back if the
        -- column is restored.
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


def with_context_prefix(source_name, context_prefix, filename, label, chunk_body):
    parts = [source_name]
    if context_prefix:
        parts.append(context_prefix)
    if filename:
        parts.append(f"File: {filename}")
    if label:
        parts.append(f"Section: {label}")
    header = "[" + " | ".join(parts) + "]\n"
    return header + chunk_body

# ---------- EMBEDDING ----------

# Free-tier gemini-embedding-2 quota is 100 embedded items/minute per project —
# NOT 100 API calls/minute. Batching 16 chunks into one HTTP call still charges
# 16 units against this quota (confirmed empirically: a run failed at exactly
# 96/100 after 6 batches of 16, on the 7th call). So throttling must track
# item count in the rolling window, not call count.
ITEMS_PER_MINUTE_QUOTA = 90  # stay under the real 100 ceiling, leave headroom
_usage_log = []  # list of (timestamp, item_count)


def _throttle(n_items):
    """Block until sending n_items more would keep the trailing-60s total <= quota."""
    now = time.monotonic()
    window_start = now - 60
    while _usage_log and _usage_log[0][0] < window_start:
        _usage_log.pop(0)
    used = sum(n for _, n in _usage_log)
    if used + n_items > ITEMS_PER_MINUTE_QUOTA:
        sleep_for = (_usage_log[0][0] + 60 - now) if _usage_log else 5
        sleep_for = max(sleep_for, 1)
        print(f"    throttling: {used}/{ITEMS_PER_MINUTE_QUOTA} items used this minute, "
              f"sleeping {sleep_for:.1f}s")
        time.sleep(sleep_for)
        return _throttle(n_items)  # re-check after sleeping
    _usage_log.append((time.monotonic(), n_items))


def _extract_retry_delay(error_text, default=20):
    """Pull the server-suggested wait time out of a 429 error message
    (e.g. "Please retry in 42.6s" or a retryDelay field like '39s')."""
    match = re.search(r"retry(?:Delay)?['\"]?\s*[:=]?\s*'?(\d+(?:\.\d+)?)", str(error_text), re.IGNORECASE)
    return float(match.group(1)) if match else default


def prepare_document_text(content, title=None):
    """gemini-embedding-2 has no task_type parameter (unlike gemini-embedding-001) —
    task instructions go directly in the text instead. This is the documented
    asymmetric-retrieval document format: 'title: {title} | text: {content}'.
    The matching query-side format ('task: search result | query: {q}') belongs
    in search_documents.py's embed_query(), not here — flagging so it isn't
    forgotten when that file gets updated."""
    return f"title: {title or 'none'} | text: {content}"


def embed_chunks_batch(texts, retries=5):
    """Embed a list of texts as ONE call, one embedding per text.

    IMPORTANT: gemini-embedding-2 changed behavior vs. gemini-embedding-001 here.
    Passing a plain list of strings as `contents` makes gemini-embedding-2
    return a single AGGREGATED embedding for the whole list, not one per string
    (that's the documented "embedding aggregation" feature, meant for e.g.
    combining a text+image pair into one post-level embedding). To get back to
    "one embedding per input" — which is what a chunked-document pipeline needs —
    each input must be wrapped in its own types.Content object.
    """
    contents = [types.Content(parts=[types.Part.from_text(text=t)]) for t in texts]
    config = types.EmbedContentConfig(output_dimensionality=OUTPUT_DIMENSIONALITY) \
        if OUTPUT_DIMENSIONALITY else None

    for attempt in range(retries):
        _throttle(len(texts))
        try:
            result = client.models.embed_content(model=GEMINI_MODEL, contents=contents, config=config)
            vectors = [e.values for e in result.embeddings]
            if len(vectors) != len(texts):
                raise RuntimeError(
                    f"Expected {len(texts)} embeddings back, got {len(vectors)} — "
                    "check that each input is still wrapped in its own Content object."
                )
            return vectors
        except Exception as e:
            is_rate_limit = "RESOURCE_EXHAUSTED" in str(e) or "429" in str(e)
            wait = _extract_retry_delay(e) + 2 if is_rate_limit else 2 ** attempt
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
                # ChunkText stores the clean contextual-prefix version (no 'title: ... | text: ...'
                # wrapper) so it reads naturally when shown to a user or fed to the LLM later.
                # The wrapper only mattered for the embedding call itself.
                source_name, item["record_id"], item["parent_id"], item["filename"], item["idx"],
                item["stored_text"], vector_to_bytes(vector), GEMINI_MODEL, len(vector),
                item["category"], item["subject"], item["sections"],
                item["doc_title"], item["law_title"], item["doc_date"],
            ))
        write_cur.executemany(INSERT_SQL, insert_rows)
        cnx.commit()
        print(f"  inserted {len(insert_rows)} chunk(s) "
              f"({batch_start + len(insert_rows)}/{len(pending)})")


def count_chunks_only():
    """Dry run: read + chunk everything, print exact counts per source, skip
    embedding entirely. No rate limits apply since no API calls are made —
    this finishes in well under a minute and tells you exactly how long the
    real run will take at your current ITEMS_PER_MINUTE_QUOTA."""
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
        print(f"At {ITEMS_PER_MINUTE_QUOTA} items/min throttle: "
              f"~{grand_total / ITEMS_PER_MINUTE_QUOTA:.0f} minutes "
              f"(~{grand_total / ITEMS_PER_MINUTE_QUOTA / 60:.1f} hours)")
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