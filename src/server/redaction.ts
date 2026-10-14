export function redact(text: string) {
  for (const [name, value] of Object.entries(process.env)) {
    if (/TOKEN|SECRET|PASSWORD|API_KEY|AUTH/i.test(name) && value && value.length >= 4) text = text.split(value).join('[REDACTED]');
  }
  return text.replace(/(?:gh[pousr]_|github_pat_|sk-(?:proj-)?)[A-Za-z0-9_-]{16,}/g, '[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._~-]+/gi, '$1[REDACTED]')
    .replace(/((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*)(["'])(.*?)\2/gi, '$1$2[REDACTED]$2')
    .replace(/((?:password|secret|token|api[_-]?key)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, '$1[REDACTED]');
}

// Redact decoded values, never JSON syntax; agent_message.text may itself be JSON.
export function redactStructured(value: unknown): unknown {
  if (typeof value === 'string') {
    try {
      const nested: unknown = JSON.parse(value);
      if (nested && typeof nested === 'object') return JSON.stringify(redactStructured(nested));
    } catch { /* Ordinary text, including quoted configuration examples. */ }
    return redact(value);
  }
  if (Array.isArray(value)) return value.map(redactStructured);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /(?:password|secret|token|api[_-]?key)$/i.test(key) && typeof item === 'string' ? '[REDACTED]' : redactStructured(item)]));
  return value;
}
