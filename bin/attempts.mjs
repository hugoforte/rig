// Attempts: one branch of a work — a declared stage or the work branch itself — tried several
// ways at once, each way a sibling branch with a worktree of its own, until one is kept
// (hugoforte/rig#321). Pure: names, and what the record says. Everything git can answer —
// which repos carry an attempt, its commits, its diff — is asked of git by the caller.
//
// The record holds only what nothing can see afterwards: that a set existed, how many attempts
// it had, and how it ended. A kept set's losing branches are deleted, so once it ends the record
// is the only place the alternatives are remembered.
//
//   attempts: [{ branch, count, at, passes?, kept?, keptAt?, droppedAt?, reason? }]

// Attempt n of `branch`. `@` is legal in a ref where `@{` is not, and the prefix survives, so
// the release a `feat/` branch asks for is the release its attempts ask for.
export const attemptBranch = (branch, n) => `${branch}@${n}`

// Attempt n's worktree in a repo, flat beside the repo's own: repos sit flat under the work
// folder for the MAX_PATH budget (DESIGN.md §3), and a subfolder per set would spend it again.
export const attemptFolder = (repo, n) => `${repo}@${n}`

// A set still open: neither kept nor dropped. One branch has at most one open set; a new one is
// started only once the last has ended.
export const isOpen = set => !set.keptAt && !set.droppedAt

export const openSet = (work, branch) => (work.attempts || []).find(s => s.branch === branch && isOpen(s)) || null

export const openSets = work => (work.attempts || []).filter(isOpen)

// Every attempt of every open set, in every attached repo, whether or not this machine has its
// folder: `{ set, n, repo, branch, folder }`. Which of them a repo actually carries is git's to
// say; this is the list of names the record makes legitimate.
export const attemptsOf = (work, sets = openSets(work)) => sets.flatMap(set =>
  Array.from({ length: set.count }, (_, i) => i + 1).flatMap(n =>
    (work.repos || []).map(r => ({ set, n, repo: r.repo, branch: attemptBranch(set.branch, n), folder: attemptFolder(r.repo, n) }))))

// What the record must be for every command to read it, or why it is not.
export function attemptsShapeProblem (attempts) {
  if (attempts === undefined) return null
  if (!Array.isArray(attempts)) return '`attempts` is not a list'
  for (const [i, s] of attempts.entries()) {
    if (s === null || typeof s !== 'object' || typeof s.branch !== 'string' || !s.branch) return `attempt set ${i + 1} has no \`branch\``
    // Bounded, since every attempt of every set is listed for each repo: a hand edit to a billion
    // would have every command that reads the record run out of memory.
    if (!Number.isInteger(s.count) || s.count < 1 || s.count > 99) return `attempt set ${s.branch} has no \`count\` from 1 to 99`
    if (typeof s.at !== 'string') return `attempt set ${s.branch} has no \`at\``
    // A pass becomes a repo's `verified` when its attempt is kept, so it is held to that shape.
    const isPass = p => p && Number.isInteger(p.n) && typeof p.repo === 'string' && ['branch', 'head', 'base', 'patchId', 'at'].every(k => typeof p[k] === 'string')
    if (s.passes !== undefined && !(Array.isArray(s.passes) && s.passes.every(isPass))) {
      return `\`passes\` of attempt set ${s.branch} is not a list of passes`
    }
  }
  return null
}

// The attempt number `--keep` and `--n` are given, or why it is not one.
export function attemptNumber (value, flag) {
  if (value === true || value === undefined) return { problem: `${flag} needs a number` }
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || String(n) !== String(value).trim()) return { problem: `${flag} takes a whole number, not "${value}"` }
  return { n }
}
