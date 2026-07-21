export const overviewMetrics = [
  { title: 'Total Requests', value: '184.6K', delta: '+6.4%', trend: 'up' },
  { title: 'Avg. Latency', value: '142 ms', delta: '-2.3%', trend: 'down' },
  { title: 'Faithfulness', value: '96.8%', delta: '+1.2%', trend: 'up' },
  { title: 'Answer Correctness', value: '92.3%', delta: '+0.9%', trend: 'up' },
  { title: 'Active Sessions', value: '128', delta: '+8%', trend: 'up' },
  { title: 'Error Rate', value: '1.9%', delta: '-0.4%', trend: 'down' },
];

export const providerHealth = [
  { name: 'OpenAI', status: 'Healthy', latency: '132 ms', throughput: '786 req/min' },
  { name: 'Groq', status: 'Healthy', latency: '118 ms', throughput: '712 req/min' },
  { name: 'DeepSeek', status: 'Review', latency: '205 ms', throughput: '482 req/min' },
  { name: 'Gemini', status: 'Healthy', latency: '149 ms', throughput: '538 req/min' },
];

export const liveRequests = [
  { id: 'REQ-13205', source: 'CLA Gateway', model: 'gpt-4o-mini', latency: '126 ms', status: 'Success' },
  { id: 'REQ-13207', source: 'RAGAS Eval', model: 'gpt-4o-mini', latency: '218 ms', status: 'Warning' },
  { id: 'REQ-13212', source: 'Logfire', model: 'gemini-pro', latency: '89 ms', status: 'Success' },
  { id: 'REQ-13219', source: 'Portkey', model: 'groq-1', latency: '312 ms', status: 'Critical' },
];

export const activityTimeline = [
  { time: '09:16', label: 'Live request spike', detail: 'Token usage rose 22% in 5m.' },
  { time: '09:02', label: 'Deployment check', detail: 'Gateway config updated.' },
  { time: '08:45', label: 'Evaluation review', detail: 'New faithfulness alert created.' },
  { time: '08:18', label: 'Log stream', detail: 'Critical error from Gemini provider.' },
];
