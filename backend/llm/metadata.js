function buildPortkeyMetadata(metadata = {}) {
  const baseMetadata = {
    environment: process.env.NODE_ENV || 'development',
    service: 'cla-online-legal-rag',
    feature: 'legal-chat',
  };

  const combinedMetadata = {
    ...baseMetadata,
    ...metadata,
  };

  return Object.fromEntries(
    Object.entries(combinedMetadata)
      .filter(([, value]) => value !== undefined && value !== null)
      .map(([key, value]) => [key, String(value).slice(0, 128)])
  );
}

function buildPortkeyRequestContextOptions(requestContext, metadata = {}, traceId) {
  if (!requestContext) {
    return {
      metadata: metadata || {},
      traceId,
    };
  }

  const nextMetadata = { ...(metadata || {}) };
  const { requestId, sessionId, messageId } = requestContext;

  if (requestId !== undefined && requestId !== null) {
    nextMetadata.requestId = requestId;
  }

  if (sessionId !== undefined && sessionId !== null) {
    nextMetadata.sessionId = sessionId;
  }

  if (messageId !== undefined && messageId !== null) {
    nextMetadata.messageId = messageId;
  }

  return {
    metadata: nextMetadata,
    traceId: traceId || requestId,
  };
}

module.exports = {
  buildPortkeyMetadata,
  buildPortkeyRequestContextOptions,
};