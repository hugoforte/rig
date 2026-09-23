// The two git checkouts an installation is made of — the data root and the tool itself.
// They differ in *policy* and never in mechanism: what to warn about, what to refuse and
// how to word it belongs to the caller; how a checkout is read and moved belongs here.
//
// This is `worktrees.mjs`'s treatment applied to the other half of rig's git. The state
// shape is one shape (there used to be two, disagreeing about whether `repo` was a boolean
// or an enum and whether `upstream` was a name or a flag), and the fast-forward is one
// implementation (there used to be two, disagreeing about what blocks a move).
//
// **Nothing here narrates.** `worktrees.mjs` takes `step` and `warn`; this module answers
// named outcomes instead, because the wording *is* the policy: "run `rig save`" for the
// data root and "`git -C … status` shows them" for the tool are the same outcome said to
// two audiences, and a module that returned prose would have to know which one it was
// talking to.
//
// `run(cmd, args, opts)` is spawnSync-shaped and injected, the way `worktrees.mjs` takes
// it — one spawn in the tool rather than one per module, and a runner a test can stand in
// for when it needs git to answer something real git will not produce on demand. `opts.env`
// is the one place it is not spawnSync-shaped: it names additions, because what a caller
// holds is the environment of the run this is part of, and replacing that here would drop
// the `GIT_CONFIG_GLOBAL` that keeps an isolated run off the machine's own config.
//
// `env` is that same run's, as a thunk, and `gitfs.discover` is what wants it: `GIT_DIR` and
// its four relations are exactly what make `discover` hand a question back, and reading them
// off the process would be reading a different run's answer.
//
// Where a checkout *is* does not go through the runner at all. `gitfs.mjs` walks up for the
// `.git` entry the way git does, reads the branch out of HEAD, and answers null for the
// layouts it will not commit to — so the readings below spawn git for the questions only git
// can answer, and ask it about a path only when the filesystem handed the question back.
import fs from 'node:fs'
import path from 'node:path'
import { discover, headBranch } from './gitfs.mjs'
import { sameDir } from './roots.mjs'

// A fetch may never stop to ask for credentials, and the guard belongs on the operation
// rather than on one helper in `rig.mjs`: the freshness refresh is detached with no
// terminal to answer on, so a fetch that prompts is a stuck process for every command that
// armed one. Asserted by a test, like the spawn options — the only symptom of dropping it
// is a hang, on a machine whose remote happens to want credentials.
export const FETCH_ENV = { GIT_TERMINAL_PROMPT: '0' }

// One shape, whichever question was asked. A field nobody asked for is null rather than
// absent, so a caller reading one that was never measured gets "nobody could tell" — which
// is what null already means everywhere downstream — instead of undefined.
//
//   repo          'none' (not versioned), 'nested' (a directory inside some other
//                 checkout, whose top is `top` — `git add -A` there would stage all of it)
//                 or 'own'
//   linked        the copy running from a linked worktree: its git dir sits under the main
//                 checkout's, which is how git itself tells the two apart
//   branch        null on a detached HEAD
//   defaultBranch what `origin/HEAD` names, but only when that branch still exists
//   upstream      the tracking branch's *name*, never a boolean
//   ahead/behind  against the upstream as last fetched — a caller that wants them current
//                 fetches first. 0 with no upstream; null when git could not answer
//   dirty         entries `git status --porcelain` reports, untracked included — the
//                 tree `git add -A` would sweep up, and what makes one unsafe to commit
//                 into. An untracked *directory* is one entry however many files sit
//                 under it, so this is "is there anything here" with a number beside it
//                 rather than a file count
//   modified      tracked changes only: what actually stops a fast-forward
const UNREAD = Object.freeze({
  repo: 'none', top: null, linked: false, branch: null, defaultBranch: null,
  upstream: null, head: null, ahead: null, behind: null, dirty: null, modified: null,
})

// What a directory git cannot answer for looks like — including the one case the readings
// below never reach, git missing from PATH entirely. Detecting that is the caller's,
// because only the caller knows whether it is fatal: `rig doctor` has to live through it
// long enough to report it.
export const unreadable = () => ({ ...UNREAD })

