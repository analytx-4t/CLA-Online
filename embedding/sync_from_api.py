"""
sync_from_api.py

Incremental sync of the CLA Online content API into the structured Pinecone index
('cla-online-db'). Runs unattended every night (started by the backend scheduler in
backend/dbSync/service.js) and on demand from the admin dashboard's Database Refresh page.

What one run does, per source (Articles, CaseLaws, Circular, Legislation, Notifications, Query):
  1. Lists every record the API exposes (Search* endpoints, 200 per page).
  2. Works out which records are not in Pinecone yet (local cache of known IDs, backed by a
     metadata-filtered Pinecone query for anything the cache has not seen).
  3. Downloads the full text of only those records (Get* endpoints), chunks it with the SAME
     structure-aware chunker the original bulk load used, embeds the chunks with the same
     OpenAI model/dimensions as the existing vectors, and upserts them with the same
     ID scheme ('{source}|{record_id}|{chunk_index}') and metadata layout.
  4. Re-embeds records whose UpdateDate moved since the previous run, but only when their
     text actually changed.
  5. Verifies the new vectors are queryable before remembering them as done.

The run is idempotent: vector IDs are deterministic, so re-running never duplicates data.
CLASE_Commentary and CLASE_Procedure_Details have no API endpoint and are left untouched.

Usage:
    python embedding/sync_from_api.py                 # normal run
    python embedding/sync_from_api.py --dry-run       # report what would be added, write nothing
    python embedding/sync_from_api.py --sources CaseLaws,Query --limit 5
    python embedding/sync_from_api.py --reverify      # ignore the local cache, re-check Pinecone
"""

import argparse
import html
import json
import math
import os
import re
import signal
import sys
import threading
import time
import traceback
import uuid
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx
from dotenv import load_dotenv
from openai import OpenAI, RateLimitError, APIError, APIConnectionError
from pinecone import Pinecone

try:
    from dateutil import parser as dateparser
except ImportError:  # only used to parse free-text dates when the API has no structured date
    dateparser = None

_HERE =os.path.dirname(os.path.abspath(__file__))
_ROOT = os.path.dirname(_HERE)

# Root .env first (same file search_documents.py reads), then backend/.env as a fallback.
for _env in (os.path.join(_ROOT, ".env"), os.path.join(_ROOT, "backend", ".env")):
    if os.path.exists(_env):
        load_dotenv(_env)

# ---------- CONFIGURATION ----------

CLA_API_BASE_URL = os.getenv("CLA_API_BASE_URL", "http://demo.claonline.in/WebService/ClaOnlineApi.asmx").rstrip("/")
CLA_API_CLIENT_ID = os.getenv("CLA_API_CLIENT_ID", "")
CLA_API_CLIENT_SECRET = os.getenv("CLA_API_CLIENT_SECRET", "")
# The API serialises its SQL Server local timestamps (IST) as epoch milliseconds.
CLA_API_UTC_OFFSET_MINUTES = int(os.getenv("CLA_API_UTC_OFFSET_MINUTES", "330"))

PINECONE_API_KEY = os.getenv("PINECONE_API_KEY", "")
PINECONE_DB_INDEX_NAME = os.getenv("PINECONE_DB_INDEX_NAME", "cla-online-db")

EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "text-embedding-3-small")
EMBEDDING_DIMENSIONS = int(os.getenv("EMBEDDING_DIMENSIONS", "1536"))

API_PAGE_SIZE = 200          # the API caps PageSize at 200
API_WORKERS = int(os.getenv("CLA_SYNC_WORKERS", "6"))
EMBED_BATCH_SIZE = 100       # chunks per OpenAI embedding request
UPSERT_BATCH_SIZE = 50       # vectors per Pinecone upsert (keeps requests under 2 MB)
DETAIL_SLICE = 40            # records downloaded + embedded together
MAX_UPDATES_PER_RUN = int(os.getenv("CLA_SYNC_MAX_UPDATES", "1000"))
VERIFY_ATTEMPTS = 8
VERIFY_WAIT_SECONDS = 8

STATE_DIR = os.getenv("CLA_SYNC_STATE_DIR") or os.path.join(_HERE, "sync_state")
STATE_PATH = os.path.join(STATE_DIR, "state.json")
STATUS_PATH = os.path.join(STATE_DIR, "status.json")
HISTORY_PATH = os.path.join(STATE_DIR, "history.json")
LOCK_PATH = os.path.join(STATE_DIR, "sync.lock")
LOG_DIR = os.path.join(STATE_DIR, "logs")
HISTORY_LIMIT = 60
LOCK_STALE_SECONDS = 600
LOCK_HEARTBEAT_SECONDS = 20

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_ALREADY_RUNNING = 2
EXIT_COMPLETED_WITH_ERRORS = 3

# ---------- TEXT CLEANING, DATES & CHUNKING ----------
# Kept identical to embeded_documents.py (the pipeline that produced the vectors already in
# the index) so new chunks are indistinguishable from the existing ones. That module is not
# imported because it needs psycopg2 and a Postgres connection, which this job does not.

MAX_CHUNK_CHARS = 1400
CHUNK_OVERLAP_CHARS = 200
MAX_CONTEXT_PREFIX_CHARS = 500


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
    if dateparser is not None and date_raw and str(date_raw).strip():
        cleaned = re.sub(r"(\d+)(st|nd|rd|th)\b", r"\1", str(date_raw), flags=re.IGNORECASE)
        try:
            return dateparser.parse(cleaned, fuzzy=True, default=None)
        except Exception:
            return None
    return None


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


