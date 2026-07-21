export const ragasRows = [
  { id: 'R-9051', query: 'Summarize the intent of the policy text.', model: 'gpt-4o-mini', faithfulness: '96%', relevancy: '94%', precision: '92%', recall: '89%', correctness: '93%', status: 'Completed' },
  { id: 'R-9073', query: 'Classify whether response is supported by retrieved facts.', model: 'gemini-pro', faithfulness: '91%', relevancy: '87%', precision: '88%', recall: '84%', correctness: '88%', status: 'Review' },
  { id: 'R-9102', query: 'Verify response factuality for legal prompt.', model: 'openai-4.1', faithfulness: '98%', relevancy: '95%', precision: '96%', recall: '94%', correctness: '97%', status: 'Completed' },
  { id: 'R-9134', query: 'Compare generated summary against ground truth.', model: 'groq-1', faithfulness: '89%', relevancy: '85%', precision: '83%', recall: '81%', correctness: '86%', status: 'Review' },
];

export const ragasDetail = {
  question: 'What is the core claim of the policy regarding access control and user privacy?',
  answer: 'The policy enforces strict access control, requiring multi-factor authentication and encrypted data handling.',
  golden: 'Access control and user privacy are preserved through MFA and encryption requirements.',
  context: [
    'Policy excerpt: access tokens must be rotated every 24 hours.',
    'User privacy section requires data minimization and audit logging.',
  ],
  scores: [
    { label: 'Faithfulness', value: 96 },
    { label: 'Relevancy', value: 94 },
    { label: 'Precision', value: 92 },
    { label: 'Recall', value: 89 },
    { label: 'Correctness', value: 93 },
  ],
  comments: 'The model produced a strong answer, but the retrieval context missed one policy clause on data retention.',
};
