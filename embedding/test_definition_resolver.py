"""
Offline tests for the parts of definition_resolver.py and instrument_retrieval.py that read
text: finding definitions, their extent, their provision numbers and the chain between them.
No network call is made.

    python -m unittest embedding/test_definition_resolver.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import definition_resolver as resolver  # noqa: E402
import keyword_scan  # noqa: E402
from instrument_retrieval import named_instruments  # noqa: E402

REGULATIONS = (
    "1. Short title and commencement. (1) These regulations may be called the X Regulations, 2015. "
    "2. Definitions. (1) In these regulations, unless the context otherwise requires:-\n"
    "(d) \"connected person\" means,- 86[(i) any person associated with a company that allows access to "
    "unpublished price sensitive information.] (ii) the following shall be deemed to be connected persons: "
    "(a) a relative of connected persons;\n"
    "(g) \"insider\" means any person who is: i) a connected person; or ii) in possession of or having access to "
    "unpublished price sensitive information; 95[NOTE: Since \"generally available information\" is defined, "
    "anyone engaged in trading with such information is an insider.]\n"
    "96[(hc) “relative” shall mean the following: (i) spouse of the person;]\n"
    "(l) \"trading\" means and includes subscribing, buying, selling, dealing in any securities;\n"
    "(n) \"unpublished price sensitive information\" means any information that is not generally available. "
    "Explanation: \"Fraud\" shall have the same meaning as in the fraud regulations.\n"
    "(2) Words and expressions used and not defined in these regulations shall have the meanings in the Act. "
    "CHAPTER – II RESTRICTIONS 3. Communication. 5B. Definitions. (1) For this Chapter, (a) “associate” means X."
)

ACT = (
    "1. Short title. 2.Definitions. In this Act, unless the context otherwise requires,— "
    "1[(1) “abridged prospectus” means a memorandum;\n"
    "(27) ‘control’ shall include the right to appoint majority of the directors;\n"
    "(51) “key managerial personnel”, in relation to a company, means – (i) the Chief Executive Officer;\n"
    "(76) “related party” with reference to a company means – (i) a director or his relative; "
    "(ii) a key managerial personnel or his relative;\n"
    "(77) ‘’relative’’, with reference to any person, means any one who is related to another;\n"
)


def definitions_in(text, root):
    normalized = resolver.normalize_quotes(text)
    match = next(m for m in resolver.DEFINITION_RE.finditer(normalized) if resolver._same_term(m.group("term"), root))
    start, end = resolver.definitions_clause_bounds(normalized, match.start())
    return normalized, {entry["key"]: entry for entry in resolver.index_definitions(normalized, start, end)}


class DefinitionsClause(unittest.TestCase):
    def test_finds_lettered_definitions_and_ignores_explanations_and_later_chapters(self):
        _, by_key = definitions_in(REGULATIONS, "insider")
        self.assertEqual(
            sorted(by_key),
            ["connected person", "insider", "relative", "trading", "unpublished price sensitive information"])
        self.assertNotIn("fraud", by_key)       # an Explanation inside another definition
        self.assertNotIn("associate", by_key)   # defined for a later chapter only

    def test_definition_stops_at_the_end_of_the_clause(self):
        text, by_key = definitions_in(REGULATIONS, "insider")
        last = by_key["unpublished price sensitive information"]
        body = text[last["start"]:last["end"]]
        self.assertIn("Fraud", body)
        self.assertNotIn("Words and expressions", body)
        self.assertNotIn("CHAPTER", body)

    def test_provision_numbers(self):
        text, by_key = definitions_in(REGULATIONS, "insider")
        self.assertEqual(resolver.provision_reference(text, by_key["insider"], "X Regulations, 2015"), "Regulation 2(1)(g)")
        self.assertEqual(resolver.provision_reference(text, by_key["relative"], "X Regulations, 2015"), "Regulation 2(1)(hc)")
        text, by_key = definitions_in(ACT, "control")
        # In the Act "(1)" is the first definition, not a sub-section.
        self.assertEqual(resolver.provision_reference(text, by_key["control"], "Companies Act 2013"), "Section 2(27)")
        self.assertEqual(resolver.provision_reference(text, by_key["related party"], "Companies Act 2013"), "Section 2(76)")

    def test_single_and_doubled_curly_quotes_and_qualified_definitions(self):
        _, by_key = definitions_in(ACT, "control")
        for term in ("control", "relative", "related party", "key managerial personnel", "abridged prospectus"):
            self.assertIn(term, by_key)


class SecondDefinitionsClause(unittest.TestCase):
    CODE = (
        "3. Definitions. In this Code, unless the context otherwise requires, "
        "3[\"creditor\" means any person to whom a debt is owed and includes a financial creditor;]\n"
        "\"debt\" means a liability in respect of a claim;\n"
        "PART II INSOLVENCY RESOLUTION CHAPTER I PRELIMINARY 4. Application of this Part. (1) This Part applies.\n"
        "5[5. Definitions. In this Part, unless the context otherwise requires, "
        "\"financial creditor\" means any person to whom a financial debt is owed;\n"
        "\"financial debt\" means a debt along with interest, if any;\n"
    )

    def test_a_definition_is_attributed_to_its_own_definitions_section(self):
        text, by_key = definitions_in(self.CODE, "financial creditor")
        self.assertEqual(resolver.provision_reference(text, by_key["financial creditor"], "Insolvency and Bankruptcy Code, 2016"), "Section 5")
        self.assertNotIn("creditor", by_key)  # defined in section 3, a different clause
        text, by_key = definitions_in(self.CODE, "creditor")
        self.assertEqual(resolver.provision_reference(text, by_key["creditor"], "Insolvency and Bankruptcy Code, 2016"), "Section 3")


class DefinitionChain(unittest.TestCase):
    def test_follows_the_terms_a_definition_uses_but_not_its_explanatory_note(self):
        text, by_key = definitions_in(REGULATIONS, "insider")
        chain = resolver.definition_chain("insider", by_key, [], text)
        self.assertEqual(chain[:3], ["insider", "connected person", "unpublished price sensitive information"])
        self.assertIn("relative", chain)        # used by "connected person"
        self.assertNotIn("trading", chain)      # appears only in the NOTE under "insider"

    def test_requested_terms_come_before_incidental_ones(self):
        text, by_key = definitions_in(ACT, "related party")
        chain = resolver.definition_chain("related party", by_key, ["key managerial personnel"], text)
        self.assertEqual(chain[:2], ["related party", "key managerial personnel"])
        self.assertIn("relative", chain)


class Titles(unittest.TestCase):
    def test_title_match_needs_the_same_year_and_understands_acronyms(self):
        match = resolver.title_match
        self.assertEqual(match("SEBI (PROHIBITION OF INSIDER TRADING) REGULATIONS, 2015", "SEBI (Prohibition of Insider Trading) Regulations 2015"), 1.0)
        self.assertEqual(match("SEBI (Prohibition of Insider Trading) Regulations, 1992", "SEBI (Prohibition of Insider Trading) Regulations 2015"), 0.0)
        self.assertEqual(match("Foreign Exchange Management Act, 1999", "FEMA 1999"), 1.0)
        self.assertEqual(match("Insolvency and Bankruptcy Code, 2016", "IBC 2016"), 1.0)
        self.assertLess(match("Foreign Exchange Management (Deposit) Regulations, 2016", "FEMA 1999"), resolver.MIN_TITLE_MATCH)

    def test_plural_and_singular_are_one_term(self):
        self.assertTrue(resolver._same_term("persons acting in concert", "person acting in concert"))
        self.assertFalse(resolver._same_term("insider", "connected person"))

    def test_named_instruments_are_titles_with_a_year_and_not_amendments(self):
        names = named_instruments("FEMA 1999", [
            "downstream investment", "Rule 23",
            "Foreign Exchange Management (Non-Debt Instruments) Rules 2019",
            "Companies (Amendment) Act 2017",
            "foreign exchange management (non-debt instruments) rules 2019",
        ])
        self.assertEqual(names, ["Foreign Exchange Management (Non-Debt Instruments) Rules 2019"])


class KeywordScan(unittest.TestCase):
    CHUNKS = [
        {"chunk_body": "(2) The open offer made under regulation 6 shall be for acquisition of at least ten per cent of the shares."},
        {"chunk_body": "CHAPTER II SUBSTANTIAL ACQUISITION OF SHARES, VOTING RIGHTS OR CONTROL 3. Substantial acquisition of shares or "
                       "voting rights. (1) No acquirer shall acquire shares which entitle them to exercise twenty-five per cent or more "
                       "of the voting rights unless the acquirer makes a public announcement of an open offer."},
        {"chunk_body": "Substituted by the Takeover (Amendment) Regulations, 2018 vide Notification dated 11th September 2018."},
    ]

    def test_number_words_and_plurals_match_the_way_questions_are_written(self):
        self.assertIn("25", keyword_scan.tokenize("twenty-five per cent"))
        self.assertEqual(keyword_scan.tokenize("makes shares"), keyword_scan.tokenize("make share"))

    def test_provision_numbers_are_read_with_or_without_their_kind(self):
        self.assertEqual(keyword_scan.provision_numbers(["Regulation 3(1)", "188(1)", "open offer", "Rule 21"]), ["3", "188", "21"])

    def test_the_opening_passage_of_a_named_provision_ranks_first(self):
        self.assertTrue(keyword_scan.opens_provision(self.CHUNKS[1]["chunk_body"], "3"))
        self.assertFalse(keyword_scan.opens_provision(self.CHUNKS[0]["chunk_body"], "3"))
        ranked = keyword_scan.rank_chunks(self.CHUNKS, "When must an acquirer make an open offer? 25% threshold", ["3"], top_n=2)
        self.assertIs(ranked[0][1], self.CHUNKS[1])


if __name__ == "__main__":
    unittest.main()