const firstLine = s => (s || '').split('\n')[0]
const lines = s => s.split('\n').filter(Boolean)

export function checkouts ({ run, env = () => process.env }) {
  const git = (dir, ...args) => run('git', ['-C', dir, ...args])

  // A commit count, or null when git could not answer. Never 0 for "we do not know": a
  // green "up to date" on the strength of a failed command is the kind of quiet wrong
  // answer freshness exists to prevent.
  function countCommits (dir, range) {
    const r = git(dir, 'rev-list', '--count', range)
    if (r.code !== 0) return null
    const n = Number(r.out)
    return Number.isFinite(n) ? n : null
  }

  // Whether this directory is a checkout of its own, and where its top is. Both readings
  // start with it: a directory *inside* another repo would otherwise report that repo's
  // branch and distance as its own.
  //
  // `gitfs.discover` answers it from the filesystem, which is where the answer was all
  // along — "walk up until something is a repository" is a handful of `stat` calls, and
  // this is the most-asked question in the tool. **A null `place` is not a missing
  // repository**: it is the layouts that module declines to commit to, which is the whole
  // reason git is still here to be asked.
  function topOf (dir, place = discover(dir, env())) {
    const top = place ? place.top : gitTop(dir)
    if (!top) return { ...UNREAD }
    if (!sameDir(top, dir)) return { ...UNREAD, repo: 'nested', top }
    return { ...UNREAD, repo: 'own', top }
  }

  const gitTop = dir => {
    const top = git(dir, 'rev-parse', '--show-toplevel')
    return top.code === 0 ? top.out : null
  }

  // Which checkout this is, without reading its tree. `identify` is the only caller left:
  // it runs at the end of every command, and `describe`'s one call below scans the working
  // tree, which is the cost decision 80 kept the two readings apart to avoid.
  //
  // `place` is passed in by `identify`, which has already asked for it — the walk is cheap
  // but it is not free, and doing it twice per command would be paying for one answer with
  // two readings of the same directories.
  function identity (dir, place = discover(dir, env())) {
    const state = topOf(dir, place)
    if (state.repo !== 'own') return state
    const upstream = git(dir, 'rev-parse', '--abbrev-ref', '@{u}')
    return {
      ...state,
      branch: branchOf(dir, place),
      upstream: upstream.code === 0 ? upstream.out : null,
    }
  }

  // Which branch a checkout is on, read one way by every reading here, so `identify`,
  // `describe` and its fallback cannot disagree about it. Never from `branch.head` in the
  // status header: git accepts a branch named `(wip)` and prints it there exactly as it
  // prints its own `(detached)`.
  const branchOf = (dir, place) => place ? headBranch(place.gitDir) : gitBranch(dir)

  const gitBranch = dir => {
    const branch = git(dir, 'symbolic-ref', '-q', '--short', 'HEAD')
    return branch.code === 0 ? branch.out : null
  }

  // Everything the `--branch` header of `git status --porcelain=v2` answers, in one call:
  // the head, the upstream, the distance both ways, and the two ways a tree can be untidy.
  // That is five calls' worth — `rev-parse HEAD`, `rev-parse --abbrev-ref @{u}`, a
  // `rev-list` per direction, and `status --porcelain` — and carrying the header is exactly
  // what the v2 format is for.
  //
  // **`branch.ab` is absent whenever git could not count**, and with an upstream configured
  // that is two different states. The upstream's ref may have gone — what a
  // squash-merge-and-delete or a renamed default branch leaves behind — and `branch.upstream`
  // still names it: that is no upstream at all, there being nothing to move towards or push
  // onto, and it is what `rev-parse @{u}` answers for it in `identity` and the fallback below.
  // Or HEAD is unborn, with nothing to count from: the upstream is real and the distance is
  // unknown. A born HEAD tells the two apart for free; an unborn one asks `@{u}` the same
  // question the other readings ask, which is one call on a branch with no commits yet.
  //
  // Null for a directory git would not answer about at all. Reading that as a clean tree is
  // the quiet wrong answer that matters most here: it is what `rig update` migrates on.
  function branchStatus (dir) {
    const r = git(dir, 'status', '--porcelain=v2', '--branch')
    if (r.code !== 0) return null
    const header = {}
    const entries = []
    for (const line of lines(r.out)) {
      const h = /^# (branch\.\w+) (.*)$/.exec(line)
      if (h) header[h[1]] = h[2]
      else if (!line.startsWith('# ')) entries.push(line)
    }
    const configured = header['branch.upstream'] ?? null
    const ab = /^\+(\d+) -(\d+)$/.exec(header['branch.ab'] ?? '')
    // `(initial)` is git's own word for "there is no commit here", and would otherwise be
    // reported as though it were one.
    const unborn = header['branch.oid'] === '(initial)'
    const upstream = configured && (ab || (unborn && git(dir, 'rev-parse', '--abbrev-ref', '@{u}').code === 0))
      ? configured
      : null
    return {
      head: unborn ? null : header['branch.oid'] ?? null,
      upstream,
      ahead: upstream ? (ab ? Number(ab[1]) : null) : 0,
      behind: upstream ? (ab ? Number(ab[2]) : null) : 0,
      // Untracked entries are the `?` ones, exactly as `??` was in v1.
      dirty: entries.length,
      modified: entries.filter(l => !l.startsWith('? ')).length,
    }
  }

  // Where a checkout stands: its identity, its distance from its upstream, and the two
  // different ways its tree can be untidy. **One git call**, where this cost six as
  // `checkoutState` and still cost six as six separate readings.
  //
  // The fallback is the whole reason the six survive at all. `status` reads the index and
  // `rev-list` does not, so a corrupt index is a tree git cannot read and a distance it
  // still can — and collapsing the readings into one call would have reported that as a
  // checkout nothing is known about, which stops `fastForward` before git gets to refuse in
  // its own words. Four extra calls, on a path where git has already failed and speed is
  // buying nothing.
  function describe (dir) {
    const place = discover(dir, env())
    const state = topOf(dir, place)
    if (state.repo !== 'own') return state
    const branch = branchOf(dir, place)
    const status = branchStatus(dir)
    if (status) return { ...state, branch, ...status }
    const upstream = git(dir, 'rev-parse', '--abbrev-ref', '@{u}')
    const tracking = upstream.code === 0 ? upstream.out : null
    const head = git(dir, 'rev-parse', 'HEAD')
    return {
      ...state,
      branch,
      upstream: tracking,
      head: head.code === 0 ? head.out : null,
      ahead: tracking ? countCommits(dir, '@{u}..HEAD') : 0,
      behind: tracking ? countCommits(dir, 'HEAD..@{u}') : 0,
      // The tree is the half that was unreadable, and a tree nobody could read is not a
      // clean one: `rig update` migrates on this.
      dirty: null,
      modified: null,
    }
  }

  // The copy running from a linked worktree, told the way git tells it: its git dir sits
  // under the main checkout's rather than being it. The `.git` entry the walk landed on and
  // the `commondir` beside it are the two paths `--absolute-git-dir` and `--git-common-dir`
  // print, so this is only asked of git for a layout `gitfs` declined. Both answers are
  // needed to compare them and a git that does not know either option answers neither:
  // reading that as "linked" would switch the freshness check off for good, blaming a
  // worktree the user is not in.
  function gitLinked (dir) {
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir')
    const commonDir = git(dir, 'rev-parse', '--git-common-dir')
    if (gitDir.code !== 0 || commonDir.code !== 0 || !gitDir.out || !commonDir.out) return false
    return !sameDir(gitDir.out, path.resolve(dir, commonDir.out))
  }

  // The same shape, asked the freshness questions instead of the distance ones: whether
  // this checkout is a thing to judge at all (`freshness.mjs`'s `skipReason` decides) and
  // what it is standing on. Kept apart from `describe` because this reading runs at the
  // end of *every* command and a git call costs tens of milliseconds: scanning the tree
  // and counting two ranges for an answer nobody reads would be a tax on the whole tool.
  function identify (dir) {
    const place = discover(dir, env())
    const state = identity(dir, place)
    if (state.repo !== 'own') return state
    // `origin/HEAD` is written once, at clone time, and git never refreshes it. Once the
    // remote renames its default branch the ref names one that no longer exists, so it is
    // believed only when the branch it points at is still there.
    const originHead = git(dir, 'symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')
    const named = originHead.code === 0 ? originHead.out.replace(/^origin\//, '') : null
    const lives = named !== null &&
      git(dir, 'rev-parse', '--verify', '-q', `refs/remotes/origin/${named}`).code === 0
    // On an unborn HEAD git exits 128 and echoes the token `HEAD`, which would be printed
    // as though it were a sha and stamped into the freshness cache as one.
    const head = git(dir, 'rev-parse', 'HEAD')
    return {
      ...state,
      linked: place ? !sameDir(place.gitDir, place.commonDir) : gitLinked(dir),
      defaultBranch: lives ? named : null,
      head: head.code === 0 ? head.out : null,
    }
  }

  // Distance is measured against the upstream *as last fetched*, so this is how a caller
  // makes it current. Never dies and never prompts: an unreachable remote is an ordinary
  // Tuesday, and whether working from what is already here is enough is the caller's call.
  function fetch (dir) {
    const r = run('git', ['-C', dir, 'fetch', '-q'], { env: FETCH_ENV })
    return r.code === 0 ? { ok: true } : { ok: false, error: firstLine(r.err) || 'no detail from git' }
  }

  // The one fast-forward. Never merges and never rebases: a diverged tree is the caller's
  // to sort out, and moving it silently is how a commit gets lost.
  //
  // The order is the order in which the questions stop mattering. `current` beats
  // `blocked` because a tree with nothing to move cannot be stopped from moving — a caller
  // that wants to say something about local changes anyway says it before calling, which
  // is what `rig update` does for the tool checkout.
  //
  // What blocks a move is `modified`, not `dirty`: git refuses on its own when a merge
  // would overwrite an untracked file, so refusing on *any* untracked file lets one stray
  // note wedge the installation — and for the data root, the advice that follows would
  // `git add -A` it and manufacture the divergence being avoided.
  //
  //   not-a-checkout · detached · no-upstream · unmeasurable · current · diverged
  //   · blocked · moved · failed
  //
  // `state` is what it decided from, so a caller can word the numbers; `from` is the HEAD
  // it moved off, for `arrived` and for the reset that puts it back.
  function fastForward (dir) {
    const state = describe(dir)
    if (state.repo !== 'own') return { outcome: 'not-a-checkout', state }
    if (!state.branch) return { outcome: 'detached', state }
    if (!state.upstream) return { outcome: 'no-upstream', state }
    if (state.behind === null) return { outcome: 'unmeasurable', state }
    if (state.behind === 0) return { outcome: 'current', state }
    if (state.ahead) return { outcome: 'diverged', state }
    // `modified` is null when git could not read the tree at all — a corrupt index, say —
    // and that is not a tree with changes in it. Saying so would be a guess worded as a
    // finding; the merge below is where git refuses, and its refusal says what is actually
    // wrong. Same reasoning as the untracked file a merge would overwrite.
    if (state.modified) return { outcome: 'blocked', state }
    const from = git(dir, 'rev-parse', 'HEAD').out
    // `--ff-only` is the headline promise and the last line of it: `ahead` above is a
    // count, a count git could not make is null, and this is what then stands between a
    // distance nobody could measure and a merge commit nobody asked for.
    const ff = git(dir, 'merge', '--ff-only', '@{u}')
    // Divergence is only one reason a fast-forward fails — a lock, a file in the way — and
    // for those git's own words are the actionable part.
    if (ff.code !== 0) return { outcome: 'failed', state, from, error: firstLine(ff.err) || 'no detail from git' }
    return { outcome: 'moved', state, from }
  }

  // What arrived, **newest first** — `git log`'s own order, which is the order a caller
  // printing the first few of them wants them in.
  const arrived = (dir, from) => lines(git(dir, 'log', '--oneline', '--no-decorate', `${from}..HEAD`).out)

  const shortHead = dir => git(dir, 'rev-parse', '--short', 'HEAD').out || null

  // The whole tree, committed under one message. `git add -A`, so a checkout rig commits
  // into is one where everything present is meant to be committed — which is why a caller
  // asks `describe` whether this is a checkout of its own first, and why `.gitignore` is
  // written before a data root's first commit.
  //
  //   committed · nothing (there was nothing staged to commit) · stage-failed
  //   · commit-failed
  //
  // `hash` is the commit this made, short, and null when it made none — which is every
  // outcome but `committed`, and no caller reads it on one of those. Naming HEAD after a
  // commit that never happened was a git call on the commonest path through `rig save`: a
  // data root with nothing new in it.
  function commitAll (dir, message) {
    const add = git(dir, 'add', '-A')
    if (add.code !== 0) return { outcome: 'stage-failed', hash: null, error: firstLine(add.err) }
    // 0 is "nothing staged", 1 is "something is", and anything above that is git failing
    // to say — which must not read as the "something is" that goes on to commit.
    const diff = git(dir, 'diff', '--cached', '--quiet')
    if (diff.code > 1) return { outcome: 'stage-failed', hash: null, error: firstLine(diff.err) || 'git could not say what is staged' }
    if (diff.code === 0) return { outcome: 'nothing', hash: null }
    const commit = git(dir, 'commit', '-q', '-m', message)
    if (commit.code !== 0) return { outcome: 'commit-failed', hash: null, error: firstLine(commit.err || commit.out) }
    return { outcome: 'committed', hash: shortHead(dir) }
  }

  // Is a rebase in progress in this checkout? Asked of git rather than assumed from a
  // path: a linked worktree's rebase state lives in its own git dir, not in `.git`.
  function rebaseUnderway (dir) {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const p = git(dir, 'rev-parse', '--git-path', name)
      if (p.code === 0 && p.out && fs.existsSync(path.resolve(dir, p.out))) return true
    }
    return false
  }

  // Ours on top of theirs, then pushed. The rebase is what makes two machines committing
  // to one data root work at all; the abort is what stops a conflict leaving a tree
  // mid-rebase for someone to find later.
  //
  //   pushed · fetch-failed · underway (someone else's rebase, left alone)
  //   · refused (the rebase never started; nothing was changed)
  //   · conflict (ours, aborted, tree left as it was)
  //   · conflict-stuck (the abort failed too) · push-failed
  //
  // **The abort only ever undoes a rebase this started.** `git rebase` fails for reasons
  // that are not conflicts, and a rebase already in progress is one of them — aborting
  // *that* throws away work nobody asked to lose, including the commit the caller just
  // made, which ends up reachable only from the reflog. So a rebase already underway is
  // reported and left alone, and a rebase that never started is `refused` in git's own
  // words rather than called a conflict.
  //
  // `hash` is HEAD after the rebase rewrote it, which is not what it was before.
  function pushRebasing (dir) {
    const fetched = fetch(dir)
    if (!fetched.ok) return { outcome: 'fetch-failed', hash: null, error: fetched.error }
    if (rebaseUnderway(dir)) return { outcome: 'underway', hash: null }
    const rebase = git(dir, 'rebase', '-q', '@{u}')
    if (rebase.code !== 0) {
      if (!rebaseUnderway(dir)) return { outcome: 'refused', hash: null, error: firstLine(rebase.err) || 'no detail from git' }
      const abort = git(dir, 'rebase', '--abort')
      return { outcome: abort.code === 0 ? 'conflict' : 'conflict-stuck', hash: null, error: firstLine(rebase.err) }
    }
    const hash = shortHead(dir)
    const push = git(dir, 'push', '-q')
    if (push.code !== 0) return { outcome: 'push-failed', hash, error: firstLine(push.err) }
    return { outcome: 'pushed', hash }
  }

  return { countCommits, describe, identify, fetch, fastForward, arrived, commitAll, pushRebasing }
}
