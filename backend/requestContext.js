const crypto = require('crypto');

function createRequestContext({ sessionId, messageId, requestId } = {}) {
  return {
    requestId: requestId || crypto.randomUUID(),
    sessionId,
    messageId,
    timestamp: new Date().toISOString(),
  };
}

module.exports = {
  createRequestContext,
};
