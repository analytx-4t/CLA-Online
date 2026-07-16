#!/usr/bin/env python3
"""
Minimal guardrails service.

This script accepts a single JSON object on stdin: {"text": "..."}
It will attempt to use NVIDIA NeMo Guardrails if available; otherwise
it falls back to a rule-based classifier. The script prints a single
JSON object to stdout and writes logs to stderr.

Output format:
{
  "route": "ALLOW_LEGAL|OFF_TOPIC|JAILBREAK|SENSITIVE_TOPIC|DIALOG",
  "category": "...",
  "triggered": true|false,
  "response": "...",
  "implementation": "nemo|fallback"
}
"""
import sys
import json

def fallback_classify(text):
    t = (text or '').lower()
    if any(t.startswith(k) for k in ('hi','hello','hey')) or 'who are you' in t or 'help' in t:
        return {
            'route': 'DIALOG', 'category': 'DIALOG', 'triggered': True,
            'response': 'Hello — I am CLA, a corporate legal assistant. Ask about corporate law topics.',
            'implementation': 'fallback'
        }
    if any(k in t for k in ('ignore previous','reveal system prompt','bypass','jailbreak','override guardrail','reveal prompt','prompt injection')):
        return {
            'route': 'JAILBREAK', 'category': 'JAILBREAK', 'triggered': True,
            'response': "I can't comply with requests that try to bypass safety rules or reveal hidden system prompts.",
            'implementation': 'fallback'
        }
    if any(k in t for k in ('how to hack','commit fraud','explosive','suicide','self-harm','doxx','personal data')):
        return {
            'route': 'SENSITIVE_TOPIC', 'category': 'SENSITIVE_TOPIC', 'triggered': True,
            'response': "I'm sorry, but I can't assist with that request.",
            'implementation': 'fallback'
        }
    if any(k in t for k in ('score','who won','football','cricket','movie','song','recipe','javascript','programming','how to code')):
        return {
            'route': 'OFF_TOPIC', 'category': 'OFF_TOPIC', 'triggered': True,
            'response': "This assistant focuses on corporate law. For general topics, please consult another resource.",
            'implementation': 'fallback'
        }
    return { 'route': 'ALLOW_LEGAL', 'category': 'ALLOW_LEGAL', 'triggered': False, 'response': '', 'implementation': 'fallback' }

def main():
    try:
        raw = sys.stdin.read()
        payload = json.loads(raw)
        text = payload.get('text', '')
    except Exception as e:
        print(json.dumps({ 'route': 'SENSITIVE_TOPIC', 'category': 'SENSITIVE_TOPIC', 'triggered': True, 'response': "Guardrails input error.", 'implementation': 'fallback' }))
        sys.exit(0)

    # Try to use NeMo Guardrails if available
    try:
        from nemo_guardrails import Guard
        # If we reach here, the environment provides a NeMo Guardrails package
        # Integration would be implemented here. For now, we fallback since
        # project environments may not have configuration.
        # Return fallback to avoid pretending NeMo behavior.
        out = fallback_classify(text)
        print(json.dumps(out))
        sys.exit(0)
    except Exception as e:
        # NeMo not available; use fallback
        out = fallback_classify(text)
        print(json.dumps(out))
        sys.exit(0)

if __name__ == '__main__':
    main()
