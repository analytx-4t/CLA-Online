const XLSX = require('xlsx');

const REQUIRED_HEADERS = ['question', 'reference'];

function normalizeHeader(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function findDatasetSheet(workbook) {
  return workbook.SheetNames.find((name) => normalizeHeader(name) !== 'readme') || workbook.SheetNames[0] || null;
}

function parseWorkbookBuffer(buffer) {
  const workbook = XLSX.read(buffer, { type: 'buffer' });
  const datasetSheet = findDatasetSheet(workbook);

  if (!datasetSheet) {
    throw new Error('No dataset worksheet found.');
  }

  const sheet = workbook.Sheets[datasetSheet];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

  if (!rows.length) {
    return [];
  }

  const headers = Object.keys(rows[0] || {});
  const headerMap = new Map(headers.map((header) => [normalizeHeader(header), header]));

  const missingHeaders = REQUIRED_HEADERS.filter((header) => !headerMap.has(header));
  if (missingHeaders.length > 0) {
    throw new Error(`CSV must contain both required columns: ${missingHeaders.join(', ')}`);
  }

  return rows.map((row) => {
    const questionKey = headerMap.get('question');
    const referenceKey = headerMap.get('reference');

    const question = String(row[questionKey] ?? '').trim();
    const reference = String(row[referenceKey] ?? '').trim();

    return {
      question,
      reference,
    };
  });
}

module.exports = {
  parseWorkbookBuffer,
};
