require('dotenv').config();
const { MongoClient, ServerApiVersion } = require('mongodb');

const uri = process.env.MONGODB_URI;
if (!uri) {
  throw new Error('MONGODB_URI is not defined in .env');
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

let dbInstance = null;

async function connectDB() {
  if (dbInstance) {
    return dbInstance;
  }

  await client.connect();
  dbInstance = client.db();
  console.log('MongoDB connected successfully');
  return dbInstance;
}

function getDB() {
  if (!dbInstance) {
    throw new Error('MongoDB not connected. Call connectDB() first.');
  }
  return dbInstance;
}

async function closeDB() {
  if (client) {
    await client.close();
    dbInstance = null;
    console.log('MongoDB connection closed');
  }
}

module.exports = {
  client,
  connectDB,
  getDB,
  closeDB,
};
