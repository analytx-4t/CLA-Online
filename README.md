# CLAOnline Legal Research Assistant

CLAOnline answers questions on Indian corporate and commercial law (Companies Act, IBC, LLP, SEBI,
FEMA, Competition, MSMED, Negotiable Instruments, Arbitration, SEZ) for practitioners. Every
statement of law in an answer is drawn from the CLA legal database and cited to the passage it
comes from; the reader can open each cited source with the supporting text highlighted.

The system has three parts:

| Part | Location | Stack |
|---|---|---|
| Chat application and API | `backend/`, `frontend/` | Node.js 20 (native `http` server), static HTML/CSS/JS |
| Retrieval and data pipeline | `embedding/` | Python 3, Pinecone, OpenAI embeddings |
| Admin dashboard | `admin-dashboard/` | React + Vite + Tailwind |

## How a question is answered

`POST /api/ask` (backend/index.js) runs these steps:

```
question
  │
  ├─ 1. Guardrails ............... backend/guardrails.js, guardrails/      (scope, jailbreak, PII)
  ├─ 2. Follow-up contextualiser .. backend/contextualizer.js             (makes follow-ups standalone)
  ├─ 3. Query Expansion Agent ..... backend/agentSystem.js                (ontology-guided legal analysis:
  │                                                                         instruments, sections, defined terms)
  ├─ 4. First retrieval pass ...... embedding/search_documents.py         (Pinecone: structured DB + books)
  │                                  backend/legalAuthority.js             (authority & currency ranking)
  ├─ 5. Reasoning Agent ........... backend/reasoningAgent.js             (GPT-6 Luna on the Reasoning Layer
  │                                                                         System Prompt; searches further with
  │                                                                         its two tools; writes the answer)
  ├─ 6. Citation & currency check . backend/answerVerifier.js             (second model checks each cited
  │                                                                         sentence against its passage)
  └─ 7. Sources ................... backend/citations.js                 (cited-only, renumbered source list)
```

The answer is returned with its numbered sources, follow-up suggestions and an evaluation record.
An online LLM-judge evaluation (`backend/llm/judge.js`, prompts in `eval_agent.md`) can score each
answer; it is switched on and off from the admin dashboard.

### Reasoning Agent

