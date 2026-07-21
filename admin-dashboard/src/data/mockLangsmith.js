export const traceSteps = [
  { step: 'root', duration: '11.4s', detail: 'RAGAS evaluation run' },
  { step: 'context_recall', duration: '2.2s', detail: 'Retrieved context fragments' },
  { step: 'faithfulness', duration: '5.8s', detail: 'Model validation prompts' },
  { step: 'factual_correctness', duration: '10.7s', detail: 'Claim decomposition and checks' },
  { step: 'final_response', duration: '1.8s', detail: 'Generated answer payload' },
];

export const traceMeta = {
  provider: 'OpenAI',
  model: 'gpt-4o-mini',
  latency: '11.46s',
  tokens: '27,435',
  status: 'Success',
  feedback: 'No active issues',
  requestId: 'RGS-13022',
};
