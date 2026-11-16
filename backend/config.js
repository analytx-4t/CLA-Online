require('dotenv').config();

const settings = {
  // LLM Providers
  OPENAI_API_KEY: process.env.OPENAI_API_KEY || '',
  OPENAI_MODEL: process.env.OPENAI_MODEL || 'gpt-4.1-mini',
  OPENAI_GPT5_MODEL: process.env.OPENAI_GPT5_MODEL || 'gpt-5',

  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY || '',
  DEEPSEEK_PRO_MODEL: process.env.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro',
  DEEPSEEK_FLASH_MODEL: process.env.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash',

  GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
  GEMINI_MODEL: process.env.GEMINI_MODEL || '',

  GROQ_API_KEY: process.env.GROQ_API_KEY || '',
  GROQ_API_KEY_RAGAS: process.env.GROQ_API_KEY_RAGAS || '',
  GROQ_LLAMA_MODEL: process.env.GROQ_LLAMA_MODEL || '',
  GROQ_MODEL_RAGAS: process.env.GROQ_MODEL_RAGAS || '',
  GROQ_MISTRAL_MODEL: process.env.GROQ_MISTRAL_MODEL || '',

  DEFAULT_LLM_PROVIDER: process.env.DEFAULT_LLM_PROVIDER || 'deepseek',
  DEFAULT_LLM_MODEL: process.env.DEFAULT_LLM_MODEL || 'deepseek-v4-pro',

  PROMPT_FILE: process.env.PROMPT_FILE || 'CLAOnline_Agent_Prompts_FINAL.md',
  QUERY_EXPANSION_ONTOLOGY_FILE: process.env.QUERY_EXPANSION_ONTOLOGY_FILE || 'CLA_Query_Expansion_Ontology.md',

  // Reasoning Agent: runs after query expansion and writes the answer (see backend/reasoningAgent.js).
  REASONING_AGENT_ENABLED: !/^(0|false|no|off)$/i.test(process.env.REASONING_AGENT_ENABLED || 'true'),
  REASONING_AGENT_PROVIDER: process.env.REASONING_AGENT_PROVIDER || 'openai',
  REASONING_AGENT_MODEL: process.env.REASONING_AGENT_MODEL || 'gpt-6-luna',
  REASONING_AGENT_EFFORT: process.env.REASONING_AGENT_EFFORT || 'medium',
  REASONING_AGENT_PROMPT_FILE: process.env.REASONING_AGENT_PROMPT_FILE || 'CLA_Reasoning_Layer_System_Prompt.txt',
  REASONING_AGENT_MAX_TOOL_ROUNDS: parseInt(process.env.REASONING_AGENT_MAX_TOOL_ROUNDS || '5', 10),
  REASONING_AGENT_MAX_SEARCHES: parseInt(process.env.REASONING_AGENT_MAX_SEARCHES || '20', 10),
  REASONING_AGENT_TIME_BUDGET_MS: parseInt(process.env.REASONING_AGENT_TIME_BUDGET_MS || '150000', 10),
  REASONING_AGENT_MAX_OUTPUT_TOKENS: parseInt(process.env.REASONING_AGENT_MAX_OUTPUT_TOKENS || '16000', 10),

  // Pinecone Configuration
  PINECONE_API_KEY: process.env.PINECONE_API_KEY || '',
  PINECONE_INDEX_NAME: process.env.PINECONE_INDEX_NAME || 'cla-online',
  PINECONE_DB_INDEX_NAME: process.env.PINECONE_DB_INDEX_NAME || 'cla-online-db',

  // Embedding Configuration
  EMBEDDING_PROVIDER: process.env.EMBEDDING_PROVIDER || 'openai',
  EMBEDDING_MODEL: process.env.EMBEDDING_MODEL || 'text-embedding-3-small',
  EMBEDDING_DIMENSIONS: parseInt(process.env.EMBEDDING_DIMENSIONS || '1536', 10),
};

function getProviderConfig(provider) {
  switch (provider) {
    case 'openai':
      return {
        apiKey: settings.OPENAI_API_KEY,
        model: settings.OPENAI_MODEL,
      };
    case 'deepseek':
      return {
        apiKey: settings.DEEPSEEK_API_KEY,
        proModel: settings.DEEPSEEK_PRO_MODEL,
        flashModel: settings.DEEPSEEK_FLASH_MODEL,
      };
    case 'gemini':
      return {
        apiKey: settings.GEMINI_API_KEY,
        model: settings.GEMINI_MODEL,
      };
    case 'groq':
      return {
        apiKey: settings.GROQ_API_KEY,
        llamaModel: settings.GROQ_LLAMA_MODEL,
        mistralModel: settings.GROQ_MISTRAL_MODEL,
      };
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

function getProviderHealth() {
  return {
    openai: { configured: Boolean(settings.OPENAI_API_KEY && settings.OPENAI_MODEL) },
    deepseek: { configured: Boolean(settings.DEEPSEEK_API_KEY && (settings.DEEPSEEK_PRO_MODEL || settings.DEEPSEEK_FLASH_MODEL)) },
    gemini: { configured: Boolean(settings.GEMINI_API_KEY && settings.GEMINI_MODEL) },
    groq: { configured: Boolean(settings.GROQ_API_KEY && (settings.GROQ_LLAMA_MODEL || settings.GROQ_MISTRAL_MODEL)) },
  };
}

function getEmbeddingConfig() {
  return {
    provider: settings.EMBEDDING_PROVIDER,
    model: settings.EMBEDDING_MODEL,
    dimensions: settings.EMBEDDING_DIMENSIONS,
  };
}

module.exports = {
  settings,
  getProviderConfig,
  getProviderHealth,
  getEmbeddingConfig,
};
