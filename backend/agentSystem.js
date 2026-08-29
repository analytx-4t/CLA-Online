const fs = require('fs');
const path = require('path');
const { connectDB } = require('./mongoClient');
const { getLLMProvider } = require('./llm/factory');

// Helper to load and parse prompts dynamically from the markdown file
function loadAgentPrompts() {
  try {
    const { settings } = require('./config');
    const promptFileName = process.env.PROMPT_FILE || settings.PROMPT_FILE || 'CLAOnline_Agent_Prompts_FINAL.md';
    const filePath = path.resolve(__dirname, '..', promptFileName);
    const content = fs.readFileSync(filePath, 'utf8');

    const sections = {};
    const parts = content.split(/\r?\n##\s+/);

    for (const part of parts) {
      const lines = part.split(/\r?\n/);
      if (lines.length === 0) continue;
      const title = lines[0].trim();
      if (!title || title.startsWith('#')) continue;

      const body = lines.slice(1).join('\n');
      const codeBlockRegex = /```\r?\n([\s\S]*?)\r?\n```/g;
      let match;
      const codeBlocks = [];
      while ((match = codeBlockRegex.exec(body)) !== null) {
        const blockText = match[1].trim();
        if (blockText) {
          codeBlocks.push(blockText);
        }
      }

      const finalContent = codeBlocks.join('\n\n').trim();

      let key;
      if (title.includes('SHARED LEGAL CONTEXT')) {
        key = 'SHARED_LEGAL_CONTEXT';
      } else if (title.includes('COMMON RULES')) {
        key = 'COMMON_RULES';
      } else {
        key = title.split(/[(\s]+/)[0].trim();
      }
      sections[key] = finalContent;
    }
    return sections;
  } catch (error) {
    console.error('Error reading prompts markdown file:', error);
    throw error;
  }
}

// Helper to assemble prompts with shared context and common rules
function assemblePrompt(rawPrompt, prompts) {
  if (!rawPrompt) return '';
  let assembled = rawPrompt;
  if (assembled.includes('[SHARED LEGAL CONTEXT]')) {
    assembled = assembled.replace('[SHARED LEGAL CONTEXT]', prompts.SHARED_LEGAL_CONTEXT || '');
  }
  if (assembled.includes('[COMMON RULES]')) {
    assembled = assembled.replace('[COMMON RULES]', prompts.COMMON_RULES || '');
  }
  if (prompts && prompts.COMMON_RULES && !assembled.includes('RULES FOR ALL AGENTS:')) {
    assembled = `${prompts.COMMON_RULES}\n\n${assembled}`;
  }
  if (prompts && prompts.SHARED_LEGAL_CONTEXT && !assembled.includes('AUTHORITY ORDER')) {
    assembled = `${prompts.SHARED_LEGAL_CONTEXT}\n\n${assembled}`;
  }
  return assembled;
}

// Maps agent name to its corresponding document source_type in the database
function agentToSourceType(agentName) {
  const mapping = {
    'Article_Agent': 'article',
    'Caselaw_Agent': 'caselaw',
    'Circular_Agent': 'circular',
    'Commentary_Agent': 'commentary',
    'Procedure_Agent': 'procedure',
    'Legislation_Agent': 'legislation',
    'Notification_Agent': 'notification',
    'Query_Agent': 'query'
  };
  return mapping[agentName] || agentName.toLowerCase().replace('_agent', '');
}

const { spawn } = require('child_process');

// Queries Neon PostgreSQL (PGVector) and Pinecone vector databases
async function searchVectorDb(query, sourceType, keywords = [], limit = 5) {
  return new Promise((resolve) => {
    try {
      let pythonPath = path.resolve(__dirname, '../embedding/venv/Scripts/python.exe');
      if (!fs.existsSync(pythonPath)) {
        pythonPath = path.resolve(__dirname, '../embedding/venv/bin/python');
      }
      const scriptPath = path.resolve(__dirname, '../embedding/search_documents.py');
      const child = spawn(pythonPath, [scriptPath, '--json']);
      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (d) => stdout += d.toString());
      child.stderr.on('data', (d) => stderr += d.toString());

      child.on('error', (err) => {
        console.error(`[Agent Vector Search Error] ${err.message}`);
        resolve([]);
      });

      child.on('close', (code) => {
        console.log(`[Agent Vector Search Close] Code: ${code}, Stdout len: ${stdout.length}, Stderr: ${stderr.slice(0, 100)}`);
        if (code !== 0) {
          console.error(`[Agent Vector Search] Python process exited code ${code}: ${stderr}`);
          return resolve([]);
        }
        try {
          const res = JSON.parse(stdout);
          const results = res.results || [];
          const mapped = results.map(r => ({
            file: r.file_name || r.file || r.filename || (r.original && r.original.child && r.original.child.FileName) || (r.original && r.original.parent && r.original.parent.FileName) || r.doc_title || 'Unknown',
            file_name: r.file_name || r.file || r.filename || r.doc_title || 'Unknown',
            page_number: r.page_number || r.parent_id || 1,
            s3_url: r.s3_url || null,
            is_book: Boolean(r.is_book || r.source_table === 'CLA Books' || r.database_source === 'Pinecone'),
            title: r.doc_title || (r.original && r.original.parent && r.original.parent.Title) || 'Untitled',
            source_type: r.source_table || sourceType,
            source_table: r.source_table || sourceType,
            database_source: r.database_source || 'PGVector',
            record_id: r.record_id || null,
            parent_id: r.parent_id || null,
            content: r.chunk_text || r.content || r.text || '',
            excerpt: r.chunk_text ? r.chunk_text.slice(0, 300) : (r.content ? r.content.slice(0, 300) : ''),
            author: (r.original && r.original.parent && r.original.parent.Author) || r.author || null,
            sections: r.sections || (r.original && r.original.parent && r.original.parent.Sections) || null,
            category: r.category || (r.original && r.original.parent && r.original.parent.Category) || null,
            subject: r.subject || (r.original && r.original.parent && r.original.parent.Subject) || null,
            doc_date: r.doc_date || (r.original && r.original.parent && r.original.parent.DocDate) || null
          }));
          console.log(`[Agent Vector Search] Retrieved ${mapped.length} chunks for ${sourceType}`);
          resolve(mapped);
        } catch (e) {
          console.error(`[Agent Vector Search] JSON parse failed: ${e.message}`);
          resolve([]);
        }
      });

      const lines = String(query || '').split(/\r?\n/);
      let extractedQuery = '';
      for (const line of lines) {
        if (/^\*?EXPANDED_QUERY\*?\s*:/i.test(line) || /^\*?QUERY\*?\s*:/i.test(line)) {
          extractedQuery = line.replace(/^\*?(?:EXPANDED_QUERY|QUERY)\*?\s*:\s*/i, '').trim();
          break;
        }
      }
      if (!extractedQuery) {
        extractedQuery = lines
          .filter(l => !/^(?:KEYWORDS|SUGGESTED_FILTERS|CLARIFYING_QUESTION)\s*:/i.test(l.trim()))
          .join(' ')
          .trim();
      }
      const cleanQuery = extractedQuery.slice(0, 300);
      const searchQuery = [cleanQuery, ...keywords.slice(0, 3)].filter(Boolean).join(' ');
      const payload = JSON.stringify({
        query: searchQuery || 'Companies Act share capital',
        top_k: limit,
        hybrid: true,
        source_filter: null
      });


      child.stdin.write(payload);
      child.stdin.end();
    } catch (err) {
      console.error(`[Agent Vector Search] Failed to run search: ${err.message}`);
      resolve([]);
    }
  });
}

function applyCurrencyGuardrail(docs, userQuery = '') {
  if (!Array.isArray(docs) || docs.length === 0) return docs;
  const isHistoricQuery = /\b(1956|legacy|repealed|historical|history)\b/i.test(userQuery);

  const processed = docs.map(doc => {
    const text = doc.content || doc.excerpt || '';
    const hasLegacy1956 = /\b(Companies\s*Act,?\s*1956|1956\s*Act|Company\s*Law\s*Board|\bCLB\b|Section\s*111A|Section\s*77A|Section\s*77B|Section\s*274\(1\)\(g\)|Section\s*293\(1\)\(d\)|Section\s*2\(7\))\b/i.test(text);

    if (hasLegacy1956 && !isHistoricQuery) {
      return {
        ...doc,
        content: `[CURRENCY WARNING: This document references REPEALED law (Companies Act 1956 / Company Law Board). Under current Indian corporate law (Companies Act 2013 / NCLT), these 1956 Act provisions and CLB references are NO LONGER GOVERNING LAW. Section 111A is replaced by Section 58 & Section 29(1A)/Rule 9A; Section 77A/77B by Section 68/70; Section 274(1)(g) by Section 164(2)/167; Section 293(1)(d) by Section 180(1)(c); Section 2(7) by Section 2(11). Do NOT cite 1956 Act or CLB as active governing law!]\n` + text,
        isSuperseded: true,
        score: (doc.score || 0.5) * 0.1 // Heavily penalize so current 2013 Act provisions outrank legacy text
      };
    }
    return doc;
  });

  // Sort so non-superseded current statutory provisions come first
  return processed.sort((a, b) => {
    if (a.isSuperseded && !b.isSuperseded) return 1;
    if (!a.isSuperseded && b.isSuperseded) return -1;
    return (b.score || 0) - (a.score || 0);
  });
}

function resolveAndSanitizeCitations(finalAnswer, sources = []) {
  if (!finalAnswer) return finalAnswer;
  let cleanAnswer = finalAnswer;

  // Replace [Source N] or [Source N, M] with named authority citations
  cleanAnswer = cleanAnswer.replace(/\[Source\s+(\d+)(?:\s*,\s*(\d+))*\]/gi, (match, p1) => {
    const idx = parseInt(p1, 10) - 1;
    if (sources[idx]) {
      const src = sources[idx];
      const title = src.title || src.filename || 'CLA Database';
      const sec = src.sections ? `, ${src.sections}` : '';
      if (src.category === 'Judicial Precedent' || src.source_table === 'CaseLaws') {
        return `[Case Law: ${title}]`;
      }
      return `[${title}${sec}]`;
    }
    return match;
  });

  // Second pass to purge any remaining raw [Source N] placeholders
  cleanAnswer = cleanAnswer.replace(/\[Source\s+\d+\]/gi, (match) => {
    if (sources.length > 0) {
      const src = sources[0];
      return `[${src.title || 'CLA Database'}]`;
    }
    return '';
  });

  return cleanAnswer;
}

// Helper to handle LLM generation with automatic DeepSeek v4 Pro fallback on OpenAI/quota errors
async function generateWithRetry(provider, options, maxRetries = 3) {
  let delay = 1500;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await provider.generate(options);
    } catch (error) {
      console.warn(`[LLM Provider Warning] Primary provider error (${error.message}). Executing DeepSeek v4 Pro fallback...`);
      try {
        const deepseekFallback = getLLMProvider('deepseek', 'deepseek-v4-pro');
        return await deepseekFallback.generate(options);
      } catch (fallbackErr) {
        console.error(`[DeepSeek Fallback Error] ${fallbackErr.message}`);
      }
      if (attempt < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2;
        continue;
      }
      throw error;
    }
  }
}

