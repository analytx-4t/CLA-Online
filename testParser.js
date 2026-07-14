const fs = require('fs');
const path = require('path');

function loadAgentPrompts() {
  const filePath = path.resolve(__dirname, 'CLAOnline_Agent_Prompts_FINAL.md');
  const content = fs.readFileSync(filePath, 'utf8');
  
  const sections = {};
  const sectionRegex = /##\s+([^\r\n]+)\r?\n\r?\n```\r?\n([\s\S]*?)\r?\n```/g;
  let match;
  while ((match = sectionRegex.exec(content)) !== null) {
    const title = match[1].trim();
    const codeContent = match[2].trim();
    
    let key;
    if (title.includes('SHARED LEGAL CONTEXT')) {
      key = 'SHARED_LEGAL_CONTEXT';
    } else if (title.includes('COMMON RULES')) {
      key = 'COMMON_RULES';
    } else {
      key = title.split(/[(\s]+/)[0].trim();
    }
    sections[key] = codeContent;
  }
  return sections;
}

try {
  const prompts = loadAgentPrompts();
  console.log('Parsed keys:');
  Object.keys(prompts).forEach(k => {
    console.log(` - ${k} (${prompts[k].substring(0, 50).replace(/\n/g, ' ')}...)`);
  });
} catch (err) {
  console.error('Failed to parse prompts:', err);
}
