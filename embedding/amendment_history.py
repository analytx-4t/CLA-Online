"""
amendment_history.py

Finds where the amendment history of a legislation file begins.

Every legislation file in the index is the consolidated text of the instrument, as amended,
followed by a block of footnotes that records each amendment and, for most of them, the
wording the provision had before ("Substituted by ... w.e.f. 01-04-2019. Prior to
substitution it read as: ..."). That block is a history of superseded text. Given to the
answer model as if it were the law, it produces answers that mix the old wording with the
new. The block starts with a heading ("Footnote", "End Notes") or, where there is none, with
a numbered list of amendment notes ("1. Inserted by ...", "2. Substituted for ...").

Pure functions: no network, no index.
"""

import re

AMENDMENT_VERBS = (
    r"(?:Inserted|Substituted|Omitted|Added|Enforced|Renumbered|Re-numbered|Amended|Deleted|Brought\s+into\s+force|"
    r"Came\s+into\s+force|Words?|Clause|Sub-?clause|Sub-?section|Sub-?regulation|Proviso|Explanation|Ins\.|Subs\.)"
)
# "Footnote(s)", "End Notes", "Notes:" as a heading, then a first entry that is an amendment note.
# (A schedule's form can have its own "Notes: 1) The promoter group ..."; that is not history.)
HEADING_RE = re.compile(
    r"(?:^|\n|(?<=[.;:\]])[ \t]+)[ \t]*(?:Foot\s*-?\s*notes?|End\s*-?\s*Notes?|Notes?)[ \t]*:?[ \t]*\r?\n\s*1\s*[.)]\s*"
    + AMENDMENT_VERBS + r"\b",
    re.IGNORECASE)
# "1. Inserted by ..." at the start of a line or after a full stop; it must be followed by "2. <verb>".
FIRST_ENTRY_RE = re.compile(r"(?:^|\n|(?<=[.\]])\s)[ \t]*1\s*[.)]\s*" + AMENDMENT_VERBS + r"\b", re.IGNORECASE)
SECOND_ENTRY_RE = re.compile(r"(?:^|\n|\s)2\s*[.)]\s*" + AMENDMENT_VERBS + r"\b", re.IGNORECASE)
SECOND_ENTRY_WINDOW = 3000
# Superseded wording quoted inside an amendment note.
PRIOR_WORDING_RE = re.compile(
    r"prior to (?:its |the )?(?:substitution|omission|amendment|insertion|deletion)|before (?:its )?(?:substitution|amendment)|"
    r"(?:it|which|this) (?:was )?(?:read|stood) as(?: under)?\s*[:\-]",
    re.IGNORECASE)


def history_start(text):
    """Character offset where the amendment history begins in a file's stitched text, or None."""
    text = str(text or "")
    heading = HEADING_RE.search(text)
    if heading:
        return heading.start() + (1 if text[heading.start():heading.start() + 1] == "\n" else 0)
    for entry in FIRST_ENTRY_RE.finditer(text):
        if SECOND_ENTRY_RE.search(text, entry.end(), entry.end() + SECOND_ENTRY_WINDOW):
            start = entry.start()
            while start < len(text) and text[start] in "\r\n \t":
                start += 1
            return start
    return None


def locate_history(chunks):
    """Where the amendment history of one file starts, as (chunk_index, offset in that chunk's
    body), or None. `chunks` are the file's chunks in order, each {"chunk_index", "chunk_body"}.
    Chunk bodies overlap a little at hard cuts; the search runs on each chunk joined to the
    start of the next so a heading split across two chunks is still found."""
    ordered = sorted(chunks, key=lambda c: c["chunk_index"])
    text, spans = "", []
    for chunk in ordered:
        if text:
            text += "\n"
        start = len(text)
        text += chunk.get("chunk_body") or ""
        spans.append((start, len(text), chunk["chunk_index"]))
    position = history_start(text)
    if position is None:
        return None
    for start, end, chunk_index in spans:
        if position < end:
            return chunk_index, max(0, position - start)
    # The history starts exactly at the separator after the last chunk.
    return None


SAME_NOTE_GAP = 60  # "Prior to substitution it read as:" matches twice; that is one note


def count_prior_wording(text):
    count, last_end = 0, -SAME_NOTE_GAP - 1
    for match in PRIOR_WORDING_RE.finditer(str(text or "")):
        if match.start() - last_end > SAME_NOTE_GAP:
            count += 1
        last_end = match.end()
    return count
