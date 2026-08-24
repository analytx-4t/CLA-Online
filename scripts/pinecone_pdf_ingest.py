"""
Pinecone Vector Database Ingestion Script for CLA Books PDFs.

Performs structure-aware chunking (Section/Clause/Article/Chapter split with
recursive paragraph/sentence/hard-cut fallbacks), embeds via OpenAI
text-embedding-3-small (1536 dims), and upserts into Pinecone index 'cla-online'.

Zero side-effects on current project code.
"""

import os
import re
import sys
import html
import json
import time
import hashlib
import fitz  # PyMuPDF
from openai import OpenAI, RateLimitError, APIError, APIConnectionError
from pinecone import Pinecone

# ---------- CONFIG ----------

PDF_DIR = r"C:\Users\hp\Documents\SQL Server Management Studio\CLA books"
PINECONE_API_KEY = os.getenv("PINECONE_API_KEY", "")
PINECONE_INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "cla-online")

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY", "")
EMBEDDING_MODEL = "text-embedding-3-small"
EMBEDDING_DIM = 1536

MAX_CHUNK_CHARS = 1400
CHUNK_OVERLAP_CHARS = 200
BATCH_SIZE = 100  # vectors per OpenAI batch and Pinecone upsert

STATE_FILE = os.path.join(os.path.dirname(__file__), "pinecone_ingest_state.json")
LOG_FILE = os.path.join(os.path.dirname(__file__), "pinecone_pdf_ingest.log")

# Clients
openai_client = OpenAI(api_key=OPENAI_API_KEY)
pc_client = Pinecone(api_key=PINECONE_API_KEY)
pinecone_index = pc_client.Index(PINECONE_INDEX_NAME)

# ---------- TEXT CLEANING & CHUNKING ----------

SECTION_MARKER_RE = re.compile(
    r"(?=(?:\A|\n)[ \t]*(?:Section|Sec\.?|Clause|Article|Chapter)\s+[0-9IVXLCM]+[A-Za-z]?\b)",
    re.IGNORECASE,
)
SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?])\s+")


