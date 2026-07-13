# Backend notes

The backend is a lightweight Node.js service. It now includes a centralized config module and an LLM provider abstraction for OpenAI, DeepSeek, Gemini, and Groq.

## Environment configuration

Copy .env.example to .env and fill in the provider API keys and model values locally.

## Provider health

The backend exposes provider configuration health through the config module. It never returns API keys.
