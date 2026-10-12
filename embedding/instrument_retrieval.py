"""
instrument_retrieval.py

Retrieval aimed at the instruments that govern a question.

A search across 170,000 chunks ranks whole documents about a topic above the one provision
that decides it. When the query analysis has named the governing Act, Rules or Regulations,
two further lookups are made:

focus_on_instruments()
    searches inside those instruments only, so the relevant provision of the governing
    instrument is always among the candidates;

latest_amendments()
    finds the most recent amendment notifications to those instruments, so a change made
    after the consolidated text was prepared is in front of the answer model.
"""

import re
import sys
from datetime import date

from definition_resolver import LEGISLATION_TABLE, _instrument_unit, title_match
from keyword_scan import opens_provision, provision_numbers, rank_chunks
from search_documents import _PROBE_VECTOR, _as_int, as_search_result, describe_db_chunk, embed_queries, embed_query

MAX_INSTRUMENTS = 4
MAX_RECORDS_PER_INSTRUMENT = 3     # an Act can be stored as several files (one per chapter)
CHUNKS_PER_RECORD = 6
KEYWORD_SCAN_CHUNKS = 400          # chunks of one file read for the keyword scan
KEYWORD_SCAN_RECORDS = 4           # files scanned per question
KEYWORD_HITS_PER_RECORD = 5
KEYWORD_HIT_SCORE = 0.75           # placeholder similarity; the reranker scores these passages afterwards
INSTRUMENT_TITLE_MATCH = 0.75
TITLE_LOOKUP_TOP_K = 15
AMENDMENT_LOOKUP_TOP_K = 25
AMENDMENTS_PER_INSTRUMENT = 3
# The consolidated text of an instrument already carries its older amendments. Only recent
# ones can be missing from it, so only those are flagged for the answer model.
RECENT_AMENDMENT_YEARS = 2
NOTIFICATION_TABLE = "Notifications"

INSTRUMENT_NAME_RE = re.compile(r"\b(?:Act|Code|Rules|Regulations|Directions|Guidelines)\b", re.IGNORECASE)
YEAR_RE = re.compile(r"\b(?:19|20)\d{2}\b")


def named_instruments(primary_act, keywords):
    """The instruments named by the query analysis: the primary Act first, then any keyword
    that reads as the title of an Act, Rules or Regulations with its year."""
    names = []
    for candidate in [primary_act] + list(keywords or []):
        name = " ".join(str(candidate or "").split())
        if not name or name.lower() == "none":
            continue
        if INSTRUMENT_NAME_RE.search(name) and YEAR_RE.search(name) and not re.search(r"amendment", name, re.IGNORECASE):
            if name.lower() not in {n.lower() for n in names}:
                names.append(name)
    return names[:MAX_INSTRUMENTS]


def find_instrument_records(index, instruments, seed_results):
    """{instrument name: [record ids]} for the legislation files of each named instrument.
    The title is checked on every hit, because a search for a title also returns its amendments
    and the instruments that cite it."""
    records = {name: [] for name in instruments}

    def consider(doc):
        if doc.get("source_table") != LEGISLATION_TABLE:
            return
        for name in instruments:
            if title_match(doc.get("doc_title"), name) >= INSTRUMENT_TITLE_MATCH and doc["record_id"] not in records[name]:
                if len(records[name]) < MAX_RECORDS_PER_INSTRUMENT:
                    records[name].append(doc["record_id"])

    for result in seed_results:
        consider(result)
    for name in instruments:
        if records[name]:
            continue
        vector = embed_query(name)
        if vector is None:
            continue
        res = index.query(vector=vector, top_k=TITLE_LOOKUP_TOP_K, include_metadata=True,
                          filter={"source_table": {"$eq": LEGISLATION_TABLE}})
        for match in res.matches or []:
            consider(describe_db_chunk(match.id, match.metadata))
    return {name: ids for name, ids in records.items() if ids}


def keyword_query(question, keywords):
    """The question plus the keywords that describe the point. Instrument titles and provision
    numbers are left out: inside the instrument its own title is on every page."""
    terms = [str(k) for k in (keywords or [])
             if not (INSTRUMENT_NAME_RE.search(str(k)) and YEAR_RE.search(str(k))) and not provision_numbers([k])]
    return " ".join([str(question or "")] + terms)


