"""
build_legislation_labels.py

Writes embedding/legislation_labels.json: the correct title of every legislation file,
keyed by file name.

Why this exists: the original bulk load of the Legislation table joined the file text to the
wrong row, so many legislation vectors in Pinecone carry another Act's title in their metadata
and chunk header (e.g. the SEBI Listing Regulations file labelled "Indian Contract Act 1872").
The file name stored with each vector is correct, so search_documents.py uses this map to put
the right title back at read time. Nothing in Pinecone is modified.

Run it again whenever the CLA Online API gains new legislation files:

    python embedding/build_legislation_labels.py
"""

import html
import json
import os
import sys
from collections import Counter, defaultdict

import sync_from_api as sync

LABELS_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "legislation_labels.json")

# The API's LegislationNo column holds the instrument type, with a few stray values.
INSTRUMENT_TYPES = {
    "acts": "Act", "rules": "Rules", "regulations": "Regulations",
    "regulation": "Regulations", "guidelines": "Guidelines",
}


def _clean(value):
    return " ".join(html.unescape(str(value or "")).replace("\xa0", " ").split())


def _most_common(rows, field):
    values = [_clean(r.get(field)) for r in rows]
    values = [v for v in values if v]
    return Counter(values).most_common(1)[0][0] if values else ""


def build_labels(rows):
    by_file = defaultdict(list)
    for row in rows:
        file_name = _clean(row.get("Filename")).lower()
        if file_name:
            by_file[file_name].append(row)

    labels = {}
    for file_name, file_rows in sorted(by_file.items()):
        title = _most_common(file_rows, "Title")
        if not title:
            continue
        entry = {"title": title}
        instrument = INSTRUMENT_TYPES.get(_most_common(file_rows, "LegislationNo").lower())
        if instrument:
            entry["type"] = instrument
        labels[file_name] = entry
    return labels


def main():
    sync.check_configuration()
    api = sync.ClaApiClient(sync.CLA_API_BASE_URL, sync.CLA_API_CLIENT_ID, sync.CLA_API_CLIENT_SECRET)
    try:
        rows = []
        for items, total in api.iter_search("SearchLegislations"):
            rows.extend(items)
            sys.stderr.write(f"\rListed {len(rows)}/{total} legislation rows")
        sys.stderr.write("\n")
    finally:
        api.close()

    labels = build_labels(rows)
    if not labels:
        raise RuntimeError("The API returned no legislation rows; the existing labels file was left untouched.")

    tmp_path = LABELS_PATH + ".tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(labels, f, ensure_ascii=False, indent=0, sort_keys=True)
    os.replace(tmp_path, LABELS_PATH)
    print(f"Wrote {len(labels)} legislation file labels to {LABELS_PATH}")


if __name__ == "__main__":
    main()
