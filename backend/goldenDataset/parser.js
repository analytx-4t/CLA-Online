const XLSX = require('xlsx');

const EXPECTED_HEADERS = [
  'id',
  'question',
  'intent',
  'answer',
  'source_table',
  'source_column',
  'row_id',
  'notes',
];

function normalizeHeader(value) {
  return String(value || '').trim().toLowerCase();
}

function parseWorkbookBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const datasetSheet = workbook.SheetNames.find((name) => normalizeHeader(name) !== 'readme');

  if (!datasetSheet) {
    throw new Error('No dataset worksheet found.');
  }

  const sheet = workbook.Sheets[datasetSheet];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) {
    return [];
  }

  const headers = Object.keys(rows[0] || {});
  const headerMap = new Map(headers.map((header, index) => [normalizeHeader(header), index]));

  const missingHeaders = EXPECTED_HEADERS.filter((header) => !headerMap.has(header));
  if (missingHeaders.length > 0) {
    throw new Error(`Missing required columns: ${missingHeaders.join(', ')}`);
  }

  return rows.map((row) => ({
    id: String(row[headers[headerMap.get('id')]] ?? '').trim(),
    question: String(row[headers[headerMap.get('question')]] ?? '').trim(),
    intent: String(row[headers[headerMap.get('intent')]] ?? '').trim(),
    answer: String(row[headers[headerMap.get('answer')]] ?? '').trim(),
    sourceTable: String(row[headers[headerMap.get('source_table')]] ?? '').trim(),
    sourceColumn: String(row[headers[headerMap.get('source_column')]] ?? '').trim(),
    rowId: String(row[headers[headerMap.get('row_id')]] ?? '').trim(),
    notes: String(row[headers[headerMap.get('notes')]] ?? '').trim(),
  }));
}

module.exports = {
  parseWorkbookBuffer,
};