The Reasoning Agent is the reasoning layer of the pipeline. It runs on the client-validated
**Reasoning Layer System Prompt**, kept verbatim in `CLA_Reasoning_Layer_System_Prompt.txt`
(`{{current_date}}` is filled with today's date in India at run time).

- **Model:** `gpt-6-luna`, called through the same Portkey OpenAI provider as the rest of the
  application (`PORTKEY_OPENAI_PROVIDER`), on the OpenAI Responses API: it is the API on which
  this model accepts function tools together with a reasoning effort (`REASONING_AGENT_EFFORT`).
- **Tools:** the two tools the prompt names: `Pinecone_Vector_Store_DB` (structured legal database,
  one content type per search: Legislation, Notification, Circular, Notice, Caselaws, Commentary,
  Article, Query, Procedure) and `Pinecone_Vector_Store_DB1` (CLA books). Tool results carry the
  same authority and currency labels as the first retrieval pass.
- **Starting point:** the first retrieval pass and the Query Expansion analysis are given to the
  agent in its opening message, so its own searches go to what that pass lacks (definitions,
  replacing instruments, amendments, remaining sub-paragraphs, appellate decisions).
- **Budgets:** turns with tool use, number of searches and time per question are configurable
  (`REASONING_AGENT_MAX_TOOL_ROUNDS`, `REASONING_AGENT_MAX_SEARCHES`, `REASONING_AGENT_TIME_BUDGET_MS`).
  Time for the final answer is always reserved within the budget.
- **Output:** the Part C answer format of the prompt (position, short answer, assumptions and pivot
  facts, route map, analysis, parallel regimes, consequences, currency, Sources with weight tags),
  with `[N]` citation markers that link to the source viewer.
- **Resilience:** if the agent fails (provider error, timeout, truncated output), the single-pass
  answer writer (DeepSeek v4 Pro, `Content_Summarizer_Agent` prompt) answers from the first
  retrieval pass, so the user always gets an answer. The admin request log records which path ran.

`REASONING_AGENT_ENABLED=false` switches the agent off without a code change.

### Models

All model calls go through Portkey (`backend/llm/portkey.js`); `backend/llm/factory.js` returns
the provider client asked for.

| Step | Provider / model |
|---|---|
| Query expansion, single-pass writer, citation check, judge | DeepSeek v4 Pro |
| Reasoning Agent | OpenAI `gpt-6-luna` (Responses API) |
| Embeddings | OpenAI `text-embedding-3-small` (1536 dimensions) |
| Reranking | Cohere Rerank, with a local heuristic fallback |
| Guardrail classifier | Groq Llama 3.3 70B |

## Repository layout

```
backend/
  index.js              HTTP server, routing and the /api/ask pipeline
  agentSystem.js        prompt loading, Query Expansion Agent
  reasoningAgent.js     Reasoning Agent (tools, passage register, budgets)
  legalAuthority.js     authority tiers and currency of retrieved passages
  answerVerifier.js     citation and currency check
  answerCondenser.js    length control for single-pass answers
  citations.js          context block, citation markers, source list
  citationPage.js       source viewer page
  guardrails.js         guardrail client (Python service in guardrails/)
  contextualizer.js     follow-up question rewriting
  adminRoutes.js        admin dashboard API
  dbSync/               nightly CLA API -> Pinecone sync (scheduler and routes)
  llm/                  Portkey client, provider classes, factory, LLM judge
  tests/                unit tests (*.test.js) and live checks (*.check.js)
embedding/
  search_documents.py   search actions used by the backend (search, tool_search, citations)
  definition_resolver.py, instrument_retrieval.py, keyword_scan.py   retrieval helpers
  sync_from_api.py      CLA content API -> Pinecone sync
frontend/               chat interface (static)
admin-dashboard/        admin dashboard (React)
guardrails/             guardrail classifier service (Python)
evaluation/             offline evaluation scripts
CLAOnline_Agent_Prompts_FINAL.md          agent prompts (expansion, writer, follow-ups)
CLA_Query_Expansion_Ontology.md           ontology used by the Query Expansion Agent
CLA_Reasoning_Layer_System_Prompt.txt     Reasoning Agent system prompt (client-validated)
eval_agent.md                             LLM-judge metric prompts
```

## Configuration

Copy `.env.example` to `.env` in the repository root and fill in the values. The file lists every
variable the application reads, grouped by purpose (Portkey and models, Reasoning Agent, Pinecone
and embeddings, MongoDB, observability, CLA content API sync). Secrets are read only from the
environment and are never committed.

## Running locally

```bash
npm ci                                   # Node dependencies (repo root)
python3 -m venv embedding/venv
embedding/venv/bin/pip install -r embedding/requirements.txt
cp .env.example .env                     # then fill in the values
npm start                                # http://localhost:3000
```

The admin dashboard is built separately (`cd admin-dashboard && npm ci && npm run build`).

## Tests

Unit tests use the Node test runner and make no network calls:

```bash
node --test backend/tests/reasoningAgent.test.js backend/tests/llmRouting.test.js \
  backend/tests/citations.test.js backend/tests/answerVerifier.test.js \
  backend/tests/legalAuthority.test.js backend/tests/figuresAndLength.test.js \
  backend/tests/agentSystem.test.js backend/tests/response_parsing.test.js
```

Files ending in `.check.js` are live checks against a running server and real providers, e.g.
`BASE_URL=https://claonline.analytx4t.com node backend/tests/clientFeedback.check.js`. They write
evaluation records to the configured database.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/ask` | Answer a question (body: `question`, optional `attachments`, `requestId`) |
| GET | `/api/ask/progress/:requestId` | Progress of a running answer |
| GET | `/api/citation` | Source viewer page for a cited passage |
| GET | `/api/view-pdf`, `/api/pdf` | Book PDF at a page |
| GET | `/api/legislation-titles` | Display titles of legislation |
| POST | `/api/attachments/upload` | Upload a document to ask about |
| GET, POST | `/api/chat/sessions` | List / create chat sessions |
| GET, POST | `/api/chat/sessions/:id/messages` | Read / add messages of a session |
| GET | `/api/chat/sessions/:id/export` | Export a session |
| DELETE | `/api/chat/sessions/:id` | Delete a session |
| GET | `/api/chat/sessions/search` | Search sessions |
| POST | `/api/chat/feedback` | Answer feedback |
| GET | `/api/llm/health`, `/health` | Provider configuration, server health |
| * | `/api/admin/*` | Admin dashboard API (requests, evaluations, feedback, settings, DB sync) |

## Deployment

Production runs on a single EC2 host behind nginx, with the backend under pm2. Deployment steps
are in `REDEPLOYMENT.md`.

## Operational notes

- **Pinecone read volume.** The Pinecone plan has a monthly read (egress) cap. Each Reasoning
  Agent search reads about 16 chunks (about 30 KB); the search budget bounds the reads per
  question. Avoid full-index scans against production indexes.
- **Credentials.** Keys belong in `.env` only. Rotate any credential that has ever been
  committed to the repository history.
