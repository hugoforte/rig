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

// Commands that never print the ambient line: `doctor` and `update` report freshness
// themselves and the refresh *is* the check; `prompt` and `help` are reference output being
// read or fed to an agent, and rig's housekeeping does not belong in the middle of it.
export const QUIET_COMMANDS = new Set(['prompt', 'help', 'doctor', 'update', 'freshness-refresh'])

// Why the tool checkout is not a thing to judge for freshness, or null when it is.
// The worktree case is the one that bites: `bin/rig.mjs` resolves the tool root from its own
// location, so the copy inside a work's `rig` worktree would compare a feature branch
// against the default branch and warn on every command for the life of the work.
export function skipReason (state) {
  // `repo` is the enum `checkouts.mjs` answers in — 'none', 'nested' or 'own'. It used to
  // be a boolean here and an enum there, which is the class of bug one state shape exists
  // to prevent: `'none'` is truthy, so a checkout-less tool read as a checkout.
  if (state?.repo !== 'own') {
    return state?.repo === 'nested'
      ? 'the tool is a directory inside another checkout'
      : 'the tool is not a git checkout'
  }
  if (state.linked) return 'the tool is running from a linked worktree'
  if (!state.branch) return 'the tool checkout is on a detached HEAD'
  // `defaultBranch` is null unless the tool could confirm the ref still exists — see
  // `toolState`. An unconfirmed one must not veto: git never refreshes `origin/HEAD`, so
  // after the remote renames its default branch it names one that is gone, and vetoing on it
  // switched the check off for good while blaming the user's branch.
  if (state.defaultBranch && state.branch !== state.defaultBranch) {
    return `the tool checkout is on ${state.branch}, not ${state.defaultBranch}`
  }
  if (!state.upstream) return 'the tool checkout has no upstream'
  return null
}

const HOUR_MS = 3600_000

// A cache with no readable timestamp is due: an unparsable one is likelier a truncated
// write than a fresh check. So is one stamped in the future — a clock that was wrong when
// the cache was written would otherwise freeze the check until wall-clock caught up.
export function dueForRefresh (cache, everyHours = DEFAULT_FRESHNESS.everyHours, now = Date.now()) {
  const at = Date.parse(cache?.checkedAt ?? '')
  if (Number.isNaN(at) || at > now) return true
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

// The line goes to stderr, so it cannot pollute a stdout someone is piping — which is what
// the old TTY test was really protecting. Gating on a TTY as well meant the one audience
// AGENTS.md names for it, an agent shelling out to rig, could never see it.
export const announces = (command, { enabled }) =>
  Boolean(enabled) && !QUIET_COMMANDS.has(command)