# ---------- API FIELD MAPPING ----------
# Each mapper turns one Get* response into the same row shape the original SQL queries
# produced (SOURCE_QUERIES in embeded_documents.py / CASELAWS_FIXED_QUERY in
# transfer_to_pinecone.py), so the rest of the pipeline is unchanged.

_API_DATE_RE = re.compile(r"/Date\((-?\d+)")


def api_epoch_ms(value):
    """'/Date(1326175380000)/' -> 1326175380000 (None when absent)."""
    if not value:
        return None
    match = _API_DATE_RE.search(str(value))
    return int(match.group(1)) if match else None


def api_datetime(value):
    """API epoch milliseconds -> naive datetime in the source database's local time,
    which is how the bulk load stored doc_date."""
    ms = api_epoch_ms(value)
    if ms is None:
        return None
    return datetime(1970, 1, 1) + timedelta(milliseconds=ms, minutes=CLA_API_UTC_OFFSET_MINUTES)


def normalise_newlines(value):
    """The API returns Windows line endings; the vectors already in the index were built
    from LF text. Without this, chunk boundaries (and paragraph detection) would differ."""
    if isinstance(value, str):
        return value.replace("\r\n", "\n").replace("\r", "\n")
    if isinstance(value, dict):
        return {k: normalise_newlines(v) for k, v in value.items()}
    if isinstance(value, list):
        return [normalise_newlines(v) for v in value]
    return value


def _c(value):
    """SQL COALESCE(value, '')."""
    return "" if value is None else str(value)


def _text(value):
    return value if isinstance(value, str) and value.strip() else None


def _map_article(data):
    parent, content = data.get("Article") or {}, data.get("Content") or {}
    raw = _text(content.get("Filetext"))
    if not parent or raw is None:
        return None
    return {
        "record_id": content["ID"], "parent_id": parent["ID"], "file_name": content.get("FileName"),
        "label": None,
        "context_prefix": (f"Title: {_c(parent.get('Title'))} | Category: {_c(parent.get('Category'))}"
                           f" | Subject: {_c(parent.get('Subject'))} | Sections: {_c(parent.get('Sections'))}"),
        "raw_text": raw,
        "category": parent.get("Category"), "subject": parent.get("Subject"), "sections": parent.get("Sections"),
        "doc_title": parent.get("Title"), "law_title": None,
        "date_structured": api_datetime(parent.get("InsertedDate")),
        "date_raw": f"{_c(parent.get('IssueMonth'))} {_c(parent.get('IssueYear'))}",
    }


def _map_caselaw(data):
    parent, content = data.get("CaseLaw") or {}, data.get("Content") or {}
    raw = _text(content.get("Filetext")) or _text(parent.get("HeadNote"))
    if not parent or raw is None:
        return None
    return {
        "record_id": parent["id"], "parent_id": parent["id"],
        "file_name": content.get("FileName") or parent.get("FileName"),
        "label": None,
        "context_prefix": (f"Versus: {_c(parent.get('Versus'))} | Category: {_c(parent.get('Category'))}"
                           f" | Subject: {_c(parent.get('Subject'))} | Citation: {_c(parent.get('Citation'))}"
                           f" | Judge: {_c(parent.get('Judge'))} | Court: {_c(parent.get('CourtName'))}"
                           f" | Sections: {_c(parent.get('Sections'))}"),
        "raw_text": raw,
        "category": parent.get("Category"), "subject": parent.get("Subject"), "sections": parent.get("Sections"),
        "doc_title": parent.get("Versus"), "law_title": None,
        "date_structured": api_datetime(parent.get("Judgement_date_new")),
        "date_raw": parent.get("Date_of_Judgement"),
    }


def _map_circular(data):
    parent, content = data.get("Circular") or {}, data.get("Content") or {}
    raw = _text(content.get("Filetext"))
    if not parent or raw is None:
        return None
    return {
        "record_id": content["ID"], "parent_id": parent["id"], "file_name": content.get("FileName"),
        "label": None,
        "context_prefix": (f"Title: {_c(parent.get('Title'))} | Category: {_c(parent.get('Category'))}"
                           f" | Subject: {_c(parent.get('Subject'))} | Sections: {_c(parent.get('Sections'))}"),
        "raw_text": raw,
        "category": parent.get("Category"), "subject": parent.get("Subject"), "sections": parent.get("Sections"),
        "doc_title": parent.get("Title"), "law_title": None,
        "date_structured": api_datetime(parent.get("CircDate_new")),
        "date_raw": parent.get("CircDate"),
    }


def _common(rows, field, require_uniform=False):
    """Most frequent non-empty value of a field across a file's section rows."""
    values = [html.unescape(str(r[field])).strip() for r in rows if r.get(field) not in (None, "")]
    values = [v for v in values if v]
    if not values or (require_uniform and len(set(values)) > 1):
        return None
    return Counter(values).most_common(1)[0][0]


