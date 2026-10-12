"""
definition_resolver.py

Reads statutory definitions straight out of the governing instrument, and completes
provisions that the indexer cut across chunks.

resolve_definitions(terms, primary_act)
    Finds the definitions clause of the governing Act / Rules / Regulations, reads the
    definition of the root term, then follows every defined term used inside that definition
    (insider -> connected person -> unpublished price sensitive information -> ...). Each
    definition is returned whole, labelled with its provision number, so the answer can state
    the statutory text instead of a paraphrase from an article.

expand_passages(ids)
    Appends the continuation of a legislation chunk so a provision is not read half-way.
"""

import re
import sys

from search_documents import (
    _PROBE_VECTOR,
    _as_int,
    _trim_overlap,
    as_search_result,
    describe_db_chunk,
    embed_query,
    get_pinecone_db_index,
)

LEGISLATION_TABLE = "Legislation"

MAX_ROOT_CANDIDATES = 3        # listed terms tried, in order, as the root definition
MAX_TERMS = 4                  # definitions pinned per question, root term included
MIN_LETTERED_SHARE = 0.6       # share of lettered definitions above which unlettered ones are Explanations
MAX_DEFINITION_CHARS = 4500    # a long definition (e.g. "connected person") is cut here
ANCHOR_CANDIDATES = 100        # legislation chunks looked at to find the governing instrument
MAX_CANDIDATE_RECORDS = 3      # files of the governing instrument whose definitions clause is read
WINDOW_BEFORE = 80             # chunks read either side of a chunk known to hold the definition
WINDOW_AFTER = 45
HEAD_WINDOW = 125              # chunks read from the start of a file when no such chunk is known
MIN_TITLE_MATCH = 0.6          # share of the governing instrument's name found in a chunk's title
MAX_STITCHED_CHARS = 3200

_QUOTE_OPEN = "[\"“�]"
_QUOTE_CLOSE = "[\"”�]"
_NOT_QUOTE = "[^\"“”�\n]"
_DEFINITION_VERBS = (
    r"(?:means|shall mean|includes|shall include|shall have the (?:same )?meaning|"
    r"has the (?:same )?meaning|in relation to)"
)
# (g) "insider" means ...   |   96[(hc) “relative” shall mean ...   |   (27) "control" shall include ...
# (76) “related party” with reference to a company means ...
DEFINITION_RE = re.compile(
    r"(?:\(\s*(?P<clause>[a-z]{1,3}|\d{1,3}[A-Za-z]{0,2})\s*\)\]?\s*)?"
    + _QUOTE_OPEN + r"\s*(?P<term>[A-Za-z]" + _NOT_QUOTE + r"{1,80}?)\s*" + _QUOTE_CLOSE
    + r"(?:\s*(?:or|and)\s*" + _QUOTE_OPEN + _NOT_QUOTE + r"{1,60}" + _QUOTE_CLOSE + r")?"
    + r"\s*,?\s*(?:[^.;:\n\"“”]{0,60}?,?)?\s*(?P<verb>" + _DEFINITION_VERBS + r")\b",
    re.IGNORECASE,
)
# Where the definitions clause stops: the residuary sub-clause or the next chapter heading.
DEFINITIONS_END_RE = re.compile(r"\(\d{1,2}\)\s*Words and expressions used|\bCHAPTER\s*[\u2013\u2014-]?\s*[IVX]{1,5}\b")
# Explanatory notes under a definition mention other terms in passing; only the operative
# words decide which further definitions are needed.
EXPLANATORY_NOTE_RE = re.compile(r"\d{0,3}\[?\s*NOTE\s*:", re.IGNORECASE)
# "2. Definitions." however it is led into: after a line break, a chapter title in capitals
# ("PRELIMINARY 5. Definitions.") or a footnote marker ("5[5. Definitions."). Missing one of
# these would attribute a definition to the previous definitions clause, i.e. to the wrong section.
DEFINITIONS_HEADING_RE = re.compile(r"(?<![\w(.])(\d{1,3}[A-Z]{0,2})\.\s{0,3}(?:Definitions?|Interpretation)\b")

# Defined in almost every instrument and never what a question turns on.
GENERIC_TERMS = {
    "act", "board", "company", "companies", "securities", "government", "central government",
    "rules", "regulations", "specified", "prescribed", "tribunal", "schedule", "section",
    "person", "persons", "notification", "body corporate",
}
TITLE_STOP_WORDS = {"the", "of", "and", "for", "act", "rules", "regulations", "sebi", "india", "board"}


