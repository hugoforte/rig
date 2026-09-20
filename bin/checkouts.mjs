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
// for when it needs git to answer something real git will not produce on demand.
import fs from 'node:fs'
import path from 'node:path'
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

export function checkouts ({ run }) {
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

  // Which checkout this is, and whether it is one at all. Both readings start here.
  function identity (dir) {
    const top = git(dir, 'rev-parse', '--show-toplevel')
    if (top.code !== 0) return { ...UNREAD }
    // A directory *inside* another repo would otherwise report that repo's branch and
    // distance as its own.
    if (!sameDir(top.out, dir)) return { ...UNREAD, repo: 'nested', top: top.out }
    const branch = git(dir, 'symbolic-ref', '-q', '--short', 'HEAD')
    const upstream = git(dir, 'rev-parse', '--abbrev-ref', '@{u}')
    return {
      ...UNREAD,
      repo: 'own',
      top: top.out,
      branch: branch.code === 0 ? branch.out : null,
      upstream: upstream.code === 0 ? upstream.out : null,
    }
  }

  // Where a checkout stands: its identity, its distance from its upstream, and the two
  // different ways its tree can be untidy. Six git calls — the same six this cost as
  // `checkoutState`, because `dirty` and `modified` come from one `status --porcelain`
  // rather than two runs of it: untracked entries are exactly the `??` ones.
  function describe (dir) {
    const state = identity(dir)
    if (state.repo !== 'own') return state
    // A status git would not answer leaves both counts null, the same way an unmeasurable
    // distance does. Reading a failed status as a clean tree is the quiet wrong answer that
    // matters most here: it is what `rig update` migrates on.
    const status = git(dir, 'status', '--porcelain')
    const changes = status.code === 0 ? lines(status.out) : null
    return {
      ...state,
      ahead: state.upstream ? countCommits(dir, '@{u}..HEAD') : 0,
      behind: state.upstream ? countCommits(dir, 'HEAD..@{u}') : 0,
      dirty: changes && changes.length,
      modified: changes && changes.filter(l => !l.startsWith('??')).length,
    }
  }

  // The same shape, asked the freshness questions instead of the distance ones: whether
  // this checkout is a thing to judge at all (`freshness.mjs`'s `skipReason` decides) and
  // what it is standing on. Kept apart from `describe` because this reading runs at the
  // end of *every* command and a git call costs tens of milliseconds: scanning the tree
  // and counting two ranges for an answer nobody reads would be a tax on the whole tool.
  function identify (dir) {
    const state = identity(dir)
    if (state.repo !== 'own') return state
    // Both answers are needed to compare them, and a git that does not know either option
    // answers neither. Reading that as "linked" would switch the freshness check off for
    // good, blaming a worktree the user is not in.
    const gitDir = git(dir, 'rev-parse', '--absolute-git-dir')
    const commonDir = git(dir, 'rev-parse', '--git-common-dir')
    const comparable = gitDir.code === 0 && commonDir.code === 0 && gitDir.out && commonDir.out
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
      linked: comparable ? !sameDir(gitDir.out, path.resolve(dir, commonDir.out)) : false,
      defaultBranch: lives ? named : null,
      head: head.code === 0 ? head.out : null,
    }
  }

  // Distance is measured against the upstream *as last fetched*, so this is how a caller
  // makes it current. Never dies and never prompts: an unreachable remote is an ordinary
  // Tuesday, and whether working from what is already here is enough is the caller's call.
  function fetch (dir) {
    const r = run('git', ['-C', dir, 'fetch', '-q'], { env: { ...process.env, ...FETCH_ENV } })
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
  // `hash` is what HEAD is afterwards, short, or null when there is no commit to name.
  function commitAll (dir, message) {
    const add = git(dir, 'add', '-A')
    if (add.code !== 0) return { outcome: 'stage-failed', hash: null, error: firstLine(add.err) }
    // 0 is "nothing staged", 1 is "something is", and anything above that is git failing
    // to say — which must not read as the "something is" that goes on to commit.
    const diff = git(dir, 'diff', '--cached', '--quiet')
    if (diff.code > 1) return { outcome: 'stage-failed', hash: null, error: firstLine(diff.err) || 'git could not say what is staged' }
    const staged = diff.code === 1
    if (staged) {
      const commit = git(dir, 'commit', '-q', '-m', message)
      if (commit.code !== 0) return { outcome: 'commit-failed', hash: null, error: firstLine(commit.err || commit.out) }
    }
    return { outcome: staged ? 'committed' : 'nothing', hash: shortHead(dir) }
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