def _map_legislation(data, rows):
    """Legislation is modelled differently from the other sources: the listing has one row
    per SECTION, and the text is stored once per FILE, keyed by the rows' FileID (not by the
    row id). `data` is GetLegislation(FileID) and `rows` are all section rows of that file,
    which is where the title/chapter metadata comes from. The filename check guarantees a
    text is never labelled with another Act's title."""
    content = data.get("Content") or {}
    raw = _text(content.get("Filetext"))
    if raw is None or not rows:
        return None
    content_file = _c(content.get("FileName")).strip().lower()
    if not content_file or content_file not in {_c(r.get("Filename")).strip().lower() for r in rows}:
        return None
    title, category, subject = _common(rows, "Title"), _common(rows, "Category"), _common(rows, "Subject")
    chapter = _common(rows, "ChapterHeading", require_uniform=True)
    sections = _common(rows, "Sections", require_uniform=True)
    inserted = [api_datetime(r.get("InsertedDate")) for r in rows if r.get("InsertedDate")]
    return {
        "record_id": content["ID"], "parent_id": content["Legislation_ID"], "file_name": content.get("FileName"),
        "label": None,
        "context_prefix": (f"Title: {_c(title)} | Category: {_c(category)} | Subject: {_c(subject)}"
                           f" | Chapter: {_c(chapter)} | Sections: {_c(sections)}"),
        "raw_text": raw,
        "category": category, "subject": subject, "sections": sections,
        # The API exposes the Legislation_2025."Legislation" column as LegislationNo.
        "doc_title": title, "law_title": _common(rows, "LegislationNo"),
        "date_structured": min(inserted) if inserted else None,
        "date_raw": _common(rows, "IssueYear"),
    }


def _map_notification(data):
    parent, content = data.get("Notification") or {}, data.get("Content") or {}
    raw = _text(content.get("Filetext"))
    if not parent or raw is None:
        return None
    return {
        "record_id": content["ID"], "parent_id": parent["Id"], "file_name": content.get("FileName"),
        "label": None,
        "context_prefix": (f"Title: {_c(parent.get('Title'))} | Category: {_c(parent.get('Category'))}"
                           f" | Subject: {_c(parent.get('Subject'))} | Sections: {_c(parent.get('Sections'))}"),
        "raw_text": raw,
        "category": parent.get("Category"), "subject": parent.get("Subject"), "sections": parent.get("Sections"),
        "doc_title": parent.get("Title"), "law_title": None,
        "date_structured": api_datetime(parent.get("NotificationDate_new")),
        "date_raw": parent.get("NotificationDate"),
    }


def _map_query(data):
    parent, content = data.get("Query") or {}, data.get("Content") or {}
    raw = _text(content.get("Filetext"))
    if not parent or raw is None:
        return None
    return {
        "record_id": content["ID"], "parent_id": parent["ID"], "file_name": content.get("FileName"),
        "label": None,
        "context_prefix": (f"Title: {_c(parent.get('Title'))} | Subject: {_c(parent.get('Subject'))}"
                           f" | Topics: {_c(parent.get('Topics'))} | Sections: {_c(parent.get('Sections'))}"),
        "raw_text": raw,
        "category": None, "subject": parent.get("Subject"), "sections": parent.get("Sections"),
        "doc_title": parent.get("Title"), "law_title": None,
        "date_structured": api_datetime(parent.get("InsertedDate")),
        "date_raw": parent.get("IssueYear"),
    }


# Keys are the source_table values already used in Pinecone.
SOURCES = {
    "Articles": {"search_op": "SearchArticles", "get_op": "GetArticle", "id_field": "ID", "map": _map_article},
    "CaseLaws": {"search_op": "SearchCaseLaws", "get_op": "GetCaseLaw", "id_field": "id", "map": _map_caselaw},
    "Circular": {"search_op": "SearchCirculars", "get_op": "GetCircular", "id_field": "id", "map": _map_circular},
    "Legislation": {"search_op": "SearchLegislations", "get_op": "GetLegislation", "id_field": "FileID",
                    "map": _map_legislation, "grouped": True},
    "Notifications": {"search_op": "SearchNotifications", "get_op": "GetNotification", "id_field": "Id",
                      "map": _map_notification},
    "Query": {"search_op": "SearchQueries", "get_op": "GetQuery", "id_field": "ID", "map": _map_query},
}
SOURCE_ORDER = ["Articles", "CaseLaws", "Circular", "Legislation", "Notifications", "Query"]


def build_record_vectors(source_name, row):
    """One API record -> list of {'id', 'text', 'metadata'} (no embeddings yet)."""
    clean_text = strip_html(row["raw_text"])
    chunks = build_chunks(clean_text, override_label=row["label"])
    doc_date = resolve_doc_date(row["date_structured"], row["date_raw"])
    items = []
    for idx, (label, chunk_body) in enumerate(chunks):
        stored_text = with_context_prefix(source_name, row["context_prefix"], row["file_name"], label, chunk_body)
        items.append({
            "id": f"{source_name}|{row['record_id']}|{idx}",
            "text": stored_text,
            "metadata": build_metadata(source_name, row, idx, stored_text, doc_date),
        })
    return items


def build_metadata(source_name, row, idx, stored_text, doc_date):
    meta = {
        "source_table": source_name,
        "record_id": int(row["record_id"]),
        "chunk_index": int(idx),
        "chunk_text": stored_text,
        "embedding_model": EMBEDDING_MODEL,
    }
    if row["parent_id"] is not None:
        meta["parent_id"] = int(row["parent_id"])
    if row["file_name"]:
        meta["file_name"] = str(row["file_name"])
    if row["category"]:
        meta["category"] = str(row["category"])
    if row["subject"]:
        meta["subject"] = str(row["subject"])
    if row["sections"]:
        meta["sections"] = str(row["sections"])
    if row["doc_title"]:
        meta["doc_title"] = str(row["doc_title"])
    if row["law_title"]:
        meta["law_title"] = str(row["law_title"])
    if doc_date:
        meta["doc_date"] = doc_date.isoformat()
    return meta


# ---------- SMALL UTILITIES ----------

def utc_now_iso():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def chunked(seq, size):
    for start in range(0, len(seq), size):
        yield seq[start:start + size]