# Some Acts quote defined terms with single curly quotes, sometimes doubled: ‘control’,
# ‘’relative’’. An apostrophe inside a word (company’s) is left alone.
_SINGLE_QUOTE_OPEN_RE = re.compile(r"(?<![A-Za-z])[‘’]{1,2}(?=[A-Za-z])")
_SINGLE_QUOTE_CLOSE_RE = re.compile(r"(?<=[A-Za-z])[‘’]{1,2}(?![A-Za-z])")


def normalize_quotes(text):
    """Defined terms in one quoting style, so a single pattern finds every definition."""
    return _SINGLE_QUOTE_CLOSE_RE.sub('"', _SINGLE_QUOTE_OPEN_RE.sub('"', str(text or "")))


def normalize_term(term):
    return re.sub(r"\s+", " ", str(term or "").strip().strip("\"“”'").lower())


def _singular(term):
    return " ".join(word[:-1] if len(word) > 3 and word.endswith("s") else word for word in normalize_term(term).split())


def _same_term(a, b):
    """"persons acting in concert" and "person acting in concert" are the same defined term."""
    return bool(normalize_term(a)) and _singular(a) == _singular(b)


# How instruments are commonly abbreviated in questions and in the query analysis.
INSTRUMENT_ACRONYMS = {
    "fema": "foreign exchange management act",
    "fera": "foreign exchange regulation act",
    "ibc": "insolvency and bankruptcy code",
    "ni act": "negotiable instruments act",
    "pmla": "prevention of money-laundering act",
    "sarfaesi": "securitisation and reconstruction of financial assets and enforcement of security interest act",
    "scra": "securities contracts (regulation) act",
    "llp act": "limited liability partnership act",
    "lodr": "listing obligations and disclosure requirements",
    "sast": "substantial acquisition of shares and takeovers",
    "icdr": "issue of capital and disclosure requirements",
    "pit regulations": "prohibition of insider trading regulations",
    "ndi rules": "non-debt instruments rules",
}


def expand_acronyms(name):
    """"FEMA 1999" -> "foreign exchange management act 1999"."""
    text = " ".join(str(name or "").lower().split())
    for acronym, full in INSTRUMENT_ACRONYMS.items():
        text = re.sub(r"\b" + re.escape(acronym) + r"\b", full, text)
    return text


def title_match(title, primary_act):
    """Share of the governing instrument's distinctive words (and its year) present in a title."""
    if not primary_act:
        return 0.0
    title_text = str(title or "").lower()
    words = [w for w in re.findall(r"[a-z]{3,}|\d{4}", expand_acronyms(primary_act)) if w not in TITLE_STOP_WORDS]
    if not words:
        return 0.0
    years = [w for w in words if w.isdigit()]
    title_years = re.findall(r"(?:19|20)\d{2}", title_text)
    if years and title_years and not set(years) & set(title_years):
        return 0.0  # same name, different year: the superseded or a later instrument
    return sum(1 for w in words if w in title_text) / len(words)


def _instrument_unit(title):
    lowered = str(title or "").lower()
    if "regulation" in lowered:
        return "Regulation"
    if "rules" in lowered:
        return "Rule"
    return "Section"


def find_definition_windows(index, term, primary_act):
    """Where to look for the definition of `term`: [(record_id, chunk position or None)].

    A search for one short term does not reliably surface the definitions chunk of a long
    Act, so the search is only used to find the files of the governing instrument. A chunk
    that visibly defines the term is read first; otherwise each file is read from its start,
    where the definitions clause sits."""
    scope = primary_act or "the governing law"
    vector = embed_query(f'{scope} - Definitions. Unless the context otherwise requires, "{term}" means')
    if vector is None:
        return []
    res = index.query(vector=vector, top_k=ANCHOR_CANDIDATES, include_metadata=True,
                      filter={"source_table": {"$eq": LEGISLATION_TABLE}})
    defining, records = [], {}
    for match in res.matches or []:
        doc = describe_db_chunk(match.id, match.metadata)
        in_governing_instrument = title_match(doc["doc_title"], primary_act) >= MIN_TITLE_MATCH
        if primary_act and not in_governing_instrument:
            continue  # a definition from some other instrument must not be pinned as the governing one
        defines = any(_same_term(found.group("term"), term)
                      for found in DEFINITION_RE.finditer(normalize_quotes(doc["chunk_body"])))
        if defines:
            defining.append((doc["record_id"], _as_int(doc["chunk_index"]) or 0))
        elif primary_act:
            records.setdefault(doc["record_id"], float(match.score))
    windows = defining[:MAX_CANDIDATE_RECORDS]
    seen = {record_id for record_id, _ in windows}
    for record_id, _ in sorted(records.items(), key=lambda item: item[1], reverse=True):
        if len(windows) >= MAX_CANDIDATE_RECORDS:
            break
        if record_id not in seen:
            windows.append((record_id, None))
    return windows


