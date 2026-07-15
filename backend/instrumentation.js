require('dotenv').config();

async function setupLogfire() {
  const logfire = await import('@pydantic/logfire-node');

  logfire.configure({
    serviceName: 'cla-legal-rag-backend',
    serviceVersion: '1.0.0',
  });

  logfire.info('CLA Legal RAG backend observability initialized');

  return logfire;
}

module.exports = { setupLogfire };