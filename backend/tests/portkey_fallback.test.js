require('dotenv').config();

const { randomUUID } = require('crypto');
const {
    createFallbackChatCompletion,
} = require('../llm/portkey');

async function testFallback() {
    try {
        const traceId = randomUUID();

        console.log('Trace ID:', traceId);
        console.log('Forcing Groq failure and testing DeepSeek fallback...');

        const response = await createFallbackChatCompletion({
            messages: [
                {
                    role: 'user',
                    content: 'Reply exactly: DeepSeek fallback successful',
                },
            ],
            temperature: 0,
            maxTokens: 50,
            traceId,
            configId: process.env.PORTKEY_TEST_CONFIG_ID,
            metadata: {
                session_id: 'deepseek-fallback-test-001',
                query_type: 'forced-fallback-test',
                rag_stage: 'final-generation',
            },
        });

        console.log(
            'Response:',
            response.choices?.[0]?.message?.content
        );
    } catch (error) {
        console.error('Fallback test failed:');
        console.error(error);
        process.exitCode = 1;
    }
}

testFallback();