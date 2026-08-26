const { getLLMProvider } = require('./llm/factory');
const { settings } = require('./config');

/**
 * Contextualizes an incoming user question against the conversation history.
 * If the question is a follow-up or linked question (e.g. "are there any relaxation for private companies"),
 * it rephrases it into a self-contained, canonical legal search query.
 */
async function contextualizeUserQuery({ question, chatHistory = [], db = null, sessionId = null }) {
  const rawQuestion = String(question || '').trim();
  if (!rawQuestion) {
    return { standaloneQuery: rawQuestion, isFollowUp: false, originalQuestion: rawQuestion };
  }

  // Gather history if not explicitly provided
  let history = Array.isArray(chatHistory) ? chatHistory : [];
  if (history.length === 0 && sessionId && db) {
    try {
      const messagesCollection = db.collection('chat_messages');
      const docs = await messagesCollection
        .find({ session_id: sessionId })
        .sort({ sequence_number: 1, created_at: 1 })
        .limit(10)
        .toArray();

      history = docs.map((d) => ({
        role: d.role === 'assistant' ? 'assistant' : 'user',
        content: d.content || '',
      })).filter((h) => h.content.trim());
    } catch (err) {
      console.warn('[Contextualizer] Failed to load history from DB:', err.message);
    }
  }

  // Filter out any assistant messages that are too long or empty, keep last 6 messages
  const recentHistory = history
    .slice(-6)
    .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.content.substring(0, 400)}`)
    .join('\n');

  // If there is no previous conversation history, the question is standalone by definition
  if (!recentHistory.trim()) {
    console.log('[Contextualizer] No prior history found. Question is standalone:', rawQuestion);
    return { standaloneQuery: rawQuestion, isFollowUp: false, originalQuestion: rawQuestion, history: [] };
  }

  const prompt = `You are a Senior Indian Corporate & Statutory Law Query Rephraser.
Given a conversation history between a User and an AI Legal Assistant, examine the latest User question.

TASK:
1. Determine if the latest User question is a FOLLOW-UP / LINKED QUESTION dependent on context from previous turns (e.g., "are there any relaxation for private companies", "what about penalties?", "who approves this?").
2. If it IS a follow-up or linked question, rewrite it into a self-contained, canonical legal search query that incorporates the specific legal subject matter, section numbers, companies, or concepts discussed in prior turns (e.g., foreign parent loans, Section 185, ECB regulations).
3. If it is an INDEPENDENT question (a completely new legal topic unrelated to the chat history), return the user's question unchanged.

CONVERSATION HISTORY:
${recentHistory}

LATEST USER QUESTION:
"${rawQuestion}"

OUTPUT FORMAT (Respond STRICTLY in JSON format):
{
  "isFollowUp": true,
  "standaloneQuery": "Rephrased canonical legal question preserving context",
  "reasoning": "Brief explanation"
}`;

  try {
    const provider = getLLMProvider('deepseek', settings.DEEPSEEK_FLASH_MODEL || 'deepseek-v4-flash');
    const response = await provider.generate({
      systemPrompt: prompt,
      messages: [{ role: 'user', content: 'Generate JSON object now.' }],
      temperature: 0.1,
    });

    const contentStr = String(
      response?.content ||
      response?.text ||
      response?.response ||
      response?.message?.content ||
      '{}'
    ).trim();

    let jsonMatch = contentStr.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : contentStr);

    const isFollowUp = Boolean(parsed.isFollowUp);
    const standaloneQuery = String(parsed.standaloneQuery || rawQuestion).trim();

    console.log('[Contextualizer] Contextualization result:', {
      originalQuestion: rawQuestion,
      isFollowUp,
      standaloneQuery,
      reasoning: parsed.reasoning || '',
    });

    return {
      standaloneQuery: standaloneQuery || rawQuestion,
      isFollowUp,
      originalQuestion: rawQuestion,
      reasoning: parsed.reasoning || '',
      history,
    };
  } catch (err) {
    console.warn('[Contextualizer] Error contextualizing query, falling back to original:', err.message);
    return { standaloneQuery: rawQuestion, isFollowUp: false, originalQuestion: rawQuestion, history };
  }
}

module.exports = { contextualizeUserQuery };
