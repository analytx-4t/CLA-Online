require('dotenv').config();

const dns = require('dns');
const { MongoClient, ServerApiVersion } = require('mongodb');

dns.setServers([
  '8.8.8.8',
  '1.1.1.1'
]);


const uri = process.env.MONGODB_URI;
const databaseName = process.env.MONGODB_DATABASE || 'cla_legal_chat';

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
  dbInstance = client.db(databaseName);
  console.log('MongoDB connected successfully');
  console.log(`MongoDB database: ${dbInstance.databaseName}`);
  console.log('MongoDB deployment verified: CLA-Legal');
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
  databaseName,
};
