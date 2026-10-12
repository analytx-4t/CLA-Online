"""
build_legislation_catalogue.py

Writes embedding/legislation_catalogue.json: for every legislation file in the index, what the
answer pipeline needs to know about its currency.

    {
      "spoitr_2015.htm": {
        "title": "SEBI (PROHIBITION OF INSIDER TRADING) REGULATIONS, 2015",
        "type": "Regulations",
        "year": 2015,                  # year in the instrument's title
        "last_amended": "2025-03-12",  # latest amendment date recorded in the text's footnotes
        "amendments_recorded": 96,     # footnote entries carrying a date
        "chunks": 142
      }
    }

The index stores each instrument as consolidated text with footnotes ("Substituted by ...
w.e.f. 01-04-2019"). The source data has no effective-date or amendment-date column, so the
dates are read from those footnotes. Nothing in Pinecone is modified: this is a read-only scan.

Current / superseded status is not stored here. It is worked out from the titles in
legislation_labels.json and backend/supersededInstruments.json (see backend/legalAuthority.js),
so it follows those two files without a rebuild.

Run it again after a legislation refresh:

    python embedding/build_legislation_catalogue.py
"""

import json
import os
import re
import sys
from concurrent.futures import ThreadPoolExecutor
from datetime import date

import search_documents
from amendment_history import count_prior_wording, locate_history
from search_documents import describe_db_chunk, get_legislation_labels, get_pinecone_db_index

CATALOGUE_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "legislation_catalogue.json")
ID_PREFIX = "Legislation|"
FETCH_BATCH = 100
FETCH_WORKERS = 8
FIRST_PLAUSIBLE_YEAR = 1950

MONTHS = {name: number for number, name in enumerate(
    ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
     "november", "december"], start=1)}
# "w.e.f. 01-04-2019", "with effect from 1.4.2019", "dated 11th September 2018", "dated 17-09-2019"
NUMERIC_DATE = r"(\d{1,2})[-./](\d{1,2})[-./]((?:19|20)\d{2})"
WORD_DATE = r"(\d{1,2})(?:st|nd|rd|th)?\s+(" + "|".join(MONTHS) + r"),?\s+((?:19|20)\d{2})"
AMENDMENT_DATE_RE = re.compile(
    r"(?:w\.?\s?e\.?\s?f\.?|with effect from|dated)\s*:?\s*(?:" + NUMERIC_DATE + "|" + WORD_DATE + ")",
    re.IGNORECASE)
AMENDMENT_WORD_RE = re.compile(r"\b(?:substituted|inserted|omitted|amend(?:ed|ment)|added)\b", re.IGNORECASE)
TITLE_YEAR_RE = re.compile(r"\b((?:19|20)\d{2})\b")


def amendment_dates(text, today=None):
    """Dates of the amendments recorded in a passage's footnotes, as date objects."""
    today = today or date.today()
    found = []
    for match in AMENDMENT_DATE_RE.finditer(str(text or "")):
        # Only a date that sits in an amendment note counts ("Substituted by ... w.e.f. ...").
        context = text[max(0, match.start() - 260):match.start()]
        if not AMENDMENT_WORD_RE.search(context):
            continue
        try:
            if match.group(1):
                day, month, year = int(match.group(1)), int(match.group(2)), int(match.group(3))
            else:
                day, month, year = int(match.group(4)), MONTHS[match.group(5).lower()], int(match.group(6))
            value = date(year, month, day)
        except (ValueError, KeyError):
            continue
        if FIRST_PLAUSIBLE_YEAR <= value.year and value <= today:
            found.append(value)
    return found


