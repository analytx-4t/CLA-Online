const test = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseWorkbookBuffer } = require('../goldenDataset/parser');

test('parseWorkbookBuffer ignores README sheet and reads the dataset sheet', () => {
  const workbook = XLSX.utils.book_new();

  const data = [
    ['id', 'question', 'intent', 'answer', 'source_table', 'source_column', 'row_id', 'notes'],
    ['1', 'What is the law?', 'legal', 'The law says so.', 'cases', 'summary', '42', 'Example note'],
  ];

  const sheet = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(workbook, sheet, 'Dataset');

  const readmeSheet = XLSX.utils.aoa_to_sheet([['ignore me']]);
  XLSX.utils.book_append_sheet(workbook, readmeSheet, 'README');

  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  const records = parseWorkbookBuffer(buffer);

  assert.equal(records.length, 1);
  assert.deepEqual(records[0], {
    id: '1',
    question: 'What is the law?',
    intent: 'legal',
    answer: 'The law says so.',
    sourceTable: 'cases',
    sourceColumn: 'summary',
    rowId: '42',
    notes: 'Example note',
  });
});
