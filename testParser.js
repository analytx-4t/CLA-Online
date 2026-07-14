const fs = require('fs');
const path = require('path');

function loadAgentPrompts() {
  try {
    const filePath = path.resolve(__dirname, 'CLAOnline_Agent_Prompts_FINAL.md');
    const content = fs.readFileSync(filePath, 'utf8');
    
    const sections = {};
    const parts = content.split(/\r?\n##\s+/);
    
    for (const part of parts) {
      const lines = part.split(/\r?\n/);
      if (lines.length === 0) continue;
      const title = lines[0].trim();
      if (!title || title.startsWith('#')) continue;
      
      const bodyLines = lines.slice(1).map(line => {
        const trimmed = line.trim();
        // Remove markdown code block markers and horizontal rules
        if (trimmed === '```' || trimmed === '---' || trimmed === '----') {
          return '';
        }
        return line;
      });
      
      const finalContent = bodyLines.join('\n').trim();
      
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

try {
  const prompts = loadAgentPrompts();
  console.log('Parsed keys:');
  Object.keys(prompts).forEach(k => {
    console.log(` - ${k}: \n${prompts[k].substring(0, 300)}\n-----------------------------`);
  });
} catch (err) {
  console.error('Failed to parse prompts:', err);
}
