export const gatewayKpis = [
  { label: 'Requests', value: '112.8K', delta: '+4.5%' },
  { label: 'Latency', value: '138 ms', delta: '-1.8%' },
  { label: 'Tokens', value: '24.7M', delta: '+3.1%' },
  { label: 'Cost', value: '$12.2K', delta: '+0.7%' },
  { label: 'Errors', value: '1.7%', delta: '-0.5%' },
];

export const providerUsage = [
  { provider: 'OpenAI', share: '44%' },
  { provider: 'Groq', share: '22%' },
  { provider: 'DeepSeek', share: '18%' },
  { provider: 'Gemini', share: '12%' },
  { provider: 'Other', share: '4%' },
];

export const gatewayLogs = [
  { id: 'G-2051', route: '/v1/claim', provider: 'OpenAI', latency: '128 ms', cost: '$0.17', status: 'Success' },
  { id: 'G-2068', route: '/v1/check', provider: 'Gemini', latency: '244 ms', cost: '$0.21', status: 'Warning' },
  { id: 'G-2074', route: '/v1/resolve', provider: 'DeepSeek', latency: '412 ms', cost: '$0.34', status: 'Critical' },
  { id: 'G-2082', route: '/v1/eval', provider: 'Groq', latency: '178 ms', cost: '$0.09', status: 'Success' },
];
