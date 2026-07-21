require('dotenv').config();

async function start() {
  const { setupLogfire } = require('./instrumentation');

  await setupLogfire();

  const { startServer } = require('./index');
  await startServer();
}

start().catch((error) => {
  console.error('Backend startup failed:', error);
  process.exit(1);
});