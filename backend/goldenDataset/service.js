const { parseWorkbookBuffer } = require('./parser');
const { replaceDataset, listDataset, getDatasetById, deleteDataset } = require('./repository');

async function uploadDataset(buffer) {
  const records = parseWorkbookBuffer(buffer);
  const result = await replaceDataset(records);
  return {
    message: 'Golden dataset uploaded successfully.',
    count: result.count,
    version: result.version,
  };
}

async function listGoldenDataset() {
  return listDataset();
}

async function getGoldenDatasetById(id) {
  return getDatasetById(id);
}

async function clearGoldenDataset() {
  return deleteDataset();
}

module.exports = {
  uploadDataset,
  listGoldenDataset,
  getGoldenDatasetById,
  clearGoldenDataset,
};
