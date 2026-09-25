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
import { discover, refSha, symref } from './gitfs.mjs'

export const remotesOnGitHub = () => ({ url: (org, repo) => `https://github.com/${org}/${repo}.git` })

// A directory laid out the way the mirror root is, so a test's remote is a real repo git
// clones, fetches and pushes to for real — only local.
export const remotesInDirectory = dir => ({ url: (org, repo) => path.join(dir, org, `${repo}.git`) })

// `run(cmd, args, opts)` is spawnSync-shaped and injected, so there is one spawn in the
// tool rather than one per module. `step` and `warn` are how this narrates; both default
// to silence, because a caller that wants nothing said should not have to pass a sink.
export function worktrees ({ mirrorRoot, remotes, run, step = () => {}, warn = () => {}, env = () => process.env }) {
  const git = (dir, ...args) => run('git', ['-C', dir, ...args])
  const must = (cmd, args) => {
    const r = run(cmd, args)
    if (r.code !== 0) throw new RigError(`${cmd} ${args.join(' ')}\n${r.err || r.out}`)
    return r.out
  }
  const mirrorPath = (org, repo) => path.join(mirrorRoot, org, `${repo}.git`)
  const ref = branch => `refs/remotes/origin/${branch}`

  // Whether a ref resolves, read from the repository's files where `gitfs` places it and
  // asked of git where it does not (hugoforte/rig#153). A mirror is a bare repository
  // `discover` places for a few stats, and a worktree's common dir is its mirror, which is
  // where every ref asked about below lives. `env` is the run's, as `discover` wants it: a
  // `GIT_DIR` in it is what makes the walk hand the question back.
  const has = (dir, r) => {
    const read = refSha(discover(dir, env()), r)
    if (read) return read.sha !== null
    return git(dir, 'rev-parse', '--verify', '--quiet', r).code === 0
  }

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
    const read = symref(discover(mirror, env()), ref('HEAD'))
    const r = read ? { code: 0, out: read.target ?? '' } : git(mirror, 'symbolic-ref', ref('HEAD'))
    if (r.code === 0 && r.out) return r.out.replace(ref(''), '')
    for (const b of ['main', 'master', 'develop']) {
      if (has(mirror, ref(b))) return b
    }
    throw new RigError(`cannot determine the remote HEAD of ${org}/${repo} (${mirror})`)
  }

  const onRemote = (mirror, branch) => has(mirror, ref(branch))
  const local = branch => `refs/heads/${branch}`
  const kept = (mirror, branch) => has(mirror, local(branch))
  const isAncestor = (mirror, a, b) => git(mirror, 'merge-base', '--is-ancestor', a, b).code === 0

  // The mirror may already hold a copy of the branch: every worktree ever cut on it left one
  // behind in `refs/heads`, because a worktree shares the mirror's ref store and removing the
  // worktree keeps the branch (hugoforte/rig#149). A copy the remote has caught up with is
  // moved to it; one ahead of it is checked out as it is, since those commits exist nowhere
  // else. One that has diverged is refused and left alone — which side is right is not rig's
  // call. A copy some other worktree still has checked out is git's to refuse.
  function checkOutRemote (mirror, org, repo, branch, dest) {
    const behind = !kept(mirror, branch) || isAncestor(mirror, local(branch), ref(branch))
    if (!behind && !isAncestor(mirror, ref(branch), local(branch))) {
      throw new RigError(`branch ${branch} in the mirror of ${org}/${repo} has diverged from the remote's — ` +
        'rig will not overwrite either.\n' +
        `  compare: git -C ${mirror} log --oneline --left-right ${branch}...origin/${branch}\n` +
        `  if the remote is right, remove any worktree that has it checked out, then: git -C ${mirror} branch -D ${branch}`)
    }
    if (behind) {
      must('git', ['-C', mirror, 'worktree', 'add', '--track', '-B', branch, dest, ref(branch)])
      return
    }
    step(`keeping the mirror's copy of ${branch}, which is ahead of the remote`)
    must('git', ['-C', mirror, 'branch', `--set-upstream-to=origin/${branch}`, branch])
    must('git', ['-C', mirror, 'worktree', 'add', dest, branch])
  }

  // A branch that already exists somewhere this machine can see, checked out into `dest`:
  // the remote's copy, or failing that the one the mirror kept. Answers where it came from, or
  // null when neither has it — and then nothing has been made. A folder deleted by hand leaves
  // the mirror a record still claiming its branch, so the mirror is pruned first
  // (hugoforte/rig#151). Prune drops only records whose folder is gone; a live worktree keeps
  // its claim.
  function existing (mirror, org, repo, branch, dest) {
    if (fs.existsSync(dest)) throw new RigError(`${dest} already exists`)
    git(mirror, 'worktree', 'prune')
    if (onRemote(mirror, branch)) {
      checkOutRemote(mirror, org, repo, branch, dest)
      return 'remote'
    }
    if (kept(mirror, branch)) {
      warn(`branch ${branch} is not on ${org}/${repo} but the mirror kept a copy — checking it out as it is`)
      must('git', ['-C', mirror, 'worktree', 'add', dest, branch])
      return 'mirror'
    }
    return null
  }

  return {
    // Cut the work's worktree for one repo. Answers the base it used, which is the one
    // thing about the cut worth recording: it is what makes the work re-creatable on
    // another machine. A branch already on the remote is checked out and tracked rather
    // than created, loudly — silently taking over someone else's branch would not be.
    //
    // A branch only the mirror has — never pushed, or deleted from the remote once merged —
    // is checked out as it is, with a warning: its commits exist nowhere else, and whether
    // they are still wanted is for whoever is looking at them to say.
    cut ({ org, repo, branch, dest }) {
      const mirror = fetched(org, repo)
      const base = remoteHead(mirror, org, repo)
      const from = existing(mirror, org, repo, branch, dest)
      if (from === 'remote') warn(`branch ${branch} already exists on ${org}/${repo} — checking it out (not creating)`)
      if (from) return { base }
      step(`worktree ${repo} → ${branch} (base ${base})`)
      must('git', ['-C', mirror, 'worktree', 'add', '-b', branch, dest, ref(base)])
      return { base }
    },

    // Fetch a repo's mirror, making it on first use, without cutting anything. `rig restore`
    // reads the stack out of the mirror before it knows which branch to check out, and a stack
    // read from a mirror this machine has never fetched is no stack at all.
    fetch ({ org, repo }) {
      fetched(org, repo)
    },

    // Check out a branch that already exists, and never make one: `cut` above, less its last
    // resort. A restore puts back what the record describes, and a branch gone from the remote
    // and the mirror alike is something to report, not to recreate from the remote HEAD as if
    // the work were starting over (hugoforte/rig#112). Answers `remote`, `mirror`, or null when
    // neither has the branch. Call `fetch` first.
    checkOut ({ org, repo, branch, dest }) {
      return existing(mirrorPath(org, repo), org, repo, branch, dest)
    },

    // Does `branch` already hold every commit of `other`? True when any copy of `branch` —
    // the remote's or the one the mirror kept — holds any copy of `other`, because the mirror's
    // copy is wherever a worktree last left it and the remote may have moved on since. False
    // when either is nowhere to be found.
    contains ({ org, repo, branch, other }) {
      const mirror = mirrorPath(org, repo)
      const copies = b => [ref(b), local(b)].filter(r => has(mirror, r))
      return copies(branch).some(a => copies(other).some(b => isAncestor(mirror, b, a)))
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

    // Delete a branch whose pull request merged, from the mirror and from the remote. `head` is
    // the commit the PR carried, and it is the whole of the safety: a copy is deleted only when
    // everything on it is in that commit, so nothing that exists nowhere else can go. The mirror's
    // copy must be `head` or behind it; the remote's must be `head` exactly, and the push leases
    // on it, so a commit pushed after the merge keeps the branch rather than being lost with it.
    //
    // Answers what happened to each copy — `deleted`, `absent`, or why it was kept — and never
    // throws: a close has already torn the work down by now, and a branch left behind is a
    // thing to say, not a reason to fail.
    dropMerged ({ org, repo, branch, head }) {
      const mirror = mirrorPath(org, repo)
      const out = { local: 'absent', remote: 'absent' }
      if (!fs.existsSync(mirror)) return out
      if (kept(mirror, branch)) {
        out.local = !isAncestor(mirror, local(branch), head) ? 'kept — it has commits the merged PR did not'
          : git(mirror, 'branch', '-D', branch).code === 0 ? 'deleted'
          : 'kept — git would not delete it'
      }
      const ls = git(mirror, 'ls-remote', '--heads', 'origin', local(branch))
      if (ls.code !== 0) out.remote = `kept — the remote did not answer: ${(ls.err || ls.out).split('\n')[0]}`
      else if (ls.out.trim()) {
        const tip = ls.out.trim().split(/\s+/)[0]
        const push = tip !== head ? null
          : git(mirror, 'push', '--quiet', `--force-with-lease=${local(branch)}:${head}`, 'origin', '--delete', branch)
        out.remote = !push ? 'kept — it has moved since the PR merged'
          : push.code === 0 ? 'deleted'
          : `kept — the push was refused: ${(push.err || push.out).split('\n')[0]}`
        if (push?.code === 0) git(mirror, 'update-ref', '-d', ref(branch))
      }
      return out
    },

    // A worktree as it stands right now: nothing here is ever written down (DESIGN.md
    // decision 2 of §1.2). Distance is measured against the upstream when the branch has
    // one and against a base when it does not — a branch that was never pushed still has a
    // base to be ahead of.
    //
    // `base` is the base the branch lands on *now*, which for a stacked PR is another PR's
    // branch rather than the one the work was cut from; `recordedBase` is that recorded
    // one, and it answers when the live base names a branch this mirror has never fetched.
    // Measuring a stacked branch against `main` counts the PR underneath it as this work's
    // own commits, which is the ahead/behind half of hugoforte/rig#24.
    //
    // A distance git could not measure answers `ahead: null` / `behind: null` with the
    // reason, in the shape `prError` established, rather than a confident zero: after a
    // squash merge both refs can be gone, and "0 ahead" then reads as a branch with
    // nothing outstanding, which is a different claim from "nobody could tell".
    // `branch` is optional and answers one extra question: has this branch reached the
    // remote? Only `rig next` asks, and only it passes one.
    state ({ dir, base, recordedBase = base, branch = null }) {
      const s = { missing: !fs.existsSync(dir), dirty: 0, ahead: 0, behind: 0 }
      if (s.missing) return s
      // Asked of the branch's own remote-tracking ref, never of `@{u}`: cutting a branch from
      // `refs/remotes/origin/main` makes git set tracking to *main*, so an upstream exists
      // from the moment `rig attach` runs and says nothing about whether anyone pushed.
      s.pushed = branch ? has(dir, ref(branch)) : false
      s.dirty = git(dir, 'status', '--porcelain').out.split('\n').filter(Boolean).length
      const count = from => git(dir, 'rev-list', '--left-right', '--count', `${from}...HEAD`)
      // The count is the question, so the count is what is asked. `@{u}` fails to resolve for
      // both the reasons there are — no upstream configured, and one configured whose ref went
      // with a deleted head branch — and the count fails with it, in git's own words. Asking
      // `rev-parse --abbrev-ref @{u}` first bought that same verdict one spawn earlier, and the
      // base was resolved whether or not anything ever measured against it: three git calls
      // where the ordinary branch, which has an upstream and has been pushed, needs one.
      //
      // `fellBack` is the base ref it measured against instead, and null while the upstream
      // answered — which is the only thing the two paths still have to be told apart for.
      let counts = count('@{u}')
      let fellBack = null
      if (counts.code !== 0) {
        const known = [base, recordedBase].filter(Boolean)
          .find(b => has(dir, ref(b)))
        fellBack = ref(known || base)
        counts = count(fellBack)
      }
      if (counts.code !== 0) {
        s.ahead = s.behind = null
        s.distanceUnknown = (counts.err || counts.out).split('\n')[0].trim() ||
          `git could not measure ${dir} against ${fellBack ?? 'its upstream'}`
        return s
      }
      const [behind, ahead] = counts.out.split(/\s+/).map(Number)
      s.behind = behind || 0
      s.ahead = ahead || 0
      return s
    },

    // Cut a stage's branch in a worktree that already exists, on top of whatever this repo's
    // stack reaches now. `cut` above makes the *work* branch, from the remote HEAD, in a
    // worktree that does not exist yet; this is the other kind, and the difference that
    // matters is that rig is watching — the one moment a stage's base is not in doubt.
    //
    // Whatever is uncommitted comes along, because starting work and then realising it wants
    // its own stage is the ordinary way round. git decides whether that is possible, and its
    // refusal is what comes back.
    cutHere ({ dir, branch, base }) {
      const r = git(dir, 'checkout', '-b', branch, base)
      return r.code === 0 ? null : ((r.err || r.out).split('\n').find(Boolean) || '').trim()
    },

    // Which of this work's stage branches the repo actually carries, and what each one sits
    // on. The branches are named by the work — its declared stages — so this asks about a
    // handful of refs rather than reading everything the mirror holds, which it shares with
    // every other work on the same repo.
    //
    // **Nothing here is written down.** The stack is a question the commits already answer,
    // and an answer copied into the record is wrong the first time anyone re-points a branch.
    //
    // No fetch, either: `rig stage`, `rig plan` and `rig pr` all come through here, and none
    // of them asked for a network round trip. A branch cut in a worktree is already in the
    // mirror's `refs/heads`, because the worktree shares the mirror's ref store; a branch
    // pushed from another machine is under `refs/remotes/origin`.
    //
    // A stage's base is the branch below it in the stack: the nearest of the work's other
    // stages that is an ancestor of it, and only failing that the work branch. That holds
    // while a stage's pull request **merges** into the branch below rather than being squashed
    // onto it: a squash replaces the commits, so the originals stop being ancestors of anything
    // and the chain goes with them. `stageOrder` falls back to declaration order for whatever
    // cannot be placed, which is the net under exactly that.
    chain ({ org, repo, branch, base, stages = [] }) {
      const mirror = mirrorPath(org, repo)
      if (!fs.existsSync(mirror) || !stages.length) return []
      // A branch cut here, or one only ever seen on the remote. Either is this repo carrying
      // it; which of the two it is says nothing about the stage.
      //
      // Asked for every branch at once: `rev-parse --verify` answers for one ref, so a work
      // with four stages spent ten spawns finding out which of them this repo has. The
      // branches are all named up front — that is what a declared stage is — so one
      // `for-each-ref` over the exact refnames answers for the lot. A pattern nothing matches
      // contributes nothing and is not an error, which is the answer wanted for a stage this
      // repo does not carry.
      const named = [...new Set([branch, ...stages].filter(Boolean))]
      const listed = git(mirror, 'for-each-ref', '--format=%(refname) %(objectname)',
        ...named.flatMap(b => [`refs/heads/${b}`, ref(b)]))
      const revs = new Map()
      for (const line of (listed.code === 0 ? listed.out : '').split('\n').filter(Boolean)) {
        const gap = line.indexOf(' ')
        if (gap > 0) revs.set(line.slice(0, gap), line.slice(gap + 1).trim())
      }
      const revOf = b => revs.get(`refs/heads/${b}`) || revs.get(ref(b)) || null

      const present = stages.map(b => ({ branch: b, rev: revOf(b) })).filter(b => b.rev)
      if (!present.length) return []

      // Ancestry is asked of the same pair of commits several times over — once to place a
      // stage, again to compare two candidates already under one, again to measure a stage
      // against where the work branch was cut — and two commits do not change their
      // relationship while this runs. So each pair costs one spawn, whoever asks for it.
      const ancestors = new Map()
      const ancestor = (a, b) => {
        const pair = `${a.rev} ${b.rev}`
        if (!ancestors.has(pair)) {
          ancestors.set(pair, git(mirror, 'merge-base', '--is-ancestor', a.rev, b.rev).code === 0)
        }
        return ancestors.get(pair)
      }
      // The nearest of `pool` that is an ancestor of `b`. A branch nobody has committed on yet
      // sits at the same commit as the one below it, so ancestry is mutual and would place each
      // under the other. The order of `pool` breaks that tie, which is declaration order, the
      // one thing that can tell them apart.
      const nearest = (pool, b) => {
        const at = c => pool.indexOf(c)
        const below = c => c !== b && ancestor(c, b) && (c.rev !== b.rev || at(c) < at(b))
        const nearer = (best, c) => !best || (best.rev === c.rev ? at(c) > at(best) : ancestor(best, c))
        return pool.filter(below).reduce((best, c) => nearer(best, c) ? c : best, null)
      }

      // The work branch is asked last, because merging the stack down moves it *up* the stack:
      // fast-forwarded to the top stage it is that stage's commit, and as a candidate beside the
      // stages it would be the nearest ancestor of the top one and of nothing below — the top
      // stage placed first and the rest lost (hugoforte/rig#142). The stages keep saying which
      // sits on which however far the work branch has moved, so they answer first, and the work
      // branch is the base only of a stage with none below it: one cut from it, or one merged
      // down into it. It never gets a base derived for itself: that is the remote HEAD it was
      // cut from, which is in the record and which git cannot say.
      const workRev = revOf(branch)
      const work = workRev ? { branch, rev: workRev } : null
      const onWork = b => !!work && (ancestor(work, b) || ancestor(b, work))

      // Only a stage carrying this work's commits can be read that way. One nobody has
      // committed on is still where it was cut, which is an ancestor of everything after it —
      // exactly the shape of a stage merged down first, with none of its commits — so read as
      // one it would become what every later stage sits on. What it carries is measured from
      // where the work branch was cut; an empty stage keeps the reading it always had, the work
      // branch beside the stages as candidates, below them on a tie.
      //
      // Where it was cut is where the work branch meets the remote's base branch — never the
      // mirror's own `refs/heads/<base>`, which is the first clone's and never moves again.
      // A measure that finds every stage empty tells none of them apart, and it does once the
      // work has landed in its base branch, so it is dropped rather than letting that read the
      // whole stack the old way.
      const fork = work && base ? git(mirror, 'merge-base', work.rev, ref(base)) : null
      const forkRev = fork?.code === 0 ? fork.out.trim() : null
      const measured = present.filter(b => !forkRev || !ancestor(b, { rev: forkRev }))
      const carries = b => !measured.length || measured.includes(b)
      const worked = present.filter(carries)
      const idle = (work ? [work] : []).concat(present)

      return present.map(b => {
        if (!carries(b)) return { branch: b.branch, base: nearest(idle, b)?.branch ?? null }
        const stage = nearest(worked, b)
        return { branch: b.branch, base: stage ? stage.branch : onWork(b) ? branch : null }
      })
    },

    // Any one mirror for the org, as a place to ask git what it would commit with. Every
    // mirror carries the org's remote URL — which is what a `hasconfig:remote.*.url`
    // conditional include matches on — so any of them answers for the whole org.
    anyMirror (org) {
      const dir = path.join(mirrorRoot, org)
      try {
        const hit = fs.readdirSync(dir).find(e => e.endsWith('.git'))
        return hit ? path.join(dir, hit) : null
      } catch { return null }
    },
  }
}
