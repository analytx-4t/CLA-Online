# Backend

Node.js service for CLAOnline: the chat API, the answer pipeline and the admin API. It is
started from the repository root with `npm start` (`backend/start.js`).

See the repository [README](../README.md) for the answer pipeline, the Reasoning Agent, the
configuration (`.env.example`), the API and the tests.

Main modules:

| Module | Role |
|---|---|
| `index.js` | HTTP server, routing, the `/api/ask` pipeline |
| `agentSystem.js` | Prompt loading and the Query Expansion Agent |
| `reasoningAgent.js` | Reasoning Agent (GPT-6 Luna, Reasoning Layer System Prompt, search tools) |
| `legalAuthority.js` | Authority tier and currency of each retrieved passage |
| `answerVerifier.js` | Citation and currency check of the draft answer |
| `citations.js` | Numbered context, citation markers, cited-only source list |
| `llm/` | Portkey client (`portkey.js`), provider classes, factory, LLM judge |
| `tests/` | Unit tests (`*.test.js`, offline) and live checks (`*.check.js`) |
