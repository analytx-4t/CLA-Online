const { client, getDB } = require('../mongoClient');

const COLLECTION_NAME = 'golden_dataset';

async function replaceDataset(records) {
  const db = getDB();
  const collection = db.collection(COLLECTION_NAME);

  const now = new Date();
  const version = `${now.toISOString()}-${Math.random().toString(36).slice(2, 8)}`;

  const documents = records.map((record) => ({
    ...record,
    uploadedAt: now.toISOString(),
    version,
  }));

  const session = client.startSession();

  try {
    await session.withTransaction(async () => {
      await collection.deleteMany({}, { session });
      if (documents.length > 0) {
        await collection.insertMany(documents, { session });
      }

      const metadataCollection = db.collection('golden_dataset_state');
      await metadataCollection.updateOne(
        { _id: 'current' },
        {
          $set: {
            version,
            uploadedAt: now.toISOString(),
            recordCount: documents.length,
            updatedAt: now.toISOString(),
          },
        },
        { upsert: true, session }
      );
    });

    return { count: documents.length, version };
  } finally {
    await session.endSession();
  }
}

async function listDataset() {
  const db = getDB();
  const collection = db.collection(COLLECTION_NAME);
  return collection.find({}).sort({ uploadedAt: -1, _id: -1 }).toArray();
}

async function getDatasetById(id) {
  const db = getDB();
  const collection = db.collection(COLLECTION_NAME);
  return collection.findOne({ id });
}

async function deleteDataset() {
  const db = getDB();
  const collection = db.collection(COLLECTION_NAME);
  const result = await collection.deleteMany({});
  return { deletedCount: result.deletedCount };
}

module.exports = {
  replaceDataset,
  listDataset,
  getDatasetById,
  deleteDataset,
};
