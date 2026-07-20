const { spawn } = require('child_process');
const path = require('path');

const PY_TIMEOUT = 5000; // ms
const fs = require('fs');

let _cachedColangRules = null;

function loadColangScriptedResponses() {
  if (_cachedColangRules) return _cachedColangRules;
  try {
    const filePath = path.resolve(__dirname, '..', 'guardrails', 'config', 'rails.co');
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split(/\r?\n/);
    const rules = [];
    for (let i = 0; i < lines.length; i++) {
      const m = lines[i].match(/if\s+"([^"]+)"\s+in\s+\$user_request/i);
      if (m) {
        // next non-empty line is the bot response string
        let j = i + 1;
        while (j < lines.length && lines[j].trim() === '') j++;
        if (j < lines.length) {
          const respLine = lines[j].trim();
          const jsonMatch = respLine.match(/^"(.*)"$/);
          if (jsonMatch) {
            // unescape interior quotes
            const raw = jsonMatch[1].replace(/\\"/g, '"');
            try {
              const parsed = JSON.parse(raw);
              rules.push({ pattern: m[1].toLowerCase(), response: parsed });
            } catch (e) {
              // not JSON, skip
            }
          }
        }
      }
    }
    _cachedColangRules = rules;
    return rules;
  } catch (e) {
    _cachedColangRules = [];
    return [];
  }
}

function classifyLocal(text) {
  const lowered = (text || '').toLowerCase();

  // Prefer specific matches for farewells and thanks
  if (/\b(bye|goodbye|see you|see you later)\b/i.test(lowered)) {
    return {
      triggered: true,
      category: 'GOODBYE',
      route: 'DIALOG',
      implementation: 'local_fallback',
      response: `Goodbye. Feel free to return whenever you need help with a corporate legal query.`
    };
  }

  const greetingRegex = /^(hi|hello|hey|who are you|what is your name|help|thank you|thanks)\b/i;
  if (greetingRegex.test(lowered)) {
    return {
      triggered: true,
      category: 'DIALOG',
      route: 'DIALOG',
      implementation: 'local_fallback',
      response: `Hello — I am CLA, a corporate legal assistant. Ask me questions about company law, case law, circulars, and related corporate legal topics.`
    };
  }

  const jailbreakRegex = /(ignore (previous|earlier) instructions|reveal (system prompt|prompt)|bypass|jailbreak|override (guardrail|rules)|disclose hidden)/i;
  if (jailbreakRegex.test(text)) {
    return {
      triggered: true,
      category: 'JAILBREAK',
      route: 'JAILBREAK',
      implementation: 'local_fallback',
      response: `I can't comply with requests that try to bypass safety rules or reveal hidden system prompts.`
    };
  }

  const sensitiveRegex = /(illegal|how to hack|commit fraud|explosives|self\-harm|suicide|doxx|personal data|steal|illicit)/i;
  if (sensitiveRegex.test(text)) {
    return {
      triggered: true,
      category: 'SENSITIVE_TOPIC',
      route: 'SENSITIVE_TOPIC',
      implementation: 'local_fallback',
      response: `I'm sorry, but I can't assist with that request.`
    };
  }

  const offTopicRegex = /(score|who won|football|cricket|movie|song|recipe|javascript|programming|how to code|android|iphone)/i;
  if (offTopicRegex.test(text)) {
    return {
      triggered: true,
      category: 'OFF_TOPIC',
      route: 'OFF_TOPIC',
      implementation: 'local_fallback',
      response: `This assistant focuses on corporate law. For general topics like sports, entertainment or coding, please consult a relevant specialist.`
    };
  }

  return { triggered: false, category: 'ALLOW_LEGAL', route: 'ALLOW_LEGAL', implementation: 'local_fallback' };
}