def read_window(index, record_id, position=None):
    """Chunks of one legislation file, stitched into one text: the chunks around `position`,
    or the start of the file when no position is given.
    Returns (text, spans) where spans = [(start, end, chunk_doc)]."""
    numeric_id = _as_int(record_id)
    first = 0 if position is None else max(0, position - WINDOW_BEFORE)
    last = HEAD_WINDOW if position is None else position + WINDOW_AFTER
    res = index.query(
        vector=_PROBE_VECTOR, top_k=last - first + 1, include_metadata=True,
        filter={"source_table": {"$eq": LEGISLATION_TABLE},
                "record_id": {"$eq": numeric_id if numeric_id is not None else record_id},
                "chunk_index": {"$gte": first, "$lte": last}})
    # The footnotes quote superseded definitions ("Prior to substitution it read as: (23) ...
    # means ..."); only the operative text is read.
    docs = sorted((doc for doc in (describe_db_chunk(m.id, m.metadata) for m in (res.matches or []))
                   if not doc.get("amendment_history")), key=lambda d: d["chunk_index"])
    text, spans, previous_body, previous_index = "", [], "", None
    for doc in docs:
        body = doc["chunk_body"]
        adjacent = previous_index is not None and doc["chunk_index"] == previous_index + 1
        piece = normalize_quotes(_trim_overlap(previous_body, body) if adjacent else body)
        if text and not text.endswith(("\n", " ")):
            text += " "
        start = len(text)
        text += piece
        spans.append((start, len(text), doc))
        previous_body, previous_index = body, doc["chunk_index"]
    return text, spans


def definitions_clause_bounds(text, position):
    """Start and end of the definitions clause that contains `position`. Definitions made
    for a single later provision ("for the purposes of this regulation ...") lie outside it."""
    headings = [h for h in DEFINITIONS_HEADING_RE.finditer(text[:position])]
    start = headings[-1].start() if headings else 0
    end_match = DEFINITIONS_END_RE.search(text, position)
    return start, (end_match.start() if end_match else len(text))


def index_definitions(text, start=0, end=None):
    """Every definition in text[start:end], in order: [{term, start, end, clause}]."""
    end = len(text) if end is None else end
    entries, seen = [], set()
    for found in DEFINITION_RE.finditer(text, start, end):
        key = normalize_term(found.group("term"))
        if key in seen:
            continue
        seen.add(key)
        entries.append({"term": found.group("term").strip(), "key": key, "start": found.start(),
                        "clause": found.group("clause")})
    # In a clause whose definitions are lettered or numbered, a quoted term with no letter of
    # its own is an Explanation inside another definition ("Fraud" inside the definition of
    # unpublished price sensitive information). It stays part of that definition.
    lettered = [entry for entry in entries if entry["clause"]]
    if len(lettered) >= MIN_LETTERED_SHARE * len(entries):
        entries = lettered
    for i, entry in enumerate(entries):
        next_start = entries[i + 1]["start"] if i + 1 < len(entries) else end
        clause_end = DEFINITIONS_END_RE.search(text, entry["start"] + 1, next_start)
        definition_end = clause_end.start() if clause_end else next_start
        entry["end"] = min(definition_end, entry["start"] + MAX_DEFINITION_CHARS)
    return entries


def operative_text(definition_text):
    """A definition without its explanatory note."""
    note = EXPLANATORY_NOTE_RE.search(definition_text)
    return definition_text[:note.start()] if note else definition_text


