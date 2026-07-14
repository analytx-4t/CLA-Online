require('dotenv').config();

const assert = require('assert');
const { randomUUID, randomBytes } = require('crypto');
const { connectDB, closeDB } = require('../mongoClient');

function generateSessionId() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(12);
  const chunks = Array.from({ length: 3 }, (_, index) => {
    const start = index * 4;
    return Array.from(bytes.slice(start, start + 4), (byte) => alphabet[byte % alphabet.length]).join('');
  });
  return `CLA-${chunks.join('-')}`;
}

async function run() {
  const db = await connectDB();
  console.log(`MongoDB database: ${db.databaseName}`);

  const deployedHostname = new URL(process.env.MONGODB_URI).hostname;
  const expectedHostnames = ['cla-legal.okymie7.mongodb.net', 'admin.ygobn2h.mongodb.net'];
  if (!expectedHostnames.includes(deployedHostname)) {
    throw new Error(`Unexpected MongoDB deployment hostname: ${deployedHostname}`);
  }

  console.log(`MongoDB deployment hostname: ${deployedHostname}`);

  const userId = `mongodb-test-user-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
  const sessionId = generateSessionId();

  const sessionsCollection = db.collection('chat_sessions');
  const messagesCollection = db.collection('chat_messages');

  const now = new Date().toISOString();
  const sessionDocument = {
    session_id: sessionId,
    user_id: userId,
    title: 'MongoDB persistence test',
    created_at: now,
    updated_at: now,
    last_message_at: now,
    message_count: 0,
    status: 'active',
  };

  console.log('Testing chat_sessions...');
  await sessionsCollection.insertOne(sessionDocument);
  console.log('Session inserted successfully');

  const savedSession = await sessionsCollection.findOne({ session_id: sessionId, user_id: userId });
  assert.ok(savedSession, 'Session should be readable from chat_sessions');
  assert.match(sessionId, /^CLA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.strictEqual(savedSession.session_id, sessionId);
  assert.strictEqual(savedSession.user_id, userId);
  assert.strictEqual(savedSession.title, 'MongoDB persistence test');
  console.log('Session read successfully');

  console.log('Testing chat_messages...');
  const messageDocument = {
    message_id: randomUUID(),
    session_id: sessionId,
    user_id: userId,
    role: 'user',
    content: 'This is a MongoDB persistence test message.',
    created_at: now,
    sequence_number: 1,
    metadata: {
      sources: [],
      citations: [],
      model: null,
    },
  };

  await messagesCollection.insertOne(messageDocument);
  console.log('Message inserted successfully');

  const savedMessage = await messagesCollection.findOne({ message_id: messageDocument.message_id, session_id: sessionId, user_id: userId });
  assert.ok(savedMessage, 'Message should be readable from chat_messages');
  assert.strictEqual(savedMessage.role, 'user');
  assert.strictEqual(savedMessage.content, 'This is a MongoDB persistence test message.');
  console.log('Message read successfully');

  const updatedAt = new Date().toISOString();
  await sessionsCollection.updateOne(
    { session_id: sessionId, user_id: userId },
    {
      $set: {
        message_count: 1,
        updated_at: updatedAt,
        last_message_at: updatedAt,
      },
    }
  );

  const updatedSession = await sessionsCollection.findOne({ session_id: sessionId, user_id: userId });
  assert.strictEqual(updatedSession.message_count, 1);
  assert.strictEqual(updatedSession.updated_at, updatedAt);
  assert.strictEqual(updatedSession.last_message_at, updatedAt);
  console.log('Session metadata updated successfully');

  await messagesCollection.deleteOne({ message_id: messageDocument.message_id });
  await sessionsCollection.deleteOne({ session_id: sessionId, user_id: userId });

  const deletedMessage = await messagesCollection.findOne({ message_id: messageDocument.message_id });
  const deletedSession = await sessionsCollection.findOne({ session_id: sessionId, user_id: userId });
  assert.strictEqual(deletedMessage, null);
  assert.strictEqual(deletedSession, null);
  console.log('Cleanup successful');

  console.log('MongoDB chat persistence test PASSED');
  await closeDB();
}

run().catch((error) => {
  console.error('MongoDB chat persistence test FAILED');
  console.error(error);
  process.exit(1);
});