def clean_text(text):
    if not text:
        return ""
    text = re.sub(r"<[^>]+>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip()


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


def build_chunks(text, active_section=None):
    if not text or not text.strip():
        return [], active_section

    sections = split_by_structure(text)
    final_chunks = []
    for label, body in sections:
        current_label = label if label else active_section
        if label:
            active_section = label
        for piece in recursive_split(body):
            final_chunks.append((current_label, piece))
    return final_chunks, active_section


def with_context_prefix(book_name, page_num, total_pages, label, chunk_body):
    parts = [f"Book: {book_name}", f"Page: {page_num}/{total_pages}"]
    if label:
        parts.append(f"Section: {label}")
    header = "[" + " | ".join(parts) + "]\n"
    return header + chunk_body

# ---------- EMBEDDING & PINECONE UPSERT ----------

def embed_texts_batch(texts, retries=5):
    for attempt in range(retries):
        try:
            res = openai_client.embeddings.create(
                model=EMBEDDING_MODEL,
                input=texts,
                dimensions=EMBEDDING_DIM
            )
            return [d.embedding for d in res.data]
        except RateLimitError as e:
            wait = 2 ** attempt * 3
            log(f"    OpenAI Rate limit hit, backing off {wait}s...")
            time.sleep(wait)
        except (APIError, APIConnectionError) as e:
            wait = 2 ** attempt
            log(f"    OpenAI API error ({e}), retrying in {wait}s...")
            time.sleep(wait)
    raise RuntimeError("Failed to embed batch after retries")


def upsert_to_pinecone(vector_records, retries=5):
    for attempt in range(retries):
        try:
            pinecone_index.upsert(vectors=vector_records)
            return True
        except Exception as e:
            wait = 2 ** attempt * 2
            log(f"    Pinecone upsert error ({e}), retrying in {wait}s...")
            time.sleep(wait)
    raise RuntimeError("Failed to upsert to Pinecone after retries")

# ---------- STATE & LOGGING ----------

def log(msg):
    timestamp = time.strftime("%Y-%m-%d %H:%M:%S")
    formatted = f"[{timestamp}] {msg}"
    print(formatted, flush=True)
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(formatted + "\n")


def load_state():
    if os.path.exists(STATE_FILE):
        try:
            with open(STATE_FILE, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception:
            pass
    return {"completed_files": [], "completed_chunks": 0, "processed_vectors": {}}


def save_state(state):
    with open(STATE_FILE, "w", encoding="utf-8") as f:
        json.dump(state, f, indent=2)

# ---------- MAIN INGESTION PIPELINE ----------

def sanitize_id(text):
    return re.sub(r"[^a-zA-Z0-9_\-]", "_", text)


def process_all_pdfs():
    state = load_state()
    log("Starting Pinecone PDF Ingestion Pipeline...")

    files = sorted([f for f in os.listdir(PDF_DIR) if f.endswith(".pdf")])
    log(f"Found {len(files)} PDF files in target directory.")

    total_chunks_processed_all = state.get("completed_chunks", 0)

    for file_idx, filename in enumerate(files, 1):
        if filename in state["completed_files"]:
            log(f"[{file_idx}/{len(files)}] Skipping '{filename}' (already completed).")
            continue

        pdf_path = os.path.join(PDF_DIR, filename)
        book_name = os.path.splitext(filename)[0]
        book_slug = sanitize_id(book_name[:40])

        log(f"\n==================================================")
        log(f"Processing File [{file_idx}/{len(files)}]: {filename}")
        log(f"==================================================")

        doc = fitz.open(pdf_path)
        total_pages = len(doc)
        log(f"Book '{book_name}' has {total_pages} pages.")

        active_section = None
        pending_records = []
        file_chunks_count = 0

        for page_idx in range(total_pages):
            page_num = page_idx + 1
            page = doc[page_idx]
            raw_page_text = page.get_text("text")
            cleaned = clean_text(raw_page_text)

            if not cleaned:
                continue

            chunks, active_section = build_chunks(cleaned, active_section=active_section)

            for chunk_idx, (sec_label, chunk_body) in enumerate(chunks):
                file_chunks_count += 1
                unique_key = f"{book_slug}_p{page_num}_c{chunk_idx}"

                if unique_key in state["processed_vectors"]:
                    continue

                full_text = with_context_prefix(book_name, page_num, total_pages, sec_label, chunk_body)

                pending_records.append({
                    "id": unique_key,
                    "text_to_embed": full_text,
                    "metadata": {
                        "text": full_text,
                        "raw_text": chunk_body,
                        "book_name": book_name,
                        "file_name": filename,
                        "page_number": page_num,
                        "section_label": sec_label or "",
                        "chunk_index": chunk_idx,
                        "total_pages": total_pages,
                        "source": "CLA Books"
                    }
                })

                # Embed & Upsert Batch
                if len(pending_records) >= BATCH_SIZE:
                    _embed_and_upsert_batch(pending_records, state)
                    total_chunks_processed_all += len(pending_records)
                    pending_records.clear()
                    log(f"  Progress: {file_chunks_count} chunks created for '{book_name}' (Total Pinecone vectors: {total_chunks_processed_all:,})")

        # Process any remaining records for this file
        if pending_records:
            _embed_and_upsert_batch(pending_records, state)
            total_chunks_processed_all += len(pending_records)
            pending_records.clear()

        doc.close()
        state["completed_files"].append(filename)
        state["completed_chunks"] = total_chunks_processed_all
        save_state(state)
        log(f"SUCCESS: Completed '{filename}' -> {file_chunks_count} chunks embedded & upserted into Pinecone.")

    log("\n==================================================")
    log(f"ALL DONE! Total vectors in Pinecone: {total_chunks_processed_all:,}")
    log("==================================================")


def _embed_and_upsert_batch(records, state):
    texts = [r["text_to_embed"] for r in records]
    vectors = embed_texts_batch(texts)

    pinecone_records = []
    for r, vec in zip(records, vectors):
        pinecone_records.append({
            "id": r["id"],
            "values": vec,
            "metadata": r["metadata"]
        })

    upsert_to_pinecone(pinecone_records)
    for r in records:
        state["processed_vectors"][r["id"]] = True
    save_state(state)


if __name__ == "__main__":
    process_all_pdfs()