def provision_reference(text, entry, title):
    """"Regulation 2(1)(g)" for a definition, read from the clause heading above it."""
    headings = list(DEFINITIONS_HEADING_RE.finditer(text[:entry["start"]]))
    clause = f"({entry['clause']})" if entry.get("clause") else ""
    if not headings:
        return f"clause {clause}" if clause else None
    heading = headings[-1]
    after_heading = text[heading.end():heading.end() + 60]
    # "2. Definitions.—(1) In these regulations ..." has a sub-regulation (1). In
    # "2. Definitions.—In this Act ...— (1) "abridged prospectus" means" the (1) is the first
    # definition, not a sub-section: a sub-clause number is followed by words, not a quote.
    sub_clause = re.match(r"[\s.—–:-]*(?:\d{1,3}[A-Z]{0,2}\.\s*)?(?:\d{1,3}\[)?\s*(\(\d{1,2}\))\s*(?=[A-Za-z])", after_heading)
    return f"{_instrument_unit(title)} {heading.group(1)}{sub_clause.group(1) if sub_clause else ''}{clause}"


def _terms_used_in(definition_text, entries, own_key):
    """Other defined terms that appear inside one definition, in order of appearance."""
    used = []
    for entry in entries:
        if entry["key"] == own_key or entry["key"] in GENERIC_TERMS or len(entry["key"]) < 4:
            continue
        found = re.search(r"\b" + re.escape(entry["key"]) + r"s?\b", definition_text, re.IGNORECASE)
        if found:
            used.append((found.start(), entry["key"]))
    return [key for _, key in sorted(used)]


def definition_chain(root_key, by_key, requested_keys, text):
    """Root term, then the defined terms its definition uses, then theirs (two levels deep)."""
    chain = [root_key]

    def add(keys):
        for key in keys:
            if key in by_key and key not in chain and len(chain) < MAX_TERMS:
                chain.append(key)

    root = by_key[root_key]
    first_level = _terms_used_in(operative_text(text[root["start"]:root["end"]]), list(by_key.values()), root_key)
    # Terms the query analysis asked for come first; a long definition can use a dozen
    # defined terms and only some of them matter to the question.
    add(requested_keys)
    add(first_level)
    for key in list(chain[1:]):
        entry = by_key[key]
        add(_terms_used_in(operative_text(text[entry["start"]:entry["end"]]), list(by_key.values()), key))
    return chain


def resolve_definitions(terms, primary_act=None):
    """Whole statutory definitions for the root term and the defined terms it depends on."""
    terms = [t for t in (str(t or "").strip() for t in (terms or [])) if t and t.lower() != "none"]
    index = get_pinecone_db_index()
    if not terms or index is None:
        return []

    # The first listed term that the instrument actually defines is the root. (The query
    # analysis sometimes leads with a term the instrument uses but does not define, such as
    # "designated persons"; the definitions it depends on are still wanted.)
    text, spans, by_key, root_key, root_term = "", [], {}, None, None
    for candidate in terms[:MAX_ROOT_CANDIDATES]:
        for record_id, position in find_definition_windows(index, candidate, primary_act):
            text, spans = read_window(index, record_id, position)
            root_match = next((found for found in DEFINITION_RE.finditer(text) if _same_term(found.group("term"), candidate)), None)
            if root_match is None:
                continue
            clause_start, clause_end = definitions_clause_bounds(text, root_match.start())
            by_key = {entry["key"]: entry for entry in index_definitions(text, clause_start, clause_end)}
            root_key = next((key for key in by_key if _same_term(key, candidate)), None)
            if root_key is not None:
                break
        if root_key is not None:
            root_term = candidate
            break
        sys.stderr.write(f"[Definitions] No definition of \"{candidate}\" found in {primary_act or 'the legislation index'}.\n")
    if root_key is None:
        return []

    requested_keys = [key for term in terms if term != root_term for key in by_key if _same_term(key, term)]
    chain = definition_chain(root_key, by_key, requested_keys, text)

    results = []
    for depth, key in enumerate(chain):
        entry = by_key[key]
        covering = [doc for start, end, doc in spans if start < entry["end"] and end > entry["start"]]
        if not covering:
            continue
        lead = covering[0]
        definition_text = text[entry["start"]:entry["end"]].strip()
        reference = provision_reference(text, entry, lead["doc_title"])
        header = f"[Legislation | Title: {lead['doc_title']} | File: {lead['file_name']}"
        header += f" | Provision: {reference}]" if reference else "]"
        doc = dict(lead)
        doc.update({
            "chunk_body": definition_text,
            "chunk_text": f"{header}\n{definition_text}",
            "pinned": True,
            "defined_term": entry["term"],
            "provision_ref": reference,
            "definition_depth": depth,
            # Only chunks lying wholly inside the definition are replaced by it. A chunk the
            # definition merely runs into (the last definition and the start of the next
            # chapter share one) keeps its place in the search results.
            "covers_chunk_ids": [d["embedding_id"] for start, end, d in spans
                                 if start >= entry["start"] and end <= entry["end"]],
        })
        results.append(as_search_result(doc, score=1.0))
    return results


