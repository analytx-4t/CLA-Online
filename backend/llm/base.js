class LLMProviderError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'LLMProviderError';
    this.details = details;
  }
}

class LLMConfigurationError extends LLMProviderError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'LLMConfigurationError';
  }
}

class LLMAuthenticationError extends LLMProviderError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'LLMAuthenticationError';
  }
}

class LLMRateLimitError extends LLMProviderError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'LLMRateLimitError';
  }
}

class LLMProviderUnavailableError extends LLMProviderError {
  constructor(message, details = {}) {
    super(message, details);
    this.name = 'LLMProviderUnavailableError';
  }
}

class BaseLLMProvider {
  constructor({ providerName, defaultModel }) {
    this.providerName = providerName;
    this.defaultModel = defaultModel;
  }

  async generate(request) {
    throw new Error('generate() must be implemented by provider');
  }

  async chat(request) {
    return this.generate(request);
  }
}

module.exports = {
  BaseLLMProvider,
  LLMProviderError,
  LLMConfigurationError,
  LLMAuthenticationError,
  LLMRateLimitError,
  LLMProviderUnavailableError,
};
