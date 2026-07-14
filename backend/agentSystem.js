const fs = require('fs');
const path = require('path');
const { connectDB } = require('./mongoClient');
const { getLLMProvider } = require('./llm/factory');

// Helper to load and parse prompts dynamically from the markdown file
function loadAgentPrompts() {
  try {
    const filePath = path.resolve(__dirname, '../CLAOnline_Agent_Prompts_FINAL.md');
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
  let assembled = rawPrompt;
  if (assembled.includes('[SHARED LEGAL CONTEXT]')) {
    assembled = assembled.replace('[SHARED LEGAL CONTEXT]', prompts.SHARED_LEGAL_CONTEXT);
  }
  if (assembled.includes('[COMMON RULES]')) {
    assembled = assembled.replace('[COMMON RULES]', prompts.COMMON_RULES);
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

// Queries the MongoDB vector database
async function searchVectorDb(query, sourceType, keywords = [], limit = 5) {
  try {
    const db = await connectDB();
    const collection = db.collection('cla_online_vector_db');
    
    // Safety check: if collection doesn't exist or has 0 documents, return empty array immediately
    const count = await collection.countDocuments().catch(() => 0);
    if (count === 0) {
      return [];
    }

    // Build filter based on source_type
    const filter = { source_type: sourceType };

    // Try a simple search using regex match on content/title, or keywords if available
    if (query || keywords.length > 0) {
      const searchTerms = [query, ...keywords].filter(Boolean);
      const regexPatterns = searchTerms.map(term => new RegExp(term.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i'));
      filter.$or = [
        { content: { $in: regexPatterns } },
        { title: { $in: regexPatterns } },
        { text: { $in: regexPatterns } }
      ];
    }

    const results = await collection.find(filter).limit(limit).toArray();
    return results;
  } catch (error) {
    console.error(`Database search failed for source_type "${sourceType}":`, error);
    return [];
  }
}

// Helper to handle LLM generation with automatic rate-limit retries (exponential backoff)
async function generateWithRetry(provider, options, maxRetries = 5) {
  let delay = 2000;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await provider.generate(options);
    } catch (error) {
      const isRateLimit = error.message && (
        error.message.includes('rate limit') || 
        error.message.includes('quota') || 
        error.message.includes('429')
      );
      if (isRateLimit && attempt < maxRetries) {
        console.warn(`Rate limit encountered. Retrying in ${delay}ms (Attempt ${attempt}/${maxRetries})...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= 2; // exponential backoff
        continue;
      }
      throw error;
    }
  }
}

function cleanParsedValue(value) {
  if (!value) return '';
  return value.replace(/[\*`_\#]/g, '').trim();
}

// The core agent flow orchestrator
async function runAgentFlow(userMessage, options = {}) {
  const prompts = loadAgentPrompts();
  const defaultProvider = getLLMProvider(); // Uses default LLM provider from config/env (e.g. OpenAI/Groq)

  console.log(`\n--- Starting Agent Flow for query: "${userMessage}" ---`);

  // Step 1: Supervisor Routing
  console.log('Running Supervisor_Agent...');
  const supervisorPrompt = prompts.Supervisor_Agent;
  const supervisorResponse = await generateWithRetry(defaultProvider, {
    messages: [{ role: 'user', content: userMessage }],
    systemPrompt: supervisorPrompt,
    temperature: 0.1
  });

  const supervisorText = supervisorResponse.content;
  console.log('Supervisor Output:\n', supervisorText);

  // Parse Supervisor Output
  let route = 'LEGAL';
  let agents = [];
  let query = userMessage;
  let filters = '';

  const supervisorLines = supervisorText.split('\n');
  for (const line of supervisorLines) {
    const cleanLine = line.replace(/^\s*[\*\-#]*\s*/, '').replace(/\s*[\*\-#]*\s*$/, '').trim();
    
    const routeMatch = cleanLine.match(/^\*?ROUTE\*?\s*:\s*(.*)$/i);
    if (routeMatch) {
      route = cleanParsedValue(routeMatch[1]);
      continue;
    }
    const agentsMatch = cleanLine.match(/^\*?AGENTS\*?\s*:\s*(.*)$/i);
    if (agentsMatch) {
      const agentsStr = cleanParsedValue(agentsMatch[1]);
      if (agentsStr && agentsStr.toLowerCase() !== 'none') {
        agents = agentsStr.split(',').map(a => cleanParsedValue(a));
      }
      continue;
    }
    const queryMatch = cleanLine.match(/^\*?QUERY\*?\s*:\s*(.*)$/i);
    if (queryMatch) {
      query = cleanParsedValue(queryMatch[1]);
      continue;
    }
    const filtersMatch = cleanLine.match(/^\*?FILTERS\*?\s*:\s*(.*)$/i);
    if (filtersMatch) {
      filters = cleanParsedValue(filtersMatch[1]);
      continue;
    }
  }

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

  // Step 2: Query Expansion
  console.log('Running Query_Expansion_Agent...');
  const expansionPrompt = assemblePrompt(prompts.Query_Expansion_Agent, prompts);
  const expansionResponse = await generateWithRetry(defaultProvider, {
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

  console.log(`Executing active source agents sequentially: ${activeAgents.join(', ')}`);

  // Step 3: Run Selected Source Agents Sequentially to prevent API rate limiting
  const agentResults = [];
  for (const agentName of activeAgents) {
    const sourceType = agentToSourceType(agentName);
    const docs = await searchVectorDb(expandedQuery, sourceType, keywords);

    let docsContext = '';
    if (docs.length === 0) {
      docsContext = 'No documents found in database.';
    } else {
      docsContext = docs.map((doc, idx) => {
        return `Document [${idx + 1}]:\n` +
          `File: ${doc.file || doc.filename || 'unknown'}\n` +
          `Title: ${doc.title || 'unknown'}\n` +
          `Source Type: ${doc.source_type || 'unknown'}\n` +
          (doc.citation ? `Citation: ${doc.citation}\n` : '') +
          (doc.author ? `Author: ${doc.author}\n` : '') +
          (doc.date ? `Date: ${doc.date}\n` : '') +
          `Content: ${doc.content || doc.text || ''}\n`;
      }).join('\n---\n');
    }

    const agentPrompt = assemblePrompt(prompts[agentName], prompts);
    const agentUserMessage = `Query: ${expandedQuery}\nKeywords: ${keywords.join(', ')}\nFilters: ${filters || suggestedFilters}\n\nRetrieved Documents:\n${docsContext}`;

    console.log(`Starting ${agentName}...`);
    const agentResponse = await generateWithRetry(defaultProvider, {
      messages: [{ role: 'user', content: agentUserMessage }],
      systemPrompt: agentPrompt,
      temperature: 0.2
    });

    console.log(`Completed ${agentName}`);
    agentResults.push({
      agentName,
      content: agentResponse.content
    });

    // Add a delay between agent executions to prevent rate limiting (3 seconds)
    await new Promise(resolve => setTimeout(resolve, 3000));
  }

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
  const hasValidFindings = agentResults.some(r => {
    const contentText = (r.content || '').trim();
    if (!contentText) return false;
    const upperContent = contentText.toUpperCase();
    if (upperContent.includes('FOUND: YES')) return true;
    if (upperContent.includes('FOUND: NO') && contentText.length < 50) return false;
    return true; 
  });

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

    const followUpText = followUpResponse.content;
    console.log('Follow up output obtained:', JSON.stringify(followUpText));
    followUpQuestions = followUpText.split('\n')
      .map(line => line.replace(/^-\s*/, '').replace(/^\d+\.\s*/, '').trim())
      .filter(line => line.length > 0 && line.toLowerCase() !== 'none');
  }

  console.log(`Generated ${followUpQuestions.length} follow-up questions.`);
  console.log('--- Agent Flow Completed ---');

  return {
    content: finalAnswer,
    route,
    isClarifying: false,
    follow_up_questions: followUpQuestions
  };
}

module.exports = {
  runAgentFlow,
  loadAgentPrompts
};