function callPythonGuardrails(text) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.resolve(__dirname, '..', 'guardrails', 'guardrails_service.py');
    const proc = spawn(process.platform === 'win32' ? 'python' : 'python3', [scriptPath], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) {}
      reject(new Error('guardrails: timeout'));
    }, PY_TIMEOUT);

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        // include stderr for diagnostics
        return reject(new Error(`guardrails python exited ${code}: ${stderr}`));
      }
      try {
        const parsed = JSON.parse(stdout);
        return resolve(parsed);
      } catch (err) {
        return reject(new Error('guardrails: invalid json from python'));
      }
    });

    const payload = JSON.stringify({ question: text });
    proc.stdin.write(payload);
    proc.stdin.end();
  });
}

function matchesScriptedPattern(text, pattern) {
  // Word-boundary match, not a plain substring test: a naive `includes()`
  // would flag "which sections apply" as a "hi" greeting.
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`, 'i').test(text);
}

async function checkGuardrails(text) {
  // First, consult .co scripted rules for deterministic dialog responses
  try {
    const scripted = loadColangScriptedResponses();
    const lowered = (text || '').toLowerCase();
    for (const rule of scripted) {
      if (matchesScriptedPattern(lowered, rule.pattern)) {
        // Normalize rule.response
        const resp = rule.response || {};
        if (resp.allowed === false) {
          return {
            action: 'RESPOND',
            route: (resp.category || 'DIALOG').toUpperCase(),
            category: (resp.category || 'DIALOG').toUpperCase(),
            response: resp.response || resp.reason || null,
            blocked: true,
            implementation: 'colang'
          };
        }
        if (resp.allowed === true) {
          return {
            action: 'CONTINUE',
            route: 'LEGAL',
            category: (resp.category || 'ALLOWED').toUpperCase(),
            response: resp.response || null,
            blocked: false,
            implementation: 'colang'
          };
        }
      }
    }
  } catch (e) {
    // ignore parse errors and continue to python/local fallback
  }

  // Try python guardrails if available, otherwise fallback to local classification
  try {
    const result = await callPythonGuardrails(text);
    // Expected python service result: { allowed: bool, category: str, reason: str }
    if (!result || typeof result.allowed !== 'boolean' || !result.category) {
      throw new Error('invalid guardrails output');
    }

    // Normalize into internal contract
    if (result.allowed) {
      return {
        action: 'CONTINUE',
        route: 'LEGAL',
        category: result.category.toUpperCase(),
        response: result.response || result.reason || null,
        blocked: false,
        implementation: 'python'
      };
    }

    // If not allowed, respond with provided message or generic
    return {
      action: 'RESPOND',
      route: (result.category || 'BLOCKED').toUpperCase(),
      category: (result.category || 'BLOCKED').toUpperCase(),
      response: result.response || result.reason || 'Request blocked by guardrails.',
      blocked: true,
      implementation: 'python'
    };
  } catch (err) {
    // Safe fallback but DO NOT label as NeMo
    try {
      const local = classifyLocal(text);
      // local returns { triggered, category, route, implementation, response }
      // Normalize to internal contract
      if (local && local.triggered) {
        return {
          action: 'RESPOND',
          route: (local.route || local.category || 'BLOCKED').toUpperCase(),
          category: (local.category || local.route || 'BLOCKED').toUpperCase(),
          response: local.response || null,
          blocked: true,
          implementation: 'local_fallback'
        };
      }

      return {
        action: 'CONTINUE',
        route: 'LEGAL',
        category: 'ALLOW_LEGAL',
        response: null,
        blocked: false,
        implementation: 'local_fallback'
      };
    } catch (e) {
      // Failure of guardrails must not reveal system info; return safe refusal
      return {
        action: 'RESPOND',
        route: 'SENSITIVE_TOPIC',
        category: 'SENSITIVE_TOPIC',
        response: `I'm unable to process this request right now.`,
        blocked: true,
        implementation: 'error_fallback'
      };
    }
  }
}

module.exports = { checkGuardrails };
