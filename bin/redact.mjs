// Secrets taken out of what rig prints from a session, or writes from one (hugoforte/rig#322).
// A session holds whatever passed through it: a pilot over one machine's sessions found AWS key
// ids in 11, `sk-` keys in 13 and connection strings with a password in 26, and an extract copied
// a pasted login verbatim. Every string rig prints from a session goes through here, and so does
// every quote it commits, so the rule is kept in one place. What is matched is replaced by
// `[redacted]`, keeping the name it was assigned to where there was one, so a reader still sees
// that a secret was there and what it was for.
//
// It leans to taking too much where a name says password, and to taking only what looks like a
// key where a name says token or key: `max_tokens: 100000` is a count, and a tokenizer is code.

const R = '[redacted]'

// A quote, plain or escaped inside JSON.
const Q = `\\\\?["']`
// Names that say the value is a password: any value assigned to one goes.
const PASSWORD = '[\\w.-]*(?:passw(?:or)?d|passphrase|pass|pwd)[\\w.-]*'
// Names that say the value may be a key: it goes when it looks like one — a digit in it, or
// twenty characters or more — and is no call, such as `createTokenizer()`.
const KEYISH = '[\\w.-]*(?:token|api[_-]?key|access[_-]?key|private[_-]?key|secret|credential|auth)[\\w.-]*'
const LOOKS_LIKE_KEY = '(?=[^\\s"\'\\\\,;]*\\d|[^\\s"\'\\\\,;]{20})[^\\s"\'\\\\,;()]{8,}(?![\\w(])'

// Each is [pattern, replacement]. Order matters only where one would match inside another:
// whole blocks and URLs first, then tokens, then assignments.
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, R],
  // A URL's user and password, or a password with no user: `https://me:hunter2@host`, `redis://:pw@host`.
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@]*:[^\s@/]+@/gi, `$1${R}@`],
  // A webhook whose URL is the secret.
  [/https:\/\/hooks\.slack\.com\/services\/[\w/]+/g, R],
  // An HTTP credential: `Authorization: Bearer …`, `Basic …`, or a bare `Bearer …`.
  [/\b((?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{8,}/g, `$1${R}`],
  // A password on a command line: `--password hunter2`, `-p'…'` after mysql and its kin.
  [/(--password[= ]\s*)("[^"]*"|'[^']*'|\S+)/gi, `$1${R}`],
  [/(\b(?:mysql|mysqldump|mariadb|mysqladmin)\b[^\n]*?\s-p)(\S+)/gi, `$1${R}`],
  // AWS access key ids.
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA|ANPA)[A-Z0-9]{16}\b/g, R],
  // Tokens with a known prefix: OpenAI and Anthropic, GitHub, GitLab, npm, Atlassian, Slack,
  // Stripe, Google, and an Azure SAS signature.
  [/\bsk-[A-Za-z0-9_-]{16,}/g, R],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, R],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, R],
  [/\bglpat-[A-Za-z0-9_-]{16,}/g, R],
  [/\bnpm_[A-Za-z0-9]{30,}/g, R],
  [/\bATATT[A-Za-z0-9_=-]{20,}/g, R],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, R],
  [/\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g, R],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, R],
  [/([?&]sig=)[A-Za-z0-9%+/=]{16,}/g, `$1${R}`],
  // A JSON Web Token: three base64url parts, the first a JSON header.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, R],
  // `Password=…;` in a connection string, up to the next `;` or quote.
  [/((?:Password|Pwd|AccountKey|SharedAccessKey)\s*=\s*)[^;"'\s\\]+/gi, `$1${R}`],
  // A quoted value assigned to a password name, spaces and all: `"password": "correct horse"`.
  [new RegExp(`(${PASSWORD}${Q}?\\s*[:=]\\s*${Q})(?!\\[redacted\\])[^"'\\\\\\n]{4,}(?=${Q})`, 'gi'), `$1${R}`],
  // An unquoted value assigned to one: `DB_PASS=…`, `password: …`.
  [new RegExp(`(${PASSWORD}${Q}?\\s*[:=]\\s*)(?!\\[redacted\\]|${Q})[^\\s"',;\\\\]{4,}`, 'gi'), `$1${R}`],
  // A value that looks like a key, assigned to a name that says it may be one.
  [new RegExp(`(${KEYISH}${Q}?\\s*[:=]\\s*${Q}?)(?!\\[redacted\\])${LOOKS_LIKE_KEY}`, 'gi'), `$1${R}`],
]

export function redact (text) {
  if (typeof text !== 'string') return text
  return RULES.reduce((s, [pattern, replacement]) => s.replace(pattern, replacement), text)
}
