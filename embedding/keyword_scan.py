"""
keyword_scan.py

Keyword ranking of the chunks of one instrument (BM25), used alongside the vector search.

Vector search is good at "what is this about" and poor at "which provision says it": inside
the Takeover Regulations, a question about when an open offer must be made is closest in
meaning to forty passages about how an offer is conducted, and the provision that sets the
threshold ("No acquirer shall acquire ... twenty-five per cent or more ...") is not among
them. Counting the words the question and the provision share finds it.

Pure functions: no network, no index.
"""

import math
import re

BM25_K1 = 1.5
BM25_B = 0.75
# A chunk that opens the provision the query analysis named (e.g. "Regulation 3") is ranked
# as if it matched this many extra query words.
PROVISION_HEADING_BONUS = 8.0
MIN_TOKEN_LENGTH = 3

STOP_WORDS = set("""
the and for with that this from are was were has have had not but any all may shall such which who whom whose what when
where how why does did can could would should into upon under over than then them they their there here been being its
his her him our your out also other more most only same per about after before between through during above below
act rules regulations section regulation rule sebi india indian law laws legal provision provisions
""".split())

_UNITS = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5, "six": 6, "seven": 7, "eight": 8, "nine": 9}
_TEENS = {"ten": 10, "eleven": 11, "twelve": 12, "thirteen": 13, "fourteen": 14, "fifteen": 15, "sixteen": 16,
          "seventeen": 17, "eighteen": 18, "nineteen": 19}
_TENS = {"twenty": 20, "thirty": 30, "forty": 40, "fifty": 50, "sixty": 60, "seventy": 70, "eighty": 80, "ninety": 90}
_NUMBER_WORD_RE = re.compile(
    r"\b(" + "|".join(_TENS) + r")(?:[\s-]+(" + "|".join(_UNITS) + r"))?\b|\b(" + "|".join(list(_TEENS) + list(_UNITS)) + r")\b",
    re.IGNORECASE)
_TOKEN_RE = re.compile(r"[a-z]+|\d+")
_PROVISION_RE = re.compile(r"\b(?:section|sec\.?|regulation|reg\.?|rule|article|clause)\s*(\d{1,3}[A-Z]{0,2})\b", re.IGNORECASE)


def _number_words_to_digits(text):
    """"twenty-five per cent" and "25%" are the same threshold; statutes use the first form."""
    def replace(match):
        if match.group(1):
            return str(_TENS[match.group(1).lower()] + _UNITS.get((match.group(2) or "").lower(), 0))
        word = match.group(3).lower()
        return str(_TEENS.get(word) or _UNITS.get(word))
    return _NUMBER_WORD_RE.sub(replace, text)


def _stem(token):
    """make / makes / making and share / shares count as one word."""
    for suffix in ("ing", "ed", "s"):
        if token.endswith(suffix) and len(token) - len(suffix) >= 4:
            return token[:-len(suffix)]
    return token


def tokenize(text):
    lowered = _number_words_to_digits(str(text or "").lower())
    return [t if t.isdigit() else _stem(t) for t in _TOKEN_RE.findall(lowered)
            if (t.isdigit() or len(t) >= MIN_TOKEN_LENGTH) and t not in STOP_WORDS]


_BARE_PROVISION_RE = re.compile(r"^\s*(\d{1,3}[A-Z]{0,2})\b")


def provision_numbers(texts):
    """Provision numbers named in the query analysis: "Regulation 3(1)" -> "3"; "188(1)" -> "188"."""
    numbers = []
    for text in texts or []:
        found = [m.group(1) for m in _PROVISION_RE.finditer(str(text or ""))]
        bare = _BARE_PROVISION_RE.match(str(text or ""))
        if not found and bare:
            found = [bare.group(1)]
        for number in found:
            if number not in numbers:
                numbers.append(number)
    return numbers


def opens_provision(body, number):
    """True when the chunk contains the heading of that provision ("3. Substantial acquisition ...")."""
    # The heading follows a line break, the end of the previous provision, or a chapter title
    # in capitals ("... OR CONTROL 3. Substantial acquisition of shares or voting rights.").
    pattern = (r"(?:^|\n|[.;:\]]\s|[A-Z]{2,}\s)\s*" + re.escape(number)
               + r"\.\s{0,3}(?:\d{0,3}\[)?\s*(?:\(\d{1,2}\)\s*)?[A-Z]")
    return re.search(pattern, str(body or "")) is not None


def rank_chunks(chunks, query_text, provisions=None, top_n=4):
    """The `top_n` chunks that share most with the query, best first.

    @param chunks      [{"chunk_body": str, ...}] the chunks of one instrument
    @param query_text  the question with the leading keywords of the query analysis
    @param provisions  provision numbers named by the query analysis
    @returns [(score, chunk)]
    """
    documents = [tokenize(chunk.get("chunk_body")) for chunk in chunks]
    query_terms = list(dict.fromkeys(tokenize(query_text)))
    if not documents or not query_terms:
        return []

    average_length = sum(len(d) for d in documents) / len(documents) or 1.0
    document_frequency = {term: sum(1 for d in documents if term in set(d)) for term in query_terms}
    total = len(documents)

    scored = []
    for chunk, tokens in zip(chunks, documents):
        if not tokens:
            continue
        counts = {}
        for token in tokens:
            counts[token] = counts.get(token, 0) + 1
        score = 0.0
        for term in query_terms:
            frequency = counts.get(term, 0)
            if not frequency:
                continue
            idf = math.log(1 + (total - document_frequency[term] + 0.5) / (document_frequency[term] + 0.5))
            score += idf * frequency * (BM25_K1 + 1) / (
                frequency + BM25_K1 * (1 - BM25_B + BM25_B * len(tokens) / average_length))
        if any(opens_provision(chunk.get("chunk_body"), number) for number in (provisions or [])):
            score += PROVISION_HEADING_BONUS
        if score > 0:
            scored.append((score, chunk))
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[:top_n]
