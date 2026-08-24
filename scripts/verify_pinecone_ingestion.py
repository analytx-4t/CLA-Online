"""
Comprehensive Verification Script for Pinecone CLA Books Ingestion.
Verifies PDF page text coverage, missing chunk detection, vector counts,
and performs live semantic retrieval checks on Pinecone.
"""

import os
import json
import fitz
import importlib.util
from openai import OpenAI
from pinecone import Pinecone

PDF_DIR = r"C:\Users\hp\Documents\SQL Server Management Studio\CLA books"
STATE_FILE = r"c:\Users\hp\Desktop\Legal\scripts\pinecone_ingest_state.json"
INGEST_SCRIPT = r"c:\Users\hp\Desktop\Legal\scripts\pinecone_pdf_ingest.py"

OPENAI_KEY = os.getenv("OPENAI_API_KEY", "")
PINECONE_KEY = os.getenv("PINECONE_API_KEY", "")
INDEX_NAME = os.getenv("PINECONE_INDEX_NAME", "cla-online")


def run_audit():
    print("==================================================")
    print("       CLA BOOKS PINECONE INGESTION VERIFICATION  ")
    print("==================================================")

    # 1. State File Verification
    with open(STATE_FILE, "r", encoding="utf-8") as f:
        state = json.load(f)

    print("\n--- 1. INGESTION STATE FILE VERIFICATION ---")
    print(f"Completed PDF Files in State: {len(state['completed_files'])} / 8")
    print(f"Total Vector Keys in State:   {len(state['processed_vectors']):,}")

    # Load ingest module functions
    spec = importlib.util.spec_from_file_location("ingest", INGEST_SCRIPT)
    ingest_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(ingest_mod)

    # 2. PDF Page & Text Coverage Audit
    print("\n--- 2. PDF PAGE & TEXT COVERAGE AUDIT ---")
    files = sorted([f for f in os.listdir(PDF_DIR) if f.endswith(".pdf")])

    total_pdf_chars = 0
    total_pdf_pages = 0
    total_expected_chunks = 0
    missing_chunks = []

    for f in files:
        pdf_path = os.path.join(PDF_DIR, f)
        doc = fitz.open(pdf_path)
        book_name = os.path.splitext(f)[0]
        book_slug = ingest_mod.sanitize_id(book_name[:40])

        file_chars = 0
        file_chunks = 0
        active_sec = None

        for page_idx in range(len(doc)):
            page_num = page_idx + 1
            raw_txt = doc[page_idx].get_text("text")
            cleaned = ingest_mod.clean_text(raw_txt)
            file_chars += len(cleaned)

            if cleaned:
                chunks, active_sec = ingest_mod.build_chunks(cleaned, active_section=active_sec)
                file_chunks += len(chunks)
                for chunk_idx in range(len(chunks)):
                    key = f"{book_slug}_p{page_num}_c{chunk_idx}"
                    if key not in state["processed_vectors"]:
                        missing_chunks.append((f, page_num, chunk_idx, key))

        num_pages = len(doc)
        doc.close()

        total_pdf_chars += file_chars
        total_pdf_pages += num_pages
        total_expected_chunks += file_chunks

        print(f"{f[:45]:<45} | Pages: {num_pages:<4} | Chars: {file_chars:<10,} | Chunks: {file_chunks:,}")

    print("-" * 80)
    print(f"Total PDF Pages Audit:             {total_pdf_pages:,}")
    print(f"Total Text Characters Audit:       {total_pdf_chars:,}")
    print(f"Total Chunks Generated & Expected: {total_expected_chunks:,}")
    print(f"Missing/Un-embedded Chunks Count:  {len(missing_chunks)}")

    # 3. Pinecone Index Live Verification & Semantic Query Test
    print("\n--- 3. PINECONE INDEX LIVE VERIFICATION & TEST SEARCH ---")
    pc = Pinecone(api_key=PINECONE_KEY)
    index = pc.Index(INDEX_NAME)
    stats = index.describe_index_stats()

    print(f"Pinecone Total Vector Count: {stats.total_vector_count:,}")
    print(f"Index Dimension:            {stats.dimension}")
    print(f"Index Metric:               {stats.metric}")

    if stats.total_vector_count == total_expected_chunks and len(missing_chunks) == 0:
        print("\n[OK] PERFECT MATCH: 100% of chunks from all 8 PDFs are present in Pinecone!")
    else:
        print(f"\n[WARNING] Mismatch: Pinecone vectors ({stats.total_vector_count}) vs Expected ({total_expected_chunks})")

    # Semantic Retrieval Test
    print("\n--- 4. LIVE SEMANTIC RETRIEVAL TEST ---")
    queries = [
        "Loans to directors section 185 conditions",
        "Key Managerial Personnel appointment qualifications",
        "Meetings quorum and governance resolution"
    ]

    openai_client = OpenAI(api_key=OPENAI_KEY)

    for q in queries:
        print(f"\nQuery: '{q}'")
        res = openai_client.embeddings.create(model="text-embedding-3-small", input=[q], dimensions=1536)
        vec = res.data[0].embedding
        search_res = index.query(vector=vec, top_k=2, include_metadata=True)

        for i, match in enumerate(search_res["matches"], 1):
            meta = match["metadata"]
            print(f"  Match {i} [Score: {match['score']:.4f}] Vector ID: {match['id']}")
            print(f"    Book: {meta.get('book_name')}")
            print(f"    Page: {meta.get('page_number')} / {meta.get('total_pages')}")
            print(f"    Section: {meta.get('section_label') or 'N/A'}")
            snippet = meta.get('text', '').replace('\n', ' ')[:100]
            print(f"    Snippet: {snippet}...")

    print("\n==================================================")
    print("               VERIFICATION COMPLETE             ")
    print("==================================================")


if __name__ == "__main__":
    run_audit()
