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

module.exports = {
  buildPortkeyMetadata,
};