def stitch_primary_passages(results):
    """Completes each legislation search result with the chunk that follows it."""
    expanded = expand_passages([r.get("embedding_id") for r in results if not r.get("is_book")])
    for result in results:
        extra = expanded.get(str(result.get("embedding_id")))
        if not extra:
            continue
        body = result.get("chunk_body") or ""
        chunk_text = result.get("chunk_text") or ""
        header = chunk_text[:len(chunk_text) - len(body)] if body and chunk_text.endswith(body) else ""
        result["chunk_body"] = extra["chunk_body"]
        result["chunk_text"] = header + extra["chunk_body"]
        result["covers_chunk_ids"] = extra["covers_chunk_ids"]
    return results


MAX_OTHER_INSTRUMENTS = 2


def with_definitions(results, terms, primary_act=None, other_instruments=None):
    """Search results with the resolved statutory definitions placed first. A result whose
    chunk is already inside a resolved definition is dropped, so no passage appears twice.

    The chain of definitions comes from the primary instrument. Where the question engages
    other instruments that define the same root term ("control" under the Companies Act and
    under the Takeover Regulations), their definition of that term is added as well."""
    definitions = resolve_definitions(terms, primary_act)
    if terms and other_instruments:
        seen_titles = {d["doc_title"] for d in definitions}
        others = [name for name in other_instruments
                  if not primary_act or title_match(name, primary_act) < MIN_TITLE_MATCH][:MAX_OTHER_INSTRUMENTS]
        for name in others:
            for definition in resolve_definitions(terms[:1], name)[:1]:
                if definition["doc_title"] not in seen_titles:
                    seen_titles.add(definition["doc_title"])
                    definition["definition_depth"] = len(definitions)
                    definitions.append(definition)
    covered = {chunk_id for d in definitions for chunk_id in d.get("covers_chunk_ids", [])}
    return definitions + [r for r in results if str(r.get("embedding_id")) not in covered]


def expand_passages(ids):
    """Continuation text for legislation chunks: {id: {"chunk_body", "covers_chunk_ids"}}.
    A chunk that is itself in `ids` is never appended to another one."""
    index = get_pinecone_db_index()
    selected = {str(i) for i in (ids or [])}
    if index is None or not selected:
        return {}

    next_positions = {}  # record_id -> {position of the chunk to complete}
    for vector_id in selected:
        parts = vector_id.split("|")
        position = _as_int(parts[-1]) if len(parts) == 3 else None
        if position is None or parts[0] != LEGISLATION_TABLE:
            continue
        if f"{parts[0]}|{parts[1]}|{position + 1}" not in selected:
            next_positions.setdefault(parts[1], set()).add(position)

    expanded = {}
    for record_id, positions in next_positions.items():
        numeric_id = _as_int(record_id)
        wanted = sorted({p for position in positions for p in (position, position + 1)})
        res = index.query(
            vector=_PROBE_VECTOR, top_k=len(wanted), include_metadata=True,
            filter={"source_table": {"$eq": LEGISLATION_TABLE},
                    "record_id": {"$eq": numeric_id if numeric_id is not None else record_id},
                    "chunk_index": {"$in": wanted}})
        bodies = {}
        for match in res.matches or []:
            doc = describe_db_chunk(match.id, match.metadata)
            if not doc.get("amendment_history"):
                bodies[doc["chunk_index"]] = doc["chunk_body"]
        for position in positions:
            body, following = bodies.get(position), bodies.get(position + 1)
            if not body or not following:
                continue
            vector_id = f"{LEGISLATION_TABLE}|{record_id}|{position}"
            stitched = f"{body.rstrip()} {_trim_overlap(body, following).lstrip()}"[:MAX_STITCHED_CHARS]
            expanded[vector_id] = {"chunk_body": stitched,
                                   "covers_chunk_ids": [vector_id, f"{LEGISLATION_TABLE}|{record_id}|{position + 1}"]}
    return expanded
