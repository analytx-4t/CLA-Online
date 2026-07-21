export const logStream = [
  { time: '09:19:42', level: 'INFO', service: 'gateway', message: 'Request forwarded to OpenAI provider.', requestId: 'G-2051' },
  { time: '09:18:59', level: 'WARN', service: 'gemini', message: 'Token quota nearing threshold.', requestId: 'G-2068' },
  { time: '09:17:33', level: 'ERROR', service: 'deeplookup', message: 'Context retrieval timeout.', requestId: 'G-2074' },
  { time: '09:16:05', level: 'INFO', service: 'ragas', message: 'Evaluation run queued.', requestId: 'R-9051' },
];

export const severityStats = [
  { label: 'Info', value: 48 },
  { label: 'Warnings', value: 16 },
  { label: 'Errors', value: 6 },
  { label: 'Critical', value: 2 },
];
