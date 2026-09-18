// Mirrors and worktrees, end to end. One module cuts a worktree for a work, removes it,
// and reads its live state. Everything about how a mirror is laid out — the bare clone,
// the fetch refspec it is given, and the `refs/remotes/origin/` prefix that follows from
// that refspec — is known here and nowhere else; callers speak in org, repo, branch and
// directory, and never build a ref.
//
// The invariants, which are DESIGN.md's decisions restated as this module's job:
//   decision 4    worktrees are cut from bare mirrors rig owns, never from a working clone
//   decision 9    a mirror is made on first use and fetched on every cut — no scheduled fetch
//   decision 10   a new branch is based on that repo's own remote HEAD, not a global default
//
// The seam is where a repo's remote lives, and it is the module's own: `remotesOnGitHub`
// is production (https://github.com/<org>/<repo>.git) and `remotesInDirectory` points at a
// directory of bare repos, which is what lets a test attach a real repo with no network and
// no `gh`. rig picks the adapter from RIG_FAKE_REMOTES, as it picks the in-memory `gh` and
// `twg` ones; see `trees()` in rig.mjs.
import fs from 'node:fs'
import path from 'node:path'
import { RigError } from './errors.mjs'

export const remotesOnGitHub = () => ({ url: (org, repo) => `https://github.com/${org}/${repo}.git` })

// A directory laid out the way the mirror root is, so a test's remote is a real repo git
// clones, fetches and pushes to for real — only local.
export const remotesInDirectory = dir => ({ url: (org, repo) => path.join(dir, org, `${repo}.git`) })

// `run(cmd, args, opts)` is spawnSync-shaped and injected, so there is one spawn in the
// tool rather than one per module. `step` and `warn` are how this narrates; both default
// to silence, because a caller that wants nothing said should not have to pass a sink.
export function worktrees ({ mirrorRoot, remotes, run, step = () => {}, warn = () => {} }) {
  const git = (dir, ...args) => run('git', ['-C', dir, ...args])
  const must = (cmd, args) => {
    const r = run(cmd, args)
    if (r.code !== 0) throw new RigError(`${cmd} ${args.join(' ')}\n${r.err || r.out}`)
    return r.out
  }
  const mirrorPath = (org, repo) => path.join(mirrorRoot, org, `${repo}.git`)
  const ref = branch => `refs/remotes/origin/${branch}`

  // Decisions 4 and 9: the mirror is made the first time a repo is used and fetched every
  // time after. A stale mirror silently branching you off a month-old main is the bug this
  // prevents; a fetch that fails warns rather than dies, because an unreachable remote must
  // not stop you working from what the mirror already has.
  function fetched (org, repo) {
    const mirror = mirrorPath(org, repo)
    if (!fs.existsSync(mirror)) {
      step(`mirroring ${org}/${repo} (first use)`)
      fs.mkdirSync(path.dirname(mirror), { recursive: true })
      must('git', ['clone', '--bare', remotes.url(org, repo), mirror])
      // A --bare clone has no fetch refspec; give it one so remote branches land
      // in refs/remotes/origin/* and never collide with our work branches.
      must('git', ['-C', mirror, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
    }
    step(`fetching ${org}/${repo}`)
    const f = git(mirror, 'fetch', '--prune', 'origin')
    if (f.code !== 0) warn(`fetch failed for ${org}/${repo}: ${f.err.split('\n')[0]}`)
    git(mirror, 'remote', 'set-head', 'origin', '-a')
    return mirror
  }

  // Decision 10: the base is what the remote itself calls HEAD. The main/master mix across
  // orgs makes a global default wrong, so the fallback list is only for a remote that never
  // answered — and when nothing answers, saying so beats guessing.
  function remoteHead (mirror, org, repo) {
    const r = git(mirror, 'symbolic-ref', ref('HEAD'))
    if (r.code === 0 && r.out) return r.out.replace(ref(''), '')
    for (const b of ['main', 'master', 'develop']) {
      if (git(mirror, 'rev-parse', '--verify', ref(b)).code === 0) return b
    }
    throw new RigError(`cannot determine the remote HEAD of ${org}/${repo} (${mirror})`)
  }

  const onRemote = (mirror, branch) => git(mirror, 'rev-parse', '--verify', ref(branch)).code === 0

  return {
    // Cut the work's worktree for one repo. Answers the base it used, which is the one
    // thing about the cut worth recording: it is what makes the work re-creatable on
    // another machine. A branch already on the remote is checked out and tracked rather
    // than created, loudly — silently taking over someone else's branch would not be.
    cut ({ org, repo, branch, dest }) {
      const mirror = fetched(org, repo)
      const base = remoteHead(mirror, org, repo)
      if (fs.existsSync(dest)) throw new RigError(`${dest} already exists`)
      if (onRemote(mirror, branch)) {
        warn(`branch ${branch} already exists on ${org}/${repo} — checking it out (not creating)`)
        must('git', ['-C', mirror, 'worktree', 'add', '--track', '-b', branch, dest, ref(branch)])
        return { base }
      }
      step(`worktree ${repo} → ${branch} (base ${base})`)
      must('git', ['-C', mirror, 'worktree', 'add', '-b', branch, dest, ref(base)])
      return { base }
    },

    // Remove-and-prune, once. `detach` dies on the message and `close` warns with it, which
    // is the only thing the two ever disagreed about, so the message is what comes back and
    // the caller decides how loud it is. The prune runs either way: a remove that failed
    // still leaves the mirror's administrative record worth tidying.
    remove ({ org, repo, dir, force = false }) {
      const mirror = mirrorPath(org, repo)
      const args = ['-C', mirror, 'worktree', 'remove', dir]
      if (force) args.push('--force')
      const r = run('git', args)
      git(mirror, 'worktree', 'prune')
      return r.code === 0 ? null : (r.err || r.out)
    },

    // A worktree as it stands right now: nothing here is ever written down (DESIGN.md
    // decision 2 of §1.2). Distance is measured against the upstream when the branch has
    // one and against the recorded base when it does not — a branch that was never pushed
    // still has a base to be ahead of.
    state ({ dir, base }) {
      const s = { missing: !fs.existsSync(dir), dirty: 0, ahead: 0, behind: 0 }
      if (s.missing) return s
      s.dirty = git(dir, 'status', '--porcelain').out.split('\n').filter(Boolean).length
      const up = git(dir, 'rev-parse', '--abbrev-ref', '@{u}')
      const counts = git(dir, 'rev-list', '--left-right', '--count',
        `${up.code === 0 ? '@{u}' : ref(base)}...HEAD`)
      if (counts.code === 0) {
        const [behind, ahead] = counts.out.split(/\s+/).map(Number)
        s.behind = behind || 0
        s.ahead = ahead || 0
      }
      return s
    },

    // Any one mirror for the org, as a place to ask git what it would commit with. Every
    // mirror carries the org's remote URL — which is what a `hasconfig:remote.*.url`
    // conditional include matches on — so any of them answers for the whole org.
    anyMirror (org) {
      if (!mirrorRoot) return null
      const dir = path.join(mirrorRoot, org)
      try {
        const hit = fs.readdirSync(dir).find(e => e.endsWith('.git'))
        return hit ? path.join(dir, hit) : null
      } catch { return null }
    },
  }
}
