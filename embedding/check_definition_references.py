"""
Live check (reads the index): the statutory definitions the answer pipeline pins must carry
the right provision number. A wrong number here becomes a wrong citation in an answer.

    python embedding/check_definition_references.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import definition_resolver as dr  # noqa: E402

CASES = [
    (["financial creditor"], "Insolvency and Bankruptcy Code 2016", "Section 5"),
    (["insider"], "SEBI (Prohibition of Insider Trading) Regulations 2015", "Regulation 2(1)(g)"),
    (["unpublished price sensitive information"], "SEBI (Prohibition of Insider Trading) Regulations 2015", "Regulation 2(1)(n)"),
    (["related party"], "Companies Act 2013", "Section 2(76)"),
    (["control"], "Companies Act 2013", "Section 2(27)"),
    (["control"], "SEBI (Substantial Acquisition of Shares and Takeovers) Regulations 2011", "Regulation 2(1)(e)"),
    (["persons acting in concert"], "SEBI (Substantial Acquisition of Shares and Takeovers) Regulations 2011", "Regulation 2(1)(q)"),
    (["person resident in India"], "FEMA 1999", "Section 2"),
    (["material subsidiary"], "SEBI (Listing Obligations and Disclosure Requirements) Regulations 2015", "Regulation 16(1)(c)"),
]
bad = 0
for terms, act, expected in CASES:
    found = dr.resolve_definitions(terms, act)
    got = found[0]["provision_ref"] if found else None
    ok = got == expected
    bad += 0 if ok else 1
    print(("PASS" if ok else "FAIL"), terms[0], "|", act[:50], "| expected", expected, "| got", got)
print(f"{len(CASES) - bad}/{len(CASES)} provision references correct")
sys.exit(1 if bad else 0)
