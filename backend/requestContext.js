const crypto = require('crypto');

function createRequestContext({ sessionId, messageId } = {}) {
  return {
    requestId: crypto.randomUUID(),
    sessionId,
    messageId,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  createRequestContext,
};