def build_catalogue(chunks, labels, today=None):
    """@param chunks  iterable of described legislation chunks ({"file_name", "record_id",
    "chunk_index", "chunk_body", ...}) with their full, untrimmed text."""
    by_file = {}
    for chunk in chunks:
        key = str(chunk.get("file_name") or "").strip().lower()
        if not key:
            continue
        entry = by_file.setdefault(key, {"chunks": 0, "dates": [], "records": {}})
        entry["chunks"] += 1
        entry["dates"].extend(amendment_dates(chunk.get("chunk_body"), today))
        entry["records"].setdefault(str(chunk.get("record_id")), []).append(
            {"chunk_index": int(chunk.get("chunk_index") or 0), "chunk_body": chunk.get("chunk_body") or ""})

    catalogue = {}
    for key, entry in sorted(by_file.items()):
        label = labels.get(key) or {}
        title = label.get("title")
        years = TITLE_YEAR_RE.findall(title or "")
        record = {"title": title, "type": label.get("type"), "year": int(years[-1]) if years else None,
                  "chunks": entry["chunks"], "amendments_recorded": len(entry["dates"]),
                  "last_amended": max(entry["dates"]).isoformat() if entry["dates"] else None}
        # Where the amendment history (footnotes with superseded wording) starts, per record.
        history = {}
        operative_prior_wording = 0
        for record_id, record_chunks in entry["records"].items():
            located = locate_history(record_chunks)
            if located:
                history[record_id] = {"chunk": located[0], "offset": located[1]}
            for chunk in record_chunks:
                body = chunk["chunk_body"]
                if located and chunk["chunk_index"] > located[0]:
                    continue
                if located and chunk["chunk_index"] == located[0]:
                    body = body[:located[1]]
                operative_prior_wording += count_prior_wording(body)
        if history:
            record["history"] = history
        # Superseded wording that sits in the operative text itself, outside any footnote block.
        if operative_prior_wording:
            record["operative_prior_wording"] = operative_prior_wording
        catalogue[key] = record
    return catalogue


def iter_legislation_chunks(index):
    """Every legislation chunk in the index. The ids are listed first, then read in batches
    by several workers at once: a fetch is a few seconds of waiting on the network."""
    ids = []
    for page in index.list(prefix=ID_PREFIX):
        # Older clients yield id strings, newer ones objects with an `id`.
        ids.extend(str(getattr(item, "id", item)) for item in page)
    batches = [ids[start:start + FETCH_BATCH] for start in range(0, len(ids), FETCH_BATCH)]
    with ThreadPoolExecutor(max_workers=FETCH_WORKERS) as pool:
        for chunks in pool.map(lambda batch: _fetch(index, batch), batches):
            yield from chunks


def _fetch(index, ids):
    fetched = index.fetch(ids=ids)
    vectors = getattr(fetched, "vectors", None) or {}
    chunks = []
    for vector_id in ids:
        vector = vectors.get(vector_id)
        if vector is not None:
            chunks.append(describe_db_chunk(vector_id, getattr(vector, "metadata", None) or {}))
    return chunks


def main():
    # Read the text as stored: the existing catalogue must not trim the chunks being catalogued.
    search_documents._LEGISLATION_CATALOGUE = {}
    index = get_pinecone_db_index()
    if index is None:
        raise RuntimeError("The Pinecone structured index could not be opened.")
    seen = 0

    def counted():
        nonlocal seen
        for chunk in iter_legislation_chunks(index):
            seen += 1
            if seen % 1000 == 0:
                sys.stderr.write(f"\rRead {seen} legislation chunks")
            yield chunk

    catalogue = build_catalogue(counted(), get_legislation_labels())
    sys.stderr.write(f"\rRead {seen} legislation chunks\n")
    if not catalogue:
        raise RuntimeError("No legislation chunks were read; the existing catalogue was left untouched.")

    tmp_path = CATALOGUE_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(catalogue, f, ensure_ascii=False, indent=0, sort_keys=True)
    os.replace(tmp_path, CATALOGUE_PATH)
    dated = sum(1 for record in catalogue.values() if record["last_amended"])
    unlabelled = sum(1 for record in catalogue.values() if not record["title"])
    with_history = sum(1 for record in catalogue.values() if record.get("history"))
    inline = sum(1 for record in catalogue.values() if record.get("operative_prior_wording"))
    print(f"Wrote {len(catalogue)} legislation files to {CATALOGUE_PATH} "
          f"({dated} with a recorded amendment date, {unlabelled} with no verified title, "
          f"{with_history} with an amendment-history block, {inline} with superseded wording outside one).")


if __name__ == "__main__":
    main()
