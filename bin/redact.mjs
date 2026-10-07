// Secrets taken out of what rig prints from a session, or writes from one (hugoforte/rig#322).
// A session holds whatever passed through it: a pilot over one machine's sessions found AWS key
// ids in 11, `sk-` keys in 13 and connection strings with a password in 26, and an extract copied
// a pasted login verbatim. Every string rig prints from a session goes through here, and so does
// every quote it commits, so the rule is kept in one place. What is matched is replaced by
// `[redacted]`, keeping the name it was assigned to where there was one, so a reader still sees
// that a secret was there and what it was for.

const R = '[redacted]'

// Each is [pattern, replacement]. Order matters only where one would match inside another:
// whole blocks and URLs first, then tokens, then assignments.
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, R],
  // A URL's user and password: `https://me:hunter2@host`.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]+:[^\s@/]+@/gi, `$1${R}@`],
  // AWS access key ids, and a secret key assigned by its usual name.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, R],
  // Provider tokens with a known prefix: OpenAI and Anthropic, GitHub, Slack, Stripe, Google.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, R],
  // A JSON Web Token: three base64url parts, the first a JSON header.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R],
  // `Password=…;` in a connection string, up to the next `;` or quote.
  [/\b((?:Password|Pwd|AccountKey|SharedAccessKey)\s*=\s*)[^;"'\s]+/gi, `$1${R}`],
  // An assignment by a name that says secret: `token: …`, `API_KEY=…`, `"password": "…"`.
  [/(\b[\w-]*(?:secret|token|password|passwd|api[_-]?key|access[_-]?key|private[_-]?key)[\w-]*["']?\s*[:=]\s*["']?)(?!\[redacted\])[^\s"',;]{6,}/gi, `$1${R}`],
]

export function redact (text) {
  if (typeof text !== 'string') return text
  return RULES.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), text)
}
