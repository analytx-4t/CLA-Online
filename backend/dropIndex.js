require('dotenv').config();
const { MongoClient } = require('mongodb');

async function dropConflictingIndex() {
  const client = new MongoClient(process.env.MONGODB_URI);
  
  try {
    await client.connect();
    console.log('Connected to MongoDB');
    
    const db = client.db();
    const evaluationResultsCollection = db.collection('evaluation_results');
    
    // Drop the old conflicting index
    try {
      await evaluationResultsCollection.dropIndex('eval_session_id');
      console.log('Successfully dropped old eval_session_id index');
    } catch (error) {
      console.log('Index not found or already dropped:', error.message);
    }
    
    console.log('Index fix completed');
  } catch (error) {
    console.error('Error:', error);
  } finally {
    await client.close();
  }
}

dropConflictingIndex();
