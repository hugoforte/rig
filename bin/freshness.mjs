// Freshness: how far an installation is behind the remote it was cloned from.
//
// The check rides on your own usage — no timer, no hook, no daemon. A command ends by
// spawning a detached refresh that fetches and writes a cache; the *next* command reads
// that cache and prints one dim line. One run of lag, in exchange for a command that never
// waits on a fetch: the fetch that can be slow, prompt for credentials or fail outright
// happens in a process nobody is waiting for, and a failed check is stamped so an unreachable
// remote is retried once per interval rather than after every command. `rig doctor` is the
// exception: it fetches live, because a health check you asked for should answer about now.
//
// Everything here is a decision about state someone else gathered — no git, no fs — so the
// rules are testable without a network or a temp checkout.

export const DEFAULT_FRESHNESS = { enabled: true, everyHours: 24 }

// Commands that never print the ambient line: `prompt` and `help` exist to be piped into
// an agent, where a warning is noise in someone else's input; `doctor` and `update` report
// freshness themselves; the refresh is the check.
export const QUIET_COMMANDS = new Set(['prompt', 'help', 'doctor', 'update', 'freshness-refresh'])

// Why the tool checkout is not a thing to judge for freshness, or null when it is.
// The worktree case is the one that bites: `bin/rig.mjs` resolves the tool root from its own
// location, so the copy inside a work's `rig` worktree would compare a feature branch
// against the default branch and warn on every command for the life of the work.
export function skipReason (state) {
  if (!state?.repo) return 'the tool is not a git checkout'
  if (state.nested) return 'the tool is a directory inside another checkout'
  if (state.linked) return 'the tool is running from a linked worktree'
  if (!state.branch) return 'the tool checkout is on a detached HEAD'
  if (state.defaultBranch && state.branch !== state.defaultBranch) {
    return `the tool checkout is on ${state.branch}, not ${state.defaultBranch}`
  }
  if (!state.upstream) return 'the tool checkout has no upstream'
  return null
}

const HOUR_MS = 3600_000

// A cache with no readable timestamp is due: an unparsable one is likelier a truncated
// write than a fresh check.
export function dueForRefresh (cache, everyHours = DEFAULT_FRESHNESS.everyHours, now = Date.now()) {
  const at = Date.parse(cache?.checkedAt ?? '')
  if (Number.isNaN(at)) return true
  return now - at >= everyHours * HOUR_MS
}

// The line to print from the cache, or null when there is nothing to say. A cache whose
// `sha` is not the checkout's HEAD describes a checkout that no longer exists — someone
// updated since it was written — so it is ignored rather than trusted.
export function staleLine (cache, head) {
  if (!cache?.behind || cache.sha !== head) return null
  const n = cache.behind
  return `rig is ${n} commit${n === 1 ? '' : 's'} behind ${cache.remote || 'its remote'} — \`rig update\``
}

export const announces = (command, { enabled, tty }) =>
  Boolean(enabled) && Boolean(tty) && !QUIET_COMMANDS.has(command)
