const { connectDB, closeDB } = require('./backend/mongoClient');

async function main() {
  try {
    const db = await connectDB();
    const collections = await db.listCollections().toArray();
    console.log('Available collections:');
    collections.forEach(c => console.log(` - ${c.name}`));
  } catch (error) {
    console.error('Error listing collections:', error);
  } finally {
    await closeDB();
  }
}

main();
