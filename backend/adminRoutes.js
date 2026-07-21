function setJsonHeaders(res, statusCode) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, x-user-id, x-auth-user-id',
  });
}

async function handleAdminRoutes(req, res, db) {
  const path = req.url.split('?')[0] || '/';

  if (path === '/api/admin/overview' && req.method === 'GET') {
    try {
      const evaluationResultsCollection = db.collection('evaluation_results');
      const evaluations = await evaluationResultsCollection.find({}).toArray();

      const numericFields = ['faithfulness', 'answerRelevancy', 'contextPrecision', 'contextRecall', 'answerCorrectness'];
      const averages = {};

      numericFields.forEach((field) => {
        const values = evaluations
          .map(item => Number(item[field]))
          .filter((value) => Number.isFinite(value));

        averages[field] = values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
      });

      setJsonHeaders(res, 200);
      res.end(JSON.stringify({
        totalRequests: evaluations.length,
        totalEvaluations: evaluations.length,
        avgFaithfulness: averages.faithfulness,
        avgAnswerRelevancy: averages.answerRelevancy,
        avgContextPrecision: averages.contextPrecision,
        avgContextRecall: averages.contextRecall,
        avgAnswerCorrectness: averages.answerCorrectness,
      }));
    } catch (error) {
      setJsonHeaders(res, 500);
      res.end(JSON.stringify({ error: 'Unable to load admin overview.' }));
    }

    return true;
  }

  if (path === '/api/admin/ragas' && req.method === 'GET') {
    try {
      const evaluationResultsCollection = db.collection('evaluation_results');
      const evaluations = await evaluationResultsCollection.find({}).sort({ evaluationTimestamp: -1 }).toArray();

      const response = evaluations.map((item) => ({
        requestId: item.requestId || null,
        sessionId: item.sessionId || null,
        question: item.question || null,
        answer: item.answer || null,
        timestamp: item.timestamp || item.evaluationTimestamp || null,
        faithfulness: item.faithfulness ?? null,
        answerRelevancy: item.answerRelevancy ?? null,
        contextPrecision: item.contextPrecision ?? null,
        contextRecall: item.contextRecall ?? null,
        answerCorrectness: item.answerCorrectness ?? null,
      }));

      setJsonHeaders(res, 200);
      res.end(JSON.stringify({ evaluations: response }));
    } catch (error) {
      setJsonHeaders(res, 500);
      res.end(JSON.stringify({ error: 'Unable to load RAGAS evaluations.' }));
    }

    return true;
  }

  if (path.startsWith('/api/admin/request/') && req.method === 'GET') {
    try {
      const requestId = path.split('/').filter(Boolean).pop();
      const evaluationResultsCollection = db.collection('evaluation_results');
      const evaluationDoc = await evaluationResultsCollection.findOne({ requestId });

      if (!evaluationDoc) {
        setJsonHeaders(res, 404);
        res.end(JSON.stringify({ error: 'Request not found.' }));
        return true;
      }

      const sessionsCollection = db.collection('chat_sessions');
      const messagesCollection = db.collection('chat_messages');

      const session = evaluationDoc.sessionId
        ? await sessionsCollection.findOne({ session_id: evaluationDoc.sessionId }) || null
        : null;
      const messages = evaluationDoc.sessionId
        ? await messagesCollection.find({ session_id: evaluationDoc.sessionId }).toArray()
        : [];

      const response = {
        request: {
          requestId: evaluationDoc.requestId || null,
          sessionId: evaluationDoc.sessionId || null,
          question: evaluationDoc.question || null,
          answer: evaluationDoc.answer || null,
          timestamp: evaluationDoc.timestamp || evaluationDoc.evaluationTimestamp || null,
        },
        evaluation: {
          faithfulness: evaluationDoc.faithfulness ?? null,
          answerRelevancy: evaluationDoc.answerRelevancy ?? null,
          contextPrecision: evaluationDoc.contextPrecision ?? null,
          contextRecall: evaluationDoc.contextRecall ?? null,
          answerCorrectness: evaluationDoc.answerCorrectness ?? null,
          provider: evaluationDoc.provider || null,
          model: evaluationDoc.model || null,
        },
        session: session ? {
          session_id: session.session_id || null,
          user_id: session.user_id || null,
          mode: session.mode || null,
          created_at: session.created_at || null,
        } : null,
        messages: messages.map((message) => ({
          message_id: message.message_id || null,
          role: message.role || null,
          content: message.content || null,
          created_at: message.created_at || null,
        })),
        retrievedContext: Array.isArray(evaluationDoc.retrievedContext)
          ? evaluationDoc.retrievedContext
          : (evaluationDoc.retrievedContext ? [evaluationDoc.retrievedContext] : null),
        provider: evaluationDoc.provider || null,
        model: evaluationDoc.model || null,
      };

      setJsonHeaders(res, 200);
      res.end(JSON.stringify(response));
    } catch (error) {
      setJsonHeaders(res, 500);
      res.end(JSON.stringify({ error: 'Unable to load request details.' }));
    }

    return true;
  }

  return false;
}

module.exports = {
  handleAdminRoutes,
};