def keyword_hits(index, name, record_id, query, provisions):
    """Passages of one file found by the words they share with the question, and the opening
    passage of any provision the query analysis named."""
    numeric_id = _as_int(record_id)
    res = index.query(
        vector=_PROBE_VECTOR, top_k=KEYWORD_SCAN_CHUNKS, include_metadata=True,
        filter={"source_table": {"$eq": LEGISLATION_TABLE},
                "record_id": {"$eq": numeric_id if numeric_id is not None else record_id}})
    chunks = [describe_db_chunk(match.id, match.metadata) for match in (res.matches or [])]
    hits = []
    for _, chunk in rank_chunks(chunks, query, provisions, top_n=KEYWORD_HITS_PER_RECORD):
        result = as_search_result(chunk, KEYWORD_HIT_SCORE)
        result["governing_instrument"] = name
        result["found_by"] = "keyword"
        opened = next((number for number in provisions if opens_provision(chunk.get("chunk_body"), number)), None)
        if opened:
            # The query analysis named this provision and this passage is where it begins.
            result["named_provision"] = opened
            result["provision_ref"] = f"{_instrument_unit(chunk.get('doc_title'))} {opened}"
        hits.append(result)
    return hits


def focus_on_instruments(index, instruments, query_texts, seed_results, question=None, keywords=None, provisions=None):
    """The passages of the named instruments that best match the question: by meaning (vector
    search inside each file) and by wording (keyword scan of each file)."""
    if index is None or not instruments:
        return []
    embed_queries(list(instruments) + list(query_texts))
    records = find_instrument_records(index, instruments, seed_results)
    vectors = [v for v in (embed_query(text) for text in query_texts if text) if v is not None]
    results = []
    scanned = 0
    lexical_query = keyword_query(question or (query_texts[0] if query_texts else ""), keywords)
    for name, record_ids in records.items():
        for record_id in record_ids:
            if scanned < KEYWORD_SCAN_RECORDS:
                scanned += 1
                results.extend(keyword_hits(index, name, record_id, lexical_query, provisions or []))
            numeric_id = _as_int(record_id)
            for vector in vectors:
                res = index.query(
                    vector=vector, top_k=CHUNKS_PER_RECORD, include_metadata=True,
                    filter={"source_table": {"$eq": LEGISLATION_TABLE},
                            "record_id": {"$eq": numeric_id if numeric_id is not None else record_id}})
                for match in res.matches or []:
                    result = as_search_result(describe_db_chunk(match.id, match.metadata), match.score)
                    result["governing_instrument"] = name
                    results.append(result)
    return results


def _doc_date_key(result):
    return str(result.get("doc_date") or "")


def latest_amendments(index, instruments):
    """The most recent amendment notifications to each named instrument, newest first."""
    if index is None or not instruments:
        return []
    queries = {name: f"{name} (Amendment) - in the said regulations, shall be substituted" for name in instruments}
    embed_queries(list(queries.values()))
    results = []
    for name, query in queries.items():
        vector = embed_query(query)
        if vector is None:
            continue
        res = index.query(vector=vector, top_k=AMENDMENT_LOOKUP_TOP_K, include_metadata=True,
                          filter={"source_table": {"$eq": NOTIFICATION_TABLE}})
        by_record = {}
        for match in res.matches or []:
            doc = describe_db_chunk(match.id, match.metadata)
            title = str(doc.get("doc_title") or "")
            if not re.search(r"amend", title, re.IGNORECASE):
                continue
            # "X (Amendment) Regulations, 2026" amends "X Regulations, 2015": compare without the years.
            if title_match(YEAR_RE.sub("", title), YEAR_RE.sub("", name)) < INSTRUMENT_TITLE_MATCH:
                continue
            best = by_record.get(doc["record_id"])
            if best is None or match.score > best["score"]:
                result = as_search_result(doc, match.score)
                result["governing_instrument"] = name
                result["is_amendment"] = True
                by_record[doc["record_id"]] = result
        newest = sorted(by_record.values(), key=_doc_date_key, reverse=True)[:AMENDMENTS_PER_INSTRUMENT]
        for result in newest:
            year = _as_int(str(result.get("doc_date") or "")[:4])
            result["is_amendment"] = year is not None and date.today().year - year <= RECENT_AMENDMENT_YEARS
        results.extend(newest)
    return results


def with_governing_instruments(results, index, primary_act, keywords, query_texts, question=None, inferred_sections=None):
    """Search results plus the passages and latest amendments of the governing instruments."""
    instruments = named_instruments(primary_act, keywords)
    if not instruments:
        return results
    provisions = provision_numbers(list(inferred_sections or []) + list(keywords or []))
    try:
        extra = focus_on_instruments(index, instruments, query_texts, results, question, keywords, provisions)
        extra += latest_amendments(index, instruments)
    except Exception as e:
        sys.stderr.write(f"[Instrument Focus] Skipped ({e}).\n")
        return results
    seen = {str(r.get("embedding_id")) for r in results}
    merged = list(results)
    for result in extra:
        key = str(result.get("embedding_id"))
        if key not in seen:
            seen.add(key)
            merged.append(result)
    # An amendment notification already found by the general search keeps its flag.
    amendment_ids = {str(r.get("embedding_id")) for r in extra if r.get("is_amendment")}
    for result in merged:
        if str(result.get("embedding_id")) in amendment_ids:
            result["is_amendment"] = True
    return merged