function cleanParsedValue(value) {
  if (!value) return '';
  return value.replace(/[\*`\#]/g, '').trim();
}
/**
 * Runs only the Query Expansion Agent.
 *
 * This is used by the main /api/ask RAG endpoint so that retrieval can
 * benefit from the existing Query_Expansion_Agent without executing the
 * complete multi-agent flow.
 */
async function expandLegalQuery(userMessage) {
  const prompts = loadAgentPrompts();
  const { settings } = require('./config');

  // Query Expansion uses OpenAI primary with DeepSeek v4 Pro fallback
  const expansionProvider = getLLMProvider('openai', settings.OPENAI_MODEL || 'gpt-4.1-mini');

  console.log(
    `[Query Expansion] Expanding legal query: "${userMessage}"`
  );

  try {
    const expansionPrompt = assemblePrompt(
      prompts.Query_Expansion_Agent,
      prompts
    );

    const expansionResponse = await generateWithRetry(
      expansionProvider,
      {
        messages: [
          {
            role: 'user',
            content: userMessage
          }
        ],
        systemPrompt: expansionPrompt,
        temperature: 0.2
      }
    );

    const expansionText = String(
      expansionResponse?.content ||
      expansionResponse?.text ||
      expansionResponse?.response ||
      expansionResponse?.message?.content ||
      expansionResponse?.choices?.[0]?.message?.content ||
      ''
    ).trim();

    console.log(
      '[Query Expansion] Raw provider response:',
      JSON.stringify(expansionResponse, null, 2)
    );

    console.log(
      '[Query Expansion] Extracted output:\n',
      expansionText
    );

    console.log(
      '[Query Expansion] Raw output:\n',
      expansionText
    );

    // Safe defaults: if parsing fails, retrieval still uses
    // the user's original question.
    let expandedQuery = userMessage;
    let keywords = [];
    let inferredSections = [];
    let primaryAct = null;
    let actFilter = null;
    let currencyRequirement = '';
    let suggestedFilters = '';
    let clarifyingQuestion = 'NONE';

    const expansionLines = expansionText.split(/\r?\n/);

    for (const line of expansionLines) {
      const cleanLine = line
        .replace(/^\s*[\*\-#]*\s*/, '')
        .replace(/\s*[\*\-#]*\s*$/, '')
        .trim();

      const eqMatch = cleanLine.match(
        /^\*?EXPANDED_QUERY\*?\s*:\s*(.*)$/i
      );

      if (eqMatch) {
        const value = cleanParsedValue(eqMatch[1]);

        if (value) {
          expandedQuery = value;
        }

        continue;
      }

      const kwMatch = cleanLine.match(
        /^\*?KEYWORDS\*?\s*:\s*(.*)$/i
      );

      if (kwMatch) {
        const kwStr = cleanParsedValue(kwMatch[1]);

        if (
          kwStr &&
          kwStr.toLowerCase() !== 'none'
        ) {
          keywords = kwStr
            .split(',')
            .map(keyword => cleanParsedValue(keyword))
            .filter(k => k && !/^Rule\s+\d+$/i.test(k.trim()))
            .slice(0, 10);
        }

        continue;
      }

      const isMatch = cleanLine.match(
        /^\*?(?:INFERRED_SECTIONS|SECTIONS|SECTIONS_INFERRED)\*?\s*:\s*(.*)$/i
      );

      if (isMatch) {
        const isStr = cleanParsedValue(isMatch[1]);
        if (isStr && isStr.toLowerCase() !== 'none') {
          inferredSections = isStr
            .split(',')
            .map(s => cleanParsedValue(s).replace(/^section\s+/i, '').trim())
            .filter(Boolean);
        }
        continue;
      }

      const paMatch = cleanLine.match(
        /^\*?(?:PRIMARY_ACT|TARGET_ACT|ACT)\*?\s*:\s*(.*)$/i
      );

      if (paMatch) {
        const paStr = cleanParsedValue(paMatch[1]);
        if (paStr && paStr.toLowerCase() !== 'none') {
          primaryAct = paStr;
        }
        continue;
      }

      const afMatch = cleanLine.match(
        /^\*?(?:ACT_FILTER|ACT_YEAR|ACT_SPECIFICATION)\*?\s*:\s*(.*)$/i
      );

      if (afMatch) {
        const afStr = cleanParsedValue(afMatch[1]);
        if (afStr && afStr.toLowerCase() !== 'none') {
          actFilter = afStr;
          if (!primaryAct) primaryAct = afStr;
        }
        continue;
      }

      const crMatch = cleanLine.match(
        /^\*?(?:CURRENCY_REQUIREMENT|CURRENCY_CHECK|CURRENCY)\*?\s*:\s*(.*)$/i
      );

      if (crMatch) {
        const crStr = cleanParsedValue(crMatch[1]);
        if (crStr && crStr.toLowerCase() !== 'none') {
          currencyRequirement = crStr;
        }
        continue;
      }

      const sfMatch = cleanLine.match(
        /^\*?SUGGESTED_FILTERS\*?\s*:\s*(.*)$/i
      );

      if (sfMatch) {
        suggestedFilters =
          cleanParsedValue(sfMatch[1]);

        continue;
      }

      const cqMatch = cleanLine.match(
        /^\*?CLARIFYING_QUESTION\*?\s*:\s*(.*)$/i
      );

      if (cqMatch) {
        clarifyingQuestion =
          cleanParsedValue(cqMatch[1]);

        continue;
      }
    }

    const result = {
      originalQuery: userMessage,
      expandedQuery:
        expandedQuery || userMessage,
      keywords,
      inferredSections,
      primaryAct: primaryAct || actFilter || null,
      actFilter: actFilter || primaryAct || null,
      currencyRequirement: currencyRequirement || 'as_of: today; mode = CURRENT',
      suggestedFilters,
      clarifyingQuestion:
        clarifyingQuestion || 'NONE'
    };

    console.log(
      '[Query Expansion] Parsed result:',
      result
    );

    return result;

  } catch (error) {
    // Query expansion must never break the main RAG endpoint.
    console.error(
      '[Query Expansion] Failed. Falling back to original query:',
      error.message
    );

    return {
      originalQuery: userMessage,
      expandedQuery: userMessage,
      keywords: [],
      suggestedFilters: '',
      clarifyingQuestion: 'NONE'
    };
  }
}
// The core agent flow orchestrator
async function runAgentFlow(userMessage, options = {}) {
  const prompts = loadAgentPrompts();
  const { settings } = require('./config');
  const defaultProvider = getLLMProvider('deepseek', settings.DEEPSEEK_PRO_MODEL || 'deepseek-v4-pro');

  // Run guardrails check before any expensive operations
  try {
    const { checkGuardrails } = require('./guardrails');
    const guardResult = await checkGuardrails(userMessage);
    if (guardResult) {
      console.log('[Guardrails] Action:', guardResult.action, 'Category:', guardResult.category);
      if (guardResult.action === 'RESPOND') {
        const mappedRoute = guardResult.route || guardResult.category || 'REFUSE';
        return {
          content: guardResult.response || 'Your request cannot be processed.',
          route: mappedRoute,
          isClarifying: false,
          follow_up_questions: [],
          guardrail: {
            triggered: true,
            category: guardResult.category || guardResult.route
          }
        };
      }
      // action CONTINUE -> fall through to legal pipeline
    }
  } catch (e) {
    console.error('[Guardrails] Error running guardrails:', e?.message || e);
    // On error, fail-safe: refuse to proceed to retrieval to avoid leaking
    return {
      content: 'I am unable to process this request right now.',
      route: 'REFUSE',
      isClarifying: false,
      follow_up_questions: [],
      guardrail: { triggered: true, category: 'GUARDRAILS_ERROR' }
    };
  }

  console.log(`\n--- Starting Agent Flow for query: "${userMessage}" ---`);

  // Step 1: Supervisor Routing
  console.log('Running Supervisor_Agent...');
  const supervisorPrompt = prompts.Supervisor_Agent;
  const supervisorResponse = await generateWithRetry(defaultProvider, {
    messages: [{ role: 'user', content: userMessage }],
    systemPrompt: supervisorPrompt,
    temperature: 0.1
  });

  const supervisorText = (supervisorResponse.content || '').trim();
  console.log('Supervisor Output:\n', supervisorText);

  // Parse Supervisor Output.
  // Start with no route so an empty/malformed Supervisor response
  // cannot silently masquerade as a valid routing decision.
  let route = '';
  let agents = [];
  let query = userMessage;
  let filters = '';

  const supervisorLines = supervisorText.split(/\r?\n/);
  for (const line of supervisorLines) {
    const cleanLine = line
      .replace(/^\s*[\*\-#]*\s*/, '')
      .replace(/\s*[\*\-#]*\s*$/, '')
      .trim();

    const routeMatch = cleanLine.match(
      /^ROUTE\s*:\s*(LEGAL|DIALOG|CLARIFY|REFUSE)\s*$/i
    );

    if (routeMatch) {
      route = routeMatch[1].toUpperCase();
      continue;
    }

    const agentsMatch = cleanLine.match(
      /^AGENTS\s*:\s*(.*)$/i
    );

    if (agentsMatch) {
      const agentsStr = cleanParsedValue(agentsMatch[1]);

      if (
        agentsStr &&
        agentsStr.toLowerCase() !== 'none'
      ) {
        agents = agentsStr
          .split(',')
          .map(agent => cleanParsedValue(agent));
      }

      continue;
    }

    const queryMatch = cleanLine.match(
      /^QUERY\s*:\s*(.*)$/i
    );

    if (queryMatch) {
      query = cleanParsedValue(queryMatch[1]);
      continue;
    }

    const filtersMatch = cleanLine.match(
      /^FILTERS\s*:\s*(.*)$/i
    );

    if (filtersMatch) {
      filters = cleanParsedValue(filtersMatch[1]);
    }
  }
  // Validate the Supervisor route before continuing.
  const validRoutes = new Set([
    'LEGAL',
    'DIALOG',
    'CLARIFY',
    'REFUSE'
  ]);

  route = String(route || '').trim().toUpperCase();

  if (!validRoutes.has(route)) {
    console.warn(
      `Supervisor returned an empty or invalid route: "${route}". ` +
      'Falling back to LEGAL for safe legal-query processing.'
    );

    route = 'LEGAL';
    agents = [];
    query = userMessage;
    filters = '';
  }

  console.log('Validated Supervisor Route:', route);

  // Handle Non-Legal Routes directly
  if (route !== 'LEGAL') {
    console.log(`Routing to non-legal path: ${route}`);
    const nonLegalPrompt = `You are CLA, a professional corporate law advisor chatbot. The user said: "${userMessage}". The supervisor classified this message route as "${route}". Please respond to the user appropriately based on this classification.`;
    const response = await generateWithRetry(defaultProvider, {
      messages: [{ role: 'user', content: userMessage }],
      systemPrompt: nonLegalPrompt,
      temperature: 0.7
    });
    return {
      content: response.content,
      route,
      isClarifying: false,
      follow_up_questions: []
    };
  }

  // Step 2: Query Expansion (OpenAI Primary, DeepSeek Fallback)
  console.log('Running Query_Expansion_Agent...');
  const expansionPrompt = assemblePrompt(prompts.Query_Expansion_Agent, prompts);
  const openaiExpansionProvider = getLLMProvider('openai', settings.OPENAI_MODEL || 'gpt-4.1-mini');
  const expansionResponse = await generateWithRetry(openaiExpansionProvider, {
    messages: [{ role: 'user', content: userMessage }],
    systemPrompt: expansionPrompt,
    temperature: 0.2
  });

  const expansionText = expansionResponse.content;
  console.log('Query Expansion Output:\n', expansionText);

  // Parse Query Expansion Output
  let expandedQuery = query;
  let keywords = [];
  let suggestedFilters = '';
  let clarifyingQuestion = 'NONE';

  const expansionLines = expansionText.split('\n');
  for (const line of expansionLines) {
    const cleanLine = line.replace(/^\s*[\*\-#]*\s*/, '').replace(/\s*[\*\-#]*\s*$/, '').trim();

    const eqMatch = cleanLine.match(/^\*?EXPANDED_QUERY\*?\s*:\s*(.*)$/i);
    if (eqMatch) {
      expandedQuery = cleanParsedValue(eqMatch[1]);
      continue;
    }
    const kwMatch = cleanLine.match(/^\*?KEYWORDS\*?\s*:\s*(.*)$/i);
    if (kwMatch) {
      const kwStr = cleanParsedValue(kwMatch[1]);
      if (kwStr && kwStr.toLowerCase() !== 'none') {
        keywords = kwStr.split(',').map(k => cleanParsedValue(k));
      }
      continue;
    }
    const sfMatch = cleanLine.match(/^\*?SUGGESTED_FILTERS\*?\s*:\s*(.*)$/i);
    if (sfMatch) {
      suggestedFilters = cleanParsedValue(sfMatch[1]);
      continue;
    }
    const cqMatch = cleanLine.match(/^\*?CLARIFYING_QUESTION\*?\s*:\s*(.*)$/i);
    if (cqMatch) {
      clarifyingQuestion = cleanParsedValue(cqMatch[1]);
      continue;
    }
  }

  // Intercept if a clarifying question is needed
  if (clarifyingQuestion && clarifyingQuestion.toUpperCase() !== 'NONE' && clarifyingQuestion !== '') {
    console.log(`Query Expansion requested clarification: "${clarifyingQuestion}"`);
    return {
      content: clarifyingQuestion,
      route: 'LEGAL',
      isClarifying: true,
      follow_up_questions: []
    };
  }

  // Determine which agents to execute
  const allSourceAgents = [
    'Legislation_Agent',
    'Notification_Agent',
    'Circular_Agent',
    'Caselaw_Agent',
    'Commentary_Agent',
    'Article_Agent',
    'Query_Agent',
    'Procedure_Agent'
  ];

  const activeAgents = agents.length > 0
    ? agents.filter(a => allSourceAgents.includes(a))
    : allSourceAgents;

  console.log(
    `Executing active source agents in parallel: ${activeAgents.join(', ')}`
  );

  // Step 3: Run selected source agents in parallel.
  // Promise.allSettled ensures one failed source agent does not
  // terminate the entire legal research pipeline.
  const agentTasks = activeAgents.map(async (agentName) => {
    const sourceType = agentToSourceType(agentName);

    console.log(`Starting ${agentName}...`);

    // Retrieve documents for this source independently.
    const rawDocs = await searchVectorDb(
      expandedQuery,
      sourceType,
      keywords
    );
    const docs = applyCurrencyGuardrail(rawDocs, userMessage);

    let docsContext = '';

    if (docs.length === 0) {
      docsContext = 'No documents found in database.';
    } else {
      docsContext = docs
        .map((doc, idx) => {
          return (
            `Document [${idx + 1}]:\n` +
            `File: ${doc.file || doc.filename || 'unknown'}\n` +
            `Title: ${doc.title || 'unknown'}\n` +
            `Source Type: ${doc.source_type || 'unknown'}\n` +
            (doc.citation
              ? `Citation: ${doc.citation}\n`
              : '') +
            (doc.author
              ? `Author: ${doc.author}\n`
              : '') +
            (doc.date
              ? `Date: ${doc.date}\n`
              : '') +
            `Content: ${doc.content || doc.text || ''}\n`
          );
        })
        .join('\n---\n');
    }

    const agentPrompt = assemblePrompt(
      prompts[agentName],
      prompts
    );

    const agentUserMessage =
      `Query: ${expandedQuery}\n` +
      `Keywords: ${keywords.join(', ')}\n` +
      `Filters: ${filters || suggestedFilters}\n\n` +
      `Retrieved Documents:\n${docsContext}`;

    const agentResponse = await generateWithRetry(
      defaultProvider,
      {
        messages: [
          {
            role: 'user',
            content: agentUserMessage
          }
        ],
        systemPrompt: agentPrompt,
        temperature: 0.2
      }
    );

    console.log(`Completed ${agentName}`);

    return {
      agentName,
      content: agentResponse.content || '',
      retrievedDocuments: docs.length,
      docs
    };
  });

  const settledAgentResults = await Promise.allSettled(
    agentTasks
  );

  const agentResults = settledAgentResults.map(
    (result, index) => {
      const agentName = activeAgents[index];

      if (result.status === 'fulfilled') {
        return result.value;
      }

      console.error(
        `${agentName} failed:`,
        result.reason?.message || result.reason
      );

      return {
        agentName,
        content:
          'This source agent could not complete its search due to an internal provider or retrieval error.',
        retrievedDocuments: 0
      };
    }
  );

  // Step 4: Content Summarizer
  console.log('Running Content_Summarizer_Agent...');
  let agentFindingsContext = '';
  for (const result of agentResults) {
    agentFindingsContext += `=== ${result.agentName} ===\n${result.content}\n\n`;
  }

  console.log('--- Summarizer input agent findings context ---');
  console.log(agentFindingsContext);
  console.log('-----------------------------------------------');

  // Detect if all source agents returned negative findings or if findings context is effectively empty
  const hasValidFindings = agentResults.some(
    result => result.retrievedDocuments > 0
  );

  const totalRetrievedDocuments = agentResults.reduce(
    (total, result) =>
      total + (result.retrievedDocuments || 0),
    0
  );

  console.log(
    `Total retrieved documents across source agents: ${totalRetrievedDocuments}`
  );

  let finalAnswer;
  let followUpQuestions = [];

  if (!hasValidFindings) {
    console.log('No valid agent findings detected. Returning predefined "no authority found" response.');
    finalAnswer = "I could not find authority on this in the CLAOnline database. Please try rephrasing or narrowing your question.";
    followUpQuestions = [
      "What is the general procedure for debt recovery under Indian law?",
      "How does the Insolvency and Bankruptcy Code (IBC) apply to corporate debtors?",
      "What are the consequences of breaching a commercial vendor agreement?"
    ];
  } else {
    const summarizerPrompt = assemblePrompt(prompts.Content_Summarizer_Agent, prompts);
    const summarizerResponse = await generateWithRetry(defaultProvider, {
      messages: [
        {
          role: 'user',
          content: `User Query: ${userMessage}\n\nAgent Findings:\n${agentFindingsContext}`
        }
      ],
      systemPrompt: summarizerPrompt,
      temperature: 0.3
    });

    finalAnswer = summarizerResponse.content;
    console.log('Summarizer Output obtained:', JSON.stringify(finalAnswer));

    // Post-generation mechanical Currency Guardrail check
    const legacySectionRegex = /\b(Section\s*111A|Section\s*77A|Section\s*77B|Company\s*Law\s*Board|\bCLB\b)\b/i;
    if (legacySectionRegex.test(finalAnswer) && !/\b(1956|repealed|historical)\b/i.test(userMessage)) {
      console.warn('[Post-Generation Currency Guardrail] Legacy 1956 Act or CLB term detected in final output. Applying currency annotation.');
      finalAnswer = finalAnswer
        .replace(/\bSection\s*111A\b/gi, 'Section 58 (read with Section 29(1A) & Rule 9A for demat) [repealed Section 111A Companies Act 1956]')
        .replace(/\bSection\s*77A\b/gi, 'Section 68 [repealed Section 77A Companies Act 1956]')
        .replace(/\bSection\s*77B\b/gi, 'Section 70 [repealed Section 77B Companies Act 1956]')
        .replace(/\bCompany\s*Law\s*Board\b/gi, 'National Company Law Tribunal (NCLT) [formerly Company Law Board]')
        .replace(/\bCLB\b/g, 'NCLT');

      if (!finalAnswer.includes('CURRENCY NOTICE')) {
        finalAnswer += `\n\n> [!WARNING]\n> **CURRENCY NOTICE:** Current Indian corporate law is governed by the Companies Act, 2013 and adjudicated by the NCLT. References to 1956 Act provisions or the CLB represent legacy/repealed law and have been annotated with their active 2013 Act equivalents.`;
      }
    }

    // Step 5: Follow Up Question Agent
    console.log('Running Follow_Up_Question_Agent...');
    const followUpPrompt = assemblePrompt(prompts.Follow_Up_Question_Agent, prompts);
    const followUpResponse = await generateWithRetry(defaultProvider, {
      messages: [
        {
          role: 'user',
          content: `Final Answer:\n${finalAnswer}`
        }
      ],
      systemPrompt: followUpPrompt,
      temperature: 0.5
    });

    const followUpText = (followUpResponse.content || '').trim();
    console.log(
      'Follow up output obtained:',
      JSON.stringify(followUpText)
    );

    followUpQuestions = followUpText
      .split('\n')
      .map(line =>
        line
          .replace(/^-\s*/, '')
          .replace(/^\d+\.\s*/, '')
          .trim()
      )
      .filter(Boolean)
      .slice(0, 3);

    // Deterministic fallback if the Follow-Up Question Agent
    // returns an empty or unusable response.
    if (followUpQuestions.length === 0) {
      console.warn(
        'Follow-Up Question Agent returned no usable questions. Using fallback questions.'
      );

      followUpQuestions = [
        'Would you like me to narrow the search to a specific provision or legal issue?',
        'Would you like me to search for relevant case law or procedural guidance?',
        'Would you like to rephrase the query with more facts so I can search the CLAOnline database more precisely?'
      ];
    }

    console.log(`Generated ${followUpQuestions.length} follow-up questions.`);
  }

  const rawSourcesList = [];
  const seenSources = new Set();
  for (const res of agentResults) {
    if (Array.isArray(res.docs)) {
      for (const doc of res.docs) {
        const title = doc.title || doc.doc_title || doc.file || doc.file_name || 'Untitled';
        const filename = doc.file_name || doc.file || doc.filename || doc.title || 'Unknown';
        const isBook = Boolean(doc.is_book || doc.source_table === 'CLA Books' || doc.database_source === 'Pinecone' || (filename && String(filename).endsWith('.pdf')));
        const pageNumber = doc.page_number || doc.parent_id || 1;
        const s3Url = isBook ? `/api/view-pdf?file=${encodeURIComponent(filename)}&page=${pageNumber}#page=${pageNumber}` : (doc.s3_url || null);
        const key = `${title}:::${filename}:::${pageNumber}`;

        if (!seenSources.has(key)) {
          seenSources.add(key);
          rawSourcesList.push({
            title,
            filename,
            file_name: filename,
            source_table: isBook ? 'CLA Books' : (doc.source_table || doc.source_type || 'unknown'),
            record_id: doc.record_id || doc.embedding_id || null,
            parent_id: pageNumber,
            page_number: pageNumber,
            is_book: isBook,
            s3_url: s3Url,
            database_source: doc.database_source || (isBook ? 'Pinecone' : 'PGVector'),
            excerpt: doc.excerpt || (doc.content ? doc.content.slice(0, 350) : ''),
            author: doc.author || null,
            sections: doc.sections || null,
            category: isBook ? 'Legal Reference Books & Publications' : (doc.category || null),
            subject: doc.subject || null,
            doc_date: doc.doc_date || null
          });
        }

      }
    }
  }

  // Prioritize Legislation (Statute) sources first and cap total chunks at max 32 (within 30-35 range)
  rawSourcesList.sort((a, b) => {
    const isLegA = /legislation|statute|act/i.test(a.source_table || a.category || '');
    const isLegB = /legislation|statute|act/i.test(b.source_table || b.category || '');
    if (isLegA && !isLegB) return -1;
    if (!isLegA && isLegB) return 1;
    return 0;
  });

  const allSources = rawSourcesList.slice(0, 32);

  // Resolve raw [Source N] placeholders to verified authority citations
  finalAnswer = resolveAndSanitizeCitations(finalAnswer, allSources);

  console.log('--- Agent Flow Completed ---');

  return {
    content: finalAnswer,
    route,
    isClarifying: false,
    follow_up_questions: followUpQuestions,
    sources: allSources
  };
}

module.exports = {
  runAgentFlow,
  loadAgentPrompts,
  expandLegalQuery
};