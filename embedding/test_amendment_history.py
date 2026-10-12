"""
Offline tests for amendment_history.py: where a legislation file's footnote block of
superseded wording begins. No network call is made.

    python -m unittest embedding/test_amendment_history.py
"""

import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from amendment_history import count_prior_wording, history_start, locate_history  # noqa: E402

OPERATIVE = "(1) No acquirer shall acquire twenty-five per cent or more of the voting rights.\r\n"
NOTES = ('1. Substituted by the Amendment Regulations, 2013 w.e.f. 26-03-2013. Prior to substitution it read as: '
         '"(1) fifteen per cent" 2. Inserted by the Amendment Regulations, 2018.')


class HistoryStart(unittest.TestCase):
    def test_heading_variants(self):
        for heading in ("Footnote", "FOOTNOTES", "End Notes", "FOOTNOTES:"):
            text = OPERATIVE + "\r\n" + heading + "\r\n" + NOTES
            self.assertEqual(text[history_start(text):].split("\r\n")[0].strip(), heading)

    def test_numbered_notes_without_a_heading(self):
        text = OPERATIVE + NOTES
        self.assertTrue(text[history_start(text):].startswith("1. Substituted"))

    def test_a_forms_notes_list_is_not_history(self):
        text = OPERATIVE + "Notes:\r\n1) The Promoter Group shareholders are listed. 2) Includes all options.\r\n"
        self.assertIsNone(history_start(text))

    def test_operative_numbering_is_not_history(self):
        text = "1. Short title and commencement. (1) These rules may be called X. 2. Definitions. In these rules"
        self.assertIsNone(history_start(text))


class LocateHistory(unittest.TestCase):
    def test_heading_split_across_chunks_maps_to_the_right_chunk_and_offset(self):
        chunks = [
            {"chunk_index": 0, "chunk_body": OPERATIVE},
            {"chunk_index": 1, "chunk_body": "Regulation, 2011.\r\n\r\nEnd Notes\r\n1."},
            {"chunk_index": 2, "chunk_body": "Inserted by the Amendment Regulations, 2012. 2. Substituted for the words."},
        ]
        index, offset = locate_history(chunks)
        self.assertEqual(index, 1)
        self.assertTrue(chunks[1]["chunk_body"][offset:].startswith("End Notes"))

    def test_superseded_wording_is_counted(self):
        self.assertEqual(count_prior_wording(NOTES), 1)


if __name__ == "__main__":
    unittest.main()
