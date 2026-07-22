const path = require('path');
const dotenv = require('dotenv');

const envPath = path.resolve(__dirname, '.env');
const envResult = dotenv.config({ path: envPath });

console.log('Backend startup diagnostic: cwd=', process.cwd());
console.log(`Backend startup diagnostic: .env file ${envResult.error ? 'not found' : 'found'} at ${envPath}`);
console.log(`Backend startup diagnostic: MONGODB_URI ${process.env.MONGODB_URI ? 'Loaded' : 'Missing'}`);

async function start() {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is missing or empty. Ensure backend/.env contains MONGODB_URI=<your connection string>.');
    process.exit(1);
  }

  const { setupLogfire } = require('./instrumentation');

  await setupLogfire();

  const { startServer } = require('./index');
  await startServer();
}

start().catch((error) => {
  console.error('Backend startup failed:', error);
  process.exit(1);
});
