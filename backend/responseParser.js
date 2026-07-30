function cleanResponseText(text) {
  if (!text) return '';

  return String(text)
    .replace(/\uFFFD/g, '')
    .replace(/â€™/g, "'")
    .replace(/â€˜/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€/g, '"')
    .replace(/â€“/g, '–')
    .replace(/â€”/g, '—')
    .replace(/â€‘/g, '-')
    .replace(/â€¯/g, ' ')
    .replace(/Â/g, '')
    .trim();
}

function normalizeFollowUpQuestions(payload) {
  const normalizeList = (value) => {
    if (Array.isArray(value)) {
      return value
        .map(item => (item == null ? '' : String(item).trim()))
        .filter(Boolean);
    }

    if (typeof value === 'string') {
      return value
        .split(/\r?\n/)
        .map(item => item.trim())
        .filter(Boolean);
    }

    return [];
  };

  if (Array.isArray(payload)) {
    return normalizeList(payload);
  }

  if (typeof payload === 'string') {
    return normalizeList(payload);
  }

  if (payload && typeof payload === 'object') {
    const keys = [
      'follow_up_questions',
      'followUpQuestions',
      'followup_questions',
      'suggestions',
      'suggested_questions',
      'suggestedQuestions',
      'recommended_questions',
      'recommendedQuestions',
      'followUps'
    ];

    for (const key of keys) {
      const value = payload[key];
      if (value !== undefined && value !== null) {
        const normalized = normalizeList(value);
        if (normalized.length) {
          return normalized;
        }
      }
    }
  }

  return [];
}

function parseAnswerAndSuggestions(rawAnswer) {
  let answer = cleanResponseText(rawAnswer);
  let suggestions = [];

  const markerRegex = /(?:\*\*|__)?\s*---SUGGESTIONS---\s*(?:\*\*|__)?/i;
  const match = markerRegex.exec(answer);

  if (match) {
    const suggestionText = answer.slice(match.index + match[0].length);

    answer = answer.slice(0, match.index).trim();
    answer = answer.replace(/\n\s*---\s*$/g, '').replace(/\n\s*\*\*\s*$/g, '').trim();

    suggestions = suggestionText
      .split(/\r?\n/)
      .map(line => cleanResponseText(line)
        .replace(/^[-*]\s*/, '')
        .replace(/^\d+[.)]\s*/, '')
        .replace(/^\*\*(.*?)\*\*$/, '$1')
        .trim())
      .filter(Boolean)
      .slice(0, 3);
  }

  // Strip any trailing manual "Sources:" section from text response
  // (The UI frontend renders the interactive Source Citations panel automatically)
  answer = answer.replace(/\n+\s*(?:###?\s*)?(?:\*\*|__)?\s*Sources:?\s*(?:\*\*|__)?[\s\S]*$/i, '').trim();

  return {
    answer,
    suggestions: normalizeFollowUpQuestions(suggestions)
  };
}

module.exports = {
  cleanResponseText,
  normalizeFollowUpQuestions,
  parseAnswerAndSuggestions
};