def read_json(path, default):
    try:
        with open(path, "r", encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json_atomic(path, payload):
    tmp = f"{path}.{os.getpid()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    for attempt in range(5):
        try:
            os.replace(tmp, path)
            return
        except PermissionError:  # Windows: reader has the file open for an instant
            time.sleep(0.05 * (attempt + 1))
    os.replace(tmp, path)


_log_file = None


def log(msg):
    line = f"[{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] {msg}"
    print(line, flush=True)
    if _log_file is not None:
        try:
            _log_file.write(line + "\n")
            _log_file.flush()
        except OSError:
            pass


def with_retries(label, fn, retries=6, base_wait=2, max_wait=60):
    last_err = None
    for attempt in range(retries):
        try:
            return fn()
        except Exception as e:  # network / service hiccups; the caller decides what a final failure means
            last_err = e
            if attempt == retries - 1:
                break
            wait = min(base_wait * (2 ** attempt), max_wait)
            log(f"    {label} failed (attempt {attempt + 1}/{retries}): {str(e)[:300]} -- retrying in {wait}s")
            time.sleep(wait)
    raise RuntimeError(f"{label} failed after {retries} attempts: {str(last_err)[:500]}")


# ---------- RUN LOCK ----------

class RunLock:
    """Single-run guard shared by the scheduler, the admin button and manual CLI runs.
    A lock whose heartbeat stopped (process killed) is taken over after LOCK_STALE_SECONDS."""

    def __init__(self, path):
        self.path = path
        self._stop = threading.Event()
        self._thread = None

    def acquire(self, run_id):
        for _ in range(2):
            try:
                fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            except FileExistsError:
                try:
                    age = time.time() - os.path.getmtime(self.path)
                except OSError:
                    continue
                if age <= LOCK_STALE_SECONDS:
                    return False
                try:
                    os.remove(self.path)
                except OSError:
                    return False
                continue
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump({"pid": os.getpid(), "run_id": run_id, "started_at": utc_now_iso()}, f)
            self._thread = threading.Thread(target=self._heartbeat, daemon=True)
            self._thread.start()
            return True
        return False

    def _heartbeat(self):
        while not self._stop.wait(LOCK_HEARTBEAT_SECONDS):
            try:
                os.utime(self.path, None)
            except OSError:
                pass

    def release(self):
        self._stop.set()
        try:
            os.remove(self.path)
        except OSError:
            pass


# ---------- CLA ONLINE API CLIENT ----------

class ApiError(RuntimeError):
    pass


class ClaApiClient:
    def __init__(self, base_url, client_id, client_secret):
        self.base_url = base_url
        self.client_id = client_id
        self.client_secret = client_secret
        self._http = httpx.Client(timeout=httpx.Timeout(120.0, connect=30.0))
        self._token = None
        self._token_expires_at = 0.0
        self._token_lock = threading.Lock()

    def _get_token(self, force=False):
        with self._token_lock:
            if not force and self._token and time.time() < self._token_expires_at - 300:
                return self._token
            resp = self._http.post(
                f"{self.base_url}/GetToken",
                json={"request": {"ClientId": self.client_id, "ClientSecret": self.client_secret}},
            )
            if resp.status_code != 200:
                raise ApiError(f"GetToken returned HTTP {resp.status_code}: {resp.text[:200]}")
            body = resp.json().get("d") or {}
            data = body.get("Data") or {}
            token = data.get("Token")
            if body.get("StatusCode") != 200 or not token:
                raise ApiError(f"GetToken rejected the client credentials: {body.get('Message')}")
            expires_ms = api_epoch_ms(data.get("ExpiresAtUtc"))
            self._token = token
            self._token_expires_at = expires_ms / 1000.0 if expires_ms else time.time() + 1800
            return token

    def call(self, op, body):
        """POST one operation and return the unwrapped 'd' envelope."""
        def attempt():
            token = self._get_token()
            resp = self._http.post(f"{self.base_url}/{op}", json=body,
                                   headers={"Authorization": f"Bearer {token}"})
            if resp.status_code == 401:
                self._get_token(force=True)
                raise ApiError(f"{op}: token rejected (HTTP 401), refreshed")
            if resp.status_code != 200:
                raise ApiError(f"{op}: HTTP {resp.status_code}: {resp.text[:200]}")
            envelope = resp.json().get("d")
            if not isinstance(envelope, dict):
                raise ApiError(f"{op}: unexpected response shape: {resp.text[:200]}")
            return envelope

        return with_retries(f"API {op}", attempt, retries=5, base_wait=2, max_wait=30)

    def iter_search(self, op):
        """Yield (items, total_count) for every page of a Search* operation."""
        page = 1
        while True:
            envelope = self.call(op, {"request": {"PageNumber": page, "PageSize": API_PAGE_SIZE}})
            if envelope.get("StatusCode") != 200:
                raise ApiError(f"{op} page {page}: {envelope.get('StatusCode')} {envelope.get('Message')}")
            data = envelope.get("Data") or {}
            items = data.get("Items") or []
            total = data.get("TotalCount") or 0
            yield items, total
            total_pages = data.get("TotalPages") or math.ceil(total / API_PAGE_SIZE)
            if not items or page >= total_pages:
                return
            page += 1

    def get_detail(self, op, record_id):
        """Return the Data payload of a Get* operation, or None when the record is gone."""
        envelope = self.call(op, {"id": int(record_id)})
        if envelope.get("StatusCode") == 404:
            return None
        if envelope.get("StatusCode") != 200:
            raise ApiError(f"{op}({record_id}): {envelope.get('StatusCode')} {envelope.get('Message')}")
        return normalise_newlines(envelope.get("Data"))

    def close(self):
        self._http.close()


# ---------- PINECONE / OPENAI HELPERS ----------

def _vectors_map(fetch_res):
    vectors = getattr(fetch_res, "vectors", None)
    if vectors is None and isinstance(fetch_res, dict):
        vectors = fetch_res.get("vectors")
    return vectors or {}


def _metadata_of(vector):
    meta = getattr(vector, "metadata", None)
    if meta is None and isinstance(vector, dict):
        meta = vector.get("metadata")
    return meta or {}


class VectorStore:
    def __init__(self, index, openai_client):
        self.index = index
        self.openai = openai_client
        # Filter-only lookups still need a query vector; any non-zero one will do.
        self._probe = [0.001] * EMBEDDING_DIMENSIONS

    def total_vectors(self):
        return with_retries("Pinecone stats", lambda: self.index.describe_index_stats().total_vector_count)

    def existing_parent_ids(self, source, parent_ids):
        """Which of these parent records already have their first chunk in the index."""
        if not parent_ids:
            return set()
        flt = {"source_table": {"$eq": source}, "chunk_index": {"$eq": 0},
               "parent_id": {"$in": [int(p) for p in parent_ids]}}
        res = with_retries("Pinecone lookup", lambda: self.index.query(
            vector=self._probe, top_k=1000, filter=flt, include_metadata=True))
        matches = res.matches or []
        if len(matches) >= 1000 and len(parent_ids) > 1:
            half = len(parent_ids) // 2
            return self.existing_parent_ids(source, parent_ids[:half]) | \
                self.existing_parent_ids(source, parent_ids[half:])
        found = set()
        for match in matches:
            parent_id = (match.metadata or {}).get("parent_id")
            if parent_id is not None:
                found.add(int(parent_id))
        return found

    def fetch_metadata(self, ids):
        """id -> metadata for the ids that exist."""
        out = {}
        for batch in chunked(list(ids), 100):
            res = with_retries("Pinecone fetch", lambda b=batch: self.index.fetch(ids=b))
            for vid, vector in _vectors_map(res).items():
                out[vid] = _metadata_of(vector)
        return out

    def list_record_ids(self, source, record_id):
        prefix = f"{source}|{record_id}|"

        def run():
            ids = []
            for page in self.index.list(prefix=prefix, limit=100):
                items = page.vectors if hasattr(page, "vectors") else page
                for item in items:
                    ids.append(item.id if hasattr(item, "id") else item)
            return ids

        return with_retries("Pinecone list", run)

    def delete_ids(self, ids):
        for batch in chunked(list(ids), 500):
            with_retries("Pinecone delete", lambda b=batch: self.index.delete(ids=b))

    def embed(self, texts):
        vectors = []
        for batch in chunked(texts, EMBED_BATCH_SIZE):
            vectors.extend(self._embed_batch(batch))
        return vectors

    def _embed_batch(self, texts, retries=6):
        for attempt in range(retries):
            try:
                result = self.openai.embeddings.create(
                    model=EMBEDDING_MODEL, input=texts, dimensions=EMBEDDING_DIMENSIONS)
                vectors = [d.embedding for d in result.data]
                if len(vectors) != len(texts):
                    raise RuntimeError(f"Expected {len(texts)} embeddings, got {len(vectors)}.")
                return vectors
            except RateLimitError:
                wait = min(2 ** attempt * 5, 90)
                log(f"    OpenAI rate limited (attempt {attempt + 1}/{retries}): retrying in {wait}s")
                time.sleep(wait)
            except (APIError, APIConnectionError) as e:
                wait = min(2 ** attempt * 2, 60)
                log(f"    OpenAI error (attempt {attempt + 1}/{retries}): {str(e)[:200]} -- retrying in {wait}s")
                time.sleep(wait)
        raise RuntimeError("Embedding failed after max retries.")

    def embed_and_upsert(self, items):
        """Embed and write vector items. Every record's first chunk is written last, so a
        record interrupted half-way is still seen as missing and redone on the next run."""
        if not items:
            return
        embeddings = self.embed([item["text"] for item in items])
        vectors = [{"id": item["id"], "values": values, "metadata": item["metadata"]}
                   for item, values in zip(items, embeddings)]
        vectors.sort(key=lambda v: v["metadata"]["chunk_index"] == 0)
        for batch in chunked(vectors, UPSERT_BATCH_SIZE):
            with_retries("Pinecone upsert", lambda b=batch: self.index.upsert(vectors=b, timeout=120),
                         retries=8, base_wait=3)


# ---------- RUN REPORTING ----------

def new_source_stats(name):
    return {
        "status": "pending", "phase": None,
        "unit": "files" if SOURCES[name].get("grouped") else "records",
        "api_total": 0, "listed": 0, "already_indexed": 0,
        "new_found": 0, "new_records": 0, "new_chunks": 0, "verified": 0,
        "update_candidates": 0, "updated_records": 0, "updated_chunks": 0, "unchanged": 0,
        "stale_chunks_deleted": 0, "no_content": 0, "errors": 0, "error_samples": [],
        "duration_seconds": None,
    }


class RunReporter:
    def __init__(self, run_id, trigger, dry_run, sources):
        self._last_flush = 0.0
        self.data = {
            "run_id": run_id, "trigger": trigger, "dry_run": dry_run,
            "status": "running", "phase": "starting", "current_source": None,
            "started_at": utc_now_iso(), "finished_at": None, "updated_at": utc_now_iso(),
            "pid": os.getpid(),
            "index_name": PINECONE_DB_INDEX_NAME,
            "embedding_model": EMBEDDING_MODEL, "embedding_dimensions": EMBEDDING_DIMENSIONS,
            "vectors_before": None, "vectors_after": None,
            "error": None,
            "sources": {name: new_source_stats(name) for name in sources},
        }

    def source(self, name):
        return self.data["sources"][name]

    def add_error(self, name, message):
        stats = self.source(name)
        stats["errors"] += 1
        if len(stats["error_samples"]) < 10:
            stats["error_samples"].append(str(message)[:400])
        log(f"[{name}] ERROR: {str(message)[:400]}")

    def phase(self, name, phase):
        self.data["current_source"] = name
        self.data["phase"] = phase
        if name:
            self.source(name)["phase"] = phase
        self.flush(force=True)

    def flush(self, force=False):
        now = time.time()
        if not force and now - self._last_flush < 1.0:
            return
        self._last_flush = now
        self.data["updated_at"] = utc_now_iso()
        try:
            write_json_atomic(STATUS_PATH, self.data)
        except OSError as e:
            log(f"    Warning: could not write status file: {e}")

    def totals(self):
        keys = ["api_total", "new_records", "new_chunks", "updated_records", "updated_chunks",
                "no_content", "errors", "verified"]
        return {k: sum(s[k] for s in self.data["sources"].values()) for k in keys}

    def finish(self, status, error=None):
        self.data["status"] = status
        self.data["phase"] = "done"
        self.data["current_source"] = None
        self.data["finished_at"] = utc_now_iso()
        self.data["error"] = error
        self.data["totals"] = self.totals()
        self.flush(force=True)
        history = read_json(HISTORY_PATH, [])
        if not isinstance(history, list):
            history = []
        history.insert(0, self.data)
        write_json_atomic(HISTORY_PATH, history[:HISTORY_LIMIT])


# ---------- SYNC ----------

def _normalise(text):
    return re.sub(r"\s+", " ", text or "").strip()


class Syncer:
    def __init__(self, args, api, store, reporter, state):
        self.args = args
        self.api = api
        self.store = store
        self.rep = reporter
        self.state = state
        self.pool = ThreadPoolExecutor(max_workers=API_WORKERS)

    def _download(self, spec, parent_ids, groups):
        """Fetch + map the given records concurrently. Yields (parent_id, row, error);
        row is None when the record has no text to embed."""
        def one(pid):
            try:
                data = self.api.get_detail(spec["get_op"], pid)
                if not data:
                    return pid, None, None
                row = spec["map"](data, groups[pid]) if spec.get("grouped") else spec["map"](data)
                return pid, row, None
            except Exception as e:
                return pid, None, e
        return self.pool.map(one, parent_ids)

    def sync_source(self, name):
        spec = SOURCES[name]
        stats = self.rep.source(name)
        stats["status"] = "running"
        started = time.time()
        src_state = self.state["sources"].setdefault(name, {})
        known = set() if self.args.reverify else set(src_state.get("known_parent_ids") or [])
        no_content = dict(src_state.get("no_content") or {})
        baseline = src_state.get("update_baseline_ms")

        # 1. Everything the API has for this source: parent id -> UpdateDate (epoch ms).
        #    For grouped sources (Legislation) the unit is the file, and its UpdateDate is the
        #    latest of its section rows.
        self.rep.phase(name, "listing")
        parents = {}
        groups = defaultdict(list)
        for items, total in self.api.iter_search(spec["search_op"]):
            for item in items:
                pid = item.get(spec["id_field"])
                if not pid and spec.get("grouped"):
                    continue
                if pid is None:
                    continue
                pid = int(pid)
                updated = api_epoch_ms(item.get("UpdateDate"))
                if spec.get("grouped"):
                    groups[pid].append(item)
                    updated = max(updated or 0, parents.get(pid) or 0) or None
                parents[pid] = updated
            stats["api_total"] = total
            stats["listed"] = len(parents)
            self.rep.flush()
        max_update = max((u for u in parents.values() if u is not None), default=None)
        log(f"[{name}] API lists {stats['api_total']} rows = {len(parents)} {stats['unit']}.")

        # 2. Which of them are not indexed yet.
        self.rep.phase(name, "checking_index")
        to_check = sorted(pid for pid in parents
                          if pid not in known and no_content.get(str(pid), -1) != (parents[pid] or 0))
        missing = []
        for batch in chunked(to_check, API_PAGE_SIZE):
            present = self.store.existing_parent_ids(name, batch)
            known.update(present)
            missing.extend(pid for pid in batch if pid not in present)
            stats["already_indexed"] = len(known & parents.keys())
            stats["new_found"] = len(missing)
            self.rep.flush()
        stats["already_indexed"] = len(known & parents.keys())
        stats["no_content"] = sum(1 for pid in parents if pid not in known and pid not in missing)

        update_ids, capped = [], False
        if name in self.args.refresh_all:
            update_ids = sorted(pid for pid in parents if pid in known)
        elif not self.args.no_updates and baseline is not None:
            update_ids = sorted((pid for pid, u in parents.items() if u is not None and u > baseline and pid in known),
                                key=lambda pid: parents[pid])
            capped = len(update_ids) > MAX_UPDATES_PER_RUN
            update_ids = update_ids[:MAX_UPDATES_PER_RUN]
        stats["update_candidates"] = len(update_ids)
        log(f"[{name}] {stats['already_indexed']} already indexed, {len(missing)} new, "
            f"{len(update_ids)} changed since last run.")

        if self.args.limit is not None:
            missing = missing[:self.args.limit]
            update_ids = update_ids[:self.args.limit]

        if self.args.dry_run:
            stats["status"] = "completed"
            stats["duration_seconds"] = round(time.time() - started, 1)
            return

        # 3. Embed and upsert the new records.
        self.rep.phase(name, "embedding_new")
        ingested = []
        for slice_ids in chunked(missing, DETAIL_SLICE):
            records = []
            for pid, row, err in self._download(spec, slice_ids, groups):
                if err is not None:
                    self.rep.add_error(name, f"record {pid}: {err}")
                    continue
                items = build_record_vectors(name, row) if row else []
                if not items:
                    no_content[str(pid)] = parents[pid] or 0
                    stats["no_content"] += 1
                    continue
                records.append((pid, items))
            # Exact-ID guard: never re-embed a record whose first chunk is already there.
            if records:
                present = self.store.fetch_metadata([items[0]["id"] for _, items in records])
                for pid, items in records:
                    if items[0]["id"] in present:
                        known.add(pid)
                        stats["already_indexed"] += 1
                records = [(pid, items) for pid, items in records if items[0]["id"] not in present]
            if records:
                try:
                    self.store.embed_and_upsert([item for _, items in records for item in items])
                    for pid, items in records:
                        ingested.append(pid)
                        stats["new_records"] += 1
                        stats["new_chunks"] += len(items)
                except Exception as e:
                    self.rep.add_error(name, f"embedding/upsert of {len(records)} records failed: {e}")
            self.rep.flush()

        # 4. Refresh records the source edited since the last run (only if the text changed).
        self.rep.phase(name, "refreshing_updated")
        failed_updates = []
        for slice_ids in chunked(update_ids, DETAIL_SLICE):
            for pid, row, err in self._download(spec, slice_ids, groups):
                try:
                    if err is not None:
                        raise err
                    items = build_record_vectors(name, row) if row else []
                    if not items:
                        continue
                    old_ids = self.store.list_record_ids(name, row["record_id"])
                    old_meta = self.store.fetch_metadata(old_ids)
                    old_texts = [_normalise(old_meta[vid].get("chunk_text"))
                                 for vid in sorted(old_meta, key=lambda v: int(v.rsplit("|", 1)[1]))]
                    if old_texts == [_normalise(item["text"]) for item in items]:
                        stats["unchanged"] += 1
                        continue
                    self.store.embed_and_upsert(items)
                    new_ids = {item["id"] for item in items}
                    stale = [vid for vid in old_ids if vid not in new_ids]
                    if stale:
                        self.store.delete_ids(stale)
                        stats["stale_chunks_deleted"] += len(stale)
                    stats["updated_records"] += 1
                    stats["updated_chunks"] += len(items)
                except Exception as e:
                    failed_updates.append(pid)
                    self.rep.add_error(name, f"refresh of record {pid}: {e}")
            self.rep.flush()

        # 5. Confirm the new records are queryable before remembering them as done.
        self.rep.phase(name, "verifying")
        pending = list(ingested)
        for attempt in range(VERIFY_ATTEMPTS):
            if not pending:
                break
            if attempt:
                time.sleep(VERIFY_WAIT_SECONDS)
            confirmed = set()
            for batch in chunked(pending, API_PAGE_SIZE):
                confirmed |= self.store.existing_parent_ids(name, batch)
            known.update(confirmed)
            stats["verified"] += len(confirmed)
            pending = [pid for pid in pending if pid not in confirmed]
            self.rep.flush()
        if pending:
            self.rep.add_error(name, f"{len(pending)} new records not yet visible in Pinecone "
                                     f"(e.g. {pending[:5]}); they will be re-checked next run")

        # 6. Persist what this source now looks like.
        if not self.args.no_updates and self.args.limit is None:
            if failed_updates:
                new_baseline = min(parents[pid] for pid in failed_updates) - 1
                src_state["update_baseline_ms"] = max(new_baseline, baseline or 0)
            elif capped:
                src_state["update_baseline_ms"] = parents[update_ids[-1]]
            elif max_update is not None:
                src_state["update_baseline_ms"] = max_update
        src_state["known_parent_ids"] = sorted(known)
        src_state["no_content"] = {pid: updated for pid, updated in no_content.items() if int(pid) not in known}
        src_state["last_synced_at"] = utc_now_iso()
        write_json_atomic(STATE_PATH, self.state)

        stats["status"] = "completed_with_errors" if stats["errors"] else "completed"
        stats["duration_seconds"] = round(time.time() - started, 1)
        log(f"[{name}] Done in {stats['duration_seconds']}s: +{stats['new_records']} records "
            f"({stats['new_chunks']} chunks), {stats['updated_records']} refreshed, "
            f"{stats['no_content']} without text, {stats['errors']} errors.")

    def close(self):
        self.pool.shutdown(wait=False)


def check_configuration():
    missing = [name for name, value in [
        ("CLA_API_CLIENT_ID", CLA_API_CLIENT_ID), ("CLA_API_CLIENT_SECRET", CLA_API_CLIENT_SECRET),
        ("PINECONE_API_KEY", PINECONE_API_KEY), ("OPENAI_API_KEY", os.getenv("OPENAI_API_KEY", "")),
    ] if not value]
    if missing:
        raise RuntimeError(f"Missing required environment variables: {', '.join(missing)} "
                           f"(set them in {os.path.join(_ROOT, '.env')})")


def check_index_matches_embedding_config(pc, store):
    """Refuse to write vectors from a different model/dimension into the index: mixed
    vector spaces fail silently (bad similarity scores), not loudly."""
    description = pc.describe_index(PINECONE_DB_INDEX_NAME)
    if int(description.dimension) != EMBEDDING_DIMENSIONS:
        raise RuntimeError(f"Index '{PINECONE_DB_INDEX_NAME}' has dimension {description.dimension} but "
                           f"EMBEDDING_DIMENSIONS is {EMBEDDING_DIMENSIONS}.")
    res = store.index.query(vector=store._probe, top_k=5, include_metadata=True)
    models = {(m.metadata or {}).get("embedding_model") for m in (res.matches or [])} - {None}
    if models and models != {EMBEDDING_MODEL}:
        raise RuntimeError(f"Index '{PINECONE_DB_INDEX_NAME}' holds vectors from {sorted(models)} but "
                           f"EMBEDDING_MODEL is '{EMBEDDING_MODEL}'.")


def parse_args():
    parser = argparse.ArgumentParser(description="Sync the CLA Online API into the Pinecone structured index.")
    parser.add_argument("--trigger", default="cli", choices=["cli", "manual", "scheduled"])
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--sources", default=None, help="Comma-separated subset, e.g. CaseLaws,Query")
    parser.add_argument("--limit", type=int, default=None, help="Max new records per source (testing)")
    parser.add_argument("--dry-run", action="store_true", help="Report what would change; write nothing")
    parser.add_argument("--reverify", action="store_true",
                        help="Ignore the local cache of indexed IDs and re-check every record against Pinecone")
    parser.add_argument("--no-updates", action="store_true", help="Only add new records; skip edited ones")
    parser.add_argument("--refresh-all", default="",
                        help="Comma-separated sources whose already-indexed records are all re-checked against "
                             "the API and re-embedded where the text or labels differ")
    args = parser.parse_args()
    args.refresh_all = [s.strip() for s in args.refresh_all.split(",") if s.strip()]
    return args


def main():
    global _log_file
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    args = parse_args()
    run_id = args.run_id or uuid.uuid4().hex[:12]
    sources = SOURCE_ORDER
    if args.sources:
        sources = [s.strip() for s in args.sources.split(",") if s.strip()]
        unknown = [s for s in sources if s not in SOURCES]
        if unknown:
            print(f"Unknown sources: {unknown}. Valid: {SOURCE_ORDER}", file=sys.stderr)
            return EXIT_FAILED

    os.makedirs(LOG_DIR, exist_ok=True)
    lock = RunLock(LOCK_PATH)
    if not lock.acquire(run_id):
        print(json.dumps({"started": False, "reason": "already_running"}))
        return EXIT_ALREADY_RUNNING

    _log_file = open(os.path.join(LOG_DIR, f"sync-{datetime.now().strftime('%Y-%m')}.log"), "a", encoding="utf-8")
    reporter = RunReporter(run_id, args.trigger, args.dry_run, sources)
    reporter.flush(force=True)

    def on_terminate(signum, _frame):
        raise KeyboardInterrupt(f"terminated by signal {signum}")

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, on_terminate)
        except (ValueError, OSError):
            pass

    syncer = api = None
    exit_code = EXIT_FAILED
    try:
        log(f"=== Sync run {run_id} started (trigger={args.trigger}, dry_run={args.dry_run}, "
            f"sources={','.join(sources)}) ===")
        check_configuration()
        pc = Pinecone(api_key=PINECONE_API_KEY)
        store = VectorStore(pc.Index(PINECONE_DB_INDEX_NAME), OpenAI(api_key=os.environ["OPENAI_API_KEY"]))
        check_index_matches_embedding_config(pc, store)
        reporter.data["vectors_before"] = store.total_vectors()
        log(f"Index '{PINECONE_DB_INDEX_NAME}': {reporter.data['vectors_before']} vectors, "
            f"{EMBEDDING_MODEL} @ {EMBEDDING_DIMENSIONS} dims.")

        state = read_json(STATE_PATH, {})
        if not isinstance(state, dict):
            state = {}
        state.setdefault("version", 1)
        state.setdefault("sources", {})

        api = ClaApiClient(CLA_API_BASE_URL, CLA_API_CLIENT_ID, CLA_API_CLIENT_SECRET)
        syncer = Syncer(args, api, store, reporter, state)
        for name in sources:
            try:
                syncer.sync_source(name)
            except Exception as e:  # one source failing must not stop the others
                reporter.source(name)["status"] = "failed"
                reporter.add_error(name, f"source aborted: {e}")
                log(traceback.format_exc())
            reporter.flush(force=True)

        if not args.dry_run:
            time.sleep(2)  # let Pinecone stats settle
        reporter.data["vectors_after"] = store.total_vectors()
        has_errors = any(s["errors"] for s in reporter.data["sources"].values())
        reporter.finish("completed_with_errors" if has_errors else "completed")
        totals = reporter.data["totals"]
        log(f"=== Sync run {run_id} finished: +{totals['new_records']} records ({totals['new_chunks']} chunks), "
            f"{totals['updated_records']} refreshed, {totals['errors']} errors. "
            f"Index: {reporter.data['vectors_before']} -> {reporter.data['vectors_after']} vectors ===")
        exit_code = EXIT_COMPLETED_WITH_ERRORS if has_errors else EXIT_OK
    except KeyboardInterrupt as e:
        log(f"Run interrupted: {e}")
        reporter.finish("failed", error=f"Interrupted: {e}" if str(e) else "Interrupted")
    except Exception as e:
        log(f"Run failed: {e}\n{traceback.format_exc()}")
        reporter.finish("failed", error=str(e)[:1000])
    finally:
        if syncer:
            syncer.close()
        if api:
            api.close()
        lock.release()
        _log_file.close()
        _log_file = None
    return exit_code


if __name__ == "__main__":
    sys.exit(main())
