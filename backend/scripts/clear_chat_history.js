require('dotenv').config();
const { connectDB, closeDB } = require('../mongoClient');

async function main() {
  try {
    const db = await connectDB();
    console.log(`Connected to database: ${db.databaseName}`);

    const collections = await db.listCollections().toArray();
    console.log('Existing collections:', collections.map(c => c.name));

    const sessionsCol = db.collection('chat_sessions');
    const messagesCol = db.collection('chat_messages');

    const resSessions = await sessionsCol.deleteMany({});
    const resMessages = await messagesCol.deleteMany({});

    console.log(`Cleared ${resSessions.deletedCount} sessions from chat_sessions.`);
    console.log(`Cleared ${resMessages.deletedCount} messages from chat_messages.`);

    // Also check if any other chat collections exist (e.g. conversations)
    for (const col of collections) {
      if (['conversations', 'messages', 'chat_history'].includes(col.name)) {
        const res = await db.collection(col.name).deleteMany({});
        console.log(`Cleared ${res.deletedCount} items from ${col.name}.`);
      }
    }

    console.log('Chat history cleared successfully!');
  } catch (err) {
    console.error('Error clearing chat history:', err);
  } finally {
    await closeDB();
  }
}

main();
