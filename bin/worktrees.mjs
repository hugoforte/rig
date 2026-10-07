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
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { RigError } from './errors.mjs'
import { discover, headBranch, refSha, symref } from './gitfs.mjs'
import { NO_PROMPT_ENV, NEEDS_CREDENTIALS, signIn } from './remote-env.mjs'

export const remotesOnGitHub = () => ({ url: (org, repo) => `https://github.com/${org}/${repo}.git` })

// A directory laid out the way the mirror root is, so a test's remote is a real repo git
// clones, fetches and pushes to for real — only local.
export const remotesInDirectory = dir => ({ url: (org, repo) => path.join(dir, org, `${repo}.git`) })

// `run(cmd, args, opts)` is spawnSync-shaped and injected, so there is one spawn in the
// tool rather than one per module. `step` and `warn` are how this narrates; both default
// to silence, because a caller that wants nothing said should not have to pass a sink.
export function worktrees ({ mirrorRoot, remotes, run, step = () => {}, warn = () => {}, env = () => process.env }) {
  const git = (dir, ...args) => run('git', ['-C', dir, ...args])
  // A call that may reach the remote, which may never stop to ask for credentials (decision 138):
  // a checkout is one, because Git LFS fetches what it checks out.
  const toRemote = (dir, ...args) => run('git', ['-C', dir, ...args], { env: NO_PROMPT_ENV })
  const must = (cmd, args, opts) => {
    const r = run(cmd, args, opts)
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
      const url = remotes.url(org, repo)
      const clone = run('git', ['clone', '--bare', url, mirror], { env: NO_PROMPT_ENV })
      if (clone.code !== 0) {
        const detail = clone.err || clone.out
        throw new RigError(NEEDS_CREDENTIALS.test(detail)
          ? `could not mirror ${org}/${repo}: git needed credentials for ${url}, and rig never waits at a prompt — sign git in (\`gh auth setup-git\`) and run this again\n${detail}`
          : `git clone --bare ${url} ${mirror}${signIn(detail)}\n${detail}`)
      }
      // A --bare clone has no fetch refspec; give it one so remote branches land
      // in refs/remotes/origin/* and never collide with our work branches.
      must('git', ['-C', mirror, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*'])
    }
    step(`fetching ${org}/${repo}`)
    const f = toRemote(mirror, 'fetch', '--prune', 'origin')
    if (f.code !== 0) warn(`fetch failed for ${org}/${repo}: ${f.err.split('\n')[0]}`)
    toRemote(mirror, 'remote', 'set-head', 'origin', '-a')
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

  // Which branch a worktree has checked out, read from its HEAD where `gitfs` places it and
  // asked of git where it does not.
  const checkedOut = dir => {
    const place = discover(dir, env())
    if (place?.gitDir) return headBranch(place.gitDir)
    const r = git(dir, 'symbolic-ref', '-q', 'HEAD')
    return r.code === 0 && r.out.startsWith('refs/heads/') ? r.out.slice('refs/heads/'.length) : null
  }

  const onRemote = (mirror, branch) => has(mirror, ref(branch))
  const local = branch => `refs/heads/${branch}`
  const kept = (mirror, branch) => has(mirror, local(branch))
  const isAncestor = (mirror, a, b) => git(mirror, 'merge-base', '--is-ancestor', a, b).code === 0

  // Why the copy at `tip` holds something `head` does not, or null when it holds nothing else.
  // A copy at `head` or behind it holds nothing else. One that is not may still have landed:
  // GitHub re-makes a stacked PR's commits when it retargets it (hugoforte/rig#257), so the
  // same patches are in `head` under other shas. Two questions, and both must answer "landed".
  // By patch: `--cherry-pick` drops each commit whose patch-id is on the head's side, and what
  // is left, merges aside, is named, the oldest first. By content: a patch-id ignores
  // whitespace, and a merge has none, so merging the copy into `head` must give `head`'s tree —
  // an amend that only re-indented, or a merge that settled a conflict by hand, fails there.
  // A git call that fails keeps the copy, since no answer is not "landed".
  const unlandedReason = (mirror, tip, head, number) => {
    if (isAncestor(mirror, tip, head)) return null
    const failed = r => `git could not compare it with PR #${number}'s head: ${(r.err || r.out).split('\n')[0]}`
    const left = git(mirror, 'rev-list', '--reverse', '--topo-order', '--no-merges', '--right-only', '--cherry-pick', `${head}...${tip}`)
    if (left.code !== 0) return failed(left)
    const unlanded = left.out.split('\n').filter(Boolean)
    if (unlanded.length) {
      const named = git(mirror, 'log', '-1', '--format=%h "%s"', unlanded[0]).out.trim()
      return `${named} is not in what PR #${number} merged${unlanded.length > 1 ? ` (and ${unlanded.length - 1} more)` : ''}`
    }
    const tree = git(mirror, 'rev-parse', `${head}^{tree}`)
    if (tree.code !== 0) return failed(tree)
    const merged = git(mirror, 'merge-tree', '--write-tree', head, tip)
    return merged.code === 0 && merged.out.split('\n')[0].trim() === tree.out.trim() ? null
      : `merging it into PR #${number}'s head would change what that PR merged`
  }

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
      must('git', ['-C', mirror, 'worktree', 'add', '--track', '-B', branch, dest, ref(branch)], { env: NO_PROMPT_ENV })
      return
    }
    step(`keeping the mirror's copy of ${branch}, which is ahead of the remote`)
    must('git', ['-C', mirror, 'branch', `--set-upstream-to=origin/${branch}`, branch])
    must('git', ['-C', mirror, 'worktree', 'add', dest, branch], { env: NO_PROMPT_ENV })
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
      must('git', ['-C', mirror, 'worktree', 'add', dest, branch], { env: NO_PROMPT_ENV })
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
      must('git', ['-C', mirror, 'worktree', 'add', '-b', branch, dest, ref(base)], { env: NO_PROMPT_ENV })
      return { base }
    },

    // Fetch a repo's mirror, making it on first use, without cutting anything. `rig restore`
    // reads the stack out of the mirror before it knows which branch to check out, and a stack
    // read from a mirror this machine has never fetched is no stack at all.
    fetch ({ org, repo }) {
      fetched(org, repo)
    },

    // A fetch for a read-only question: never a first clone, never a word on the way, and an
    // answer of whether it reached the remote, so a count read off a mirror it could not bring
    // forward is not passed off as a fresh one.
    refresh ({ org, repo }) {
      const mirror = mirrorPath(org, repo)
      return fs.existsSync(mirror) && toRemote(mirror, 'fetch', '--prune', 'origin').code === 0
    },

    // How a pushed branch stands against the base it is about to land on, both as the remote
    // has them: `behind`, the commits the base has that the branch lacks, and `conflicts`, the
    // files a merge of the two would conflict in, found without touching any worktree
    // (`merge-tree --write-tree`, git 2.38). Null when git cannot count, such as for a ref the
    // mirror lacks. When git will not try the merge, as for unrelated histories, `conflicts` is
    // null and `error` says why, since no answer is not the same as a clean one. Call `fetch`
    // first, or the base is the one this mirror last saw.
    standing ({ org, repo, branch, base }) {
      const mirror = mirrorPath(org, repo)
      const counted = git(mirror, 'rev-list', '--count', `${ref(branch)}..${ref(base)}`)
      if (counted.code !== 0) return null
      // Exit 1 is a merge that conflicts; the tree it wrote comes first, then one file a line,
      // unquoted so a name with a non-ASCII character reads as itself.
      const merged = git(mirror, '-c', 'core.quotePath=false', 'merge-tree', '--write-tree', '--name-only', '--no-messages', ref(base), ref(branch))
      const behind = Number(counted.out)
      if (merged.code !== 0 && merged.code !== 1) {
        return { behind, conflicts: null, error: (merged.err || merged.out).split('\n')[0] || `git merge-tree exited ${merged.code}` }
      }
      const conflicts = merged.code === 1 ? merged.out.split('\n').slice(1).map(f => f.trim()).filter(Boolean) : []
      return { behind, conflicts }
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

    // Did a stage's pull request land as new commits — a squash or a rebase — while stages
    // stacked above it still carry the ones it replaced (decision 113)? `head` is the commit the
    // PR carried, `merge` the one it landed as, and `above` the stages above it in this repo, in
    // stack order.
    //
    // `{ unfetched: true }` when this mirror lacks `merge` or its work branch does not hold it
    // yet, which a fetch answers. Null when the PR merged the stage's own commits, when the work
    // branch holds them, or when nothing above carries them. Otherwise `carriers` are the stages
    // above that do, read from the remote's copy first so a stale copy here never counts;
    // `rebased` says every carrier's copy here has been replayed and only the push is left;
    // `behind` names the carriers whose copy here the remote's has moved past, which a replay
    // from here would overwrite; and `sameTree` says the merge is what merging `head` onto the
    // work branch gave.
    replaced ({ org, repo, work, head, merge, above = [] }) {
      const mirror = mirrorPath(org, repo)
      if (!fs.existsSync(mirror) || !head || !merge) return null
      const commit = sha => git(mirror, 'cat-file', '-e', `${sha}^{commit}`).code === 0
      if (!commit(head) || !has(mirror, ref(work))) return null
      if (!commit(merge) || !isAncestor(mirror, merge, ref(work))) return { unfetched: true }
      if (isAncestor(mirror, head, merge) || isAncestor(mirror, head, ref(work))) return null
      // Carries a commit of the stage the work branch does not have. Asked through the merge
      // base, not `head` itself: a stage fixed after the one above was cut from it is still
      // under that one, at an earlier commit.
      const carries = r => {
        const base = git(mirror, 'merge-base', head, r)
        return base.code === 0 && !isAncestor(mirror, base.out.trim(), ref(work))
      }
      const copy = b => [ref(b), local(b)].find(r => has(mirror, r))
      const carriers = above.filter(b => copy(b) && carries(copy(b)))
      if (!carriers.length) return null
      const rebased = carriers.every(b => has(mirror, local(b)) && !carries(local(b)))
      const behind = carriers.filter(b => has(mirror, local(b)) && has(mirror, ref(b)) && !isAncestor(mirror, ref(b), local(b)))
      const merged = git(mirror, 'merge-tree', '--write-tree', `${merge}^1`, head)
      const tree = git(mirror, 'rev-parse', `${merge}^{tree}`).out.trim()
      return { carriers, rebased, behind, sameTree: merged.code === 0 && merged.out.split('\n')[0].trim() === tree }
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
    // copy must have landed in `head`, by sha or by patch and content (`unlandedReason`); the remote's must be
    // `head` exactly, and the push leases on it, so a commit pushed after the merge keeps the
    // branch rather than being lost with it.
    //
    // The mirror may never have seen `head`: a PR updated on GitHub — "Update branch" — carries
    // a commit no fetch brought here, and asking whether the copy is behind a commit git does not
    // have answers no. So that commit is fetched first, from `refs/pull/<number>/head`, which
    // GitHub keeps after the branch is deleted (hugoforte/rig#181). A fetch that fails keeps the
    // copy and says why.
    //
    // Answers what happened to each copy — `deleted`, `absent`, or why it was kept — and never
    // throws: a close has already torn the work down by now, and a branch left behind is a
    // thing to say, not a reason to fail.
    //
    // `remote: false` leaves the remote unasked and answers `absent` for it. That is the leftover
    // of a work closed on another machine: what happened on the remote was that close's to
    // decide, and a branch it chose to keep must not get a second chance from a machine nobody
    // asked.
    dropMerged ({ org, repo, branch, head, number, remote = true }) {
      const mirror = mirrorPath(org, repo)
      const out = { local: 'absent', remote: 'absent' }
      if (!fs.existsSync(mirror)) return out
      if (kept(mirror, branch)) {
        const fetch = git(mirror, 'cat-file', '-e', `${head}^{commit}`).code === 0 ? null
          : toRemote(mirror, 'fetch', '--quiet', 'origin', `refs/pull/${number}/head`)
        const reason = fetch && fetch.code !== 0 ? `could not fetch PR #${number}'s head: ${(fetch.err || fetch.out).split('\n')[0]}`
          : unlandedReason(mirror, local(branch), head, number)
        out.local = reason ? `kept — ${reason}`
          : git(mirror, 'branch', '-D', branch).code === 0 ? 'deleted'
          : 'kept — git would not delete it'
      }
      if (!remote) return out
      // A pattern matches a ref by its tail, so `a/refs/heads/<branch>` answers too: only the
      // line naming exactly this branch is its tip.
      const ls = toRemote(mirror, 'ls-remote', '--heads', 'origin', local(branch))
      const tip = ls.out.split('\n').map(line => line.trim().split(/\s+/)).find(([, name]) => name === local(branch))?.[0]
      if (ls.code !== 0) out.remote = `kept — the remote did not answer: ${(ls.err || ls.out).split('\n')[0]}`
      else if (tip) {
        const push = tip !== head ? null
          : toRemote(mirror, 'push', '--quiet', `--force-with-lease=${local(branch)}:${head}`, 'origin', '--delete', branch)
        out.remote = !push ? 'kept — it has moved since the PR merged'
          : push.code === 0 ? 'deleted'
          : `kept — the push was refused: ${(push.err || push.out).split('\n')[0]}`
        if (push?.code === 0) git(mirror, 'update-ref', '-d', ref(branch))
      }
      return out
    },

    // What a worktree's HEAD carries over its base, which is what a check run proves: the branch
    // checked out (null on a detached HEAD), the head, where it leaves the base (the merge-base
    // with the base's remote-tracking ref), and a patch-id for the diff between them. A rebase
    // that leaves the diff alone keeps the patch-id; one that changes it does not.
    //
    // The patch-id is a hash of the diff rather than `git patch-id`, which ignores whitespace:
    // indentation is code in Python and YAML, and `--verbatim`, which keeps it, needs a newer
    // git than rig does. The diff is `diff-tree`'s, plumbing, so no one's `diff.*` settings
    // shape it and two machines hash the same patch alike. What a rebase moves without changing
    // the diff is left out: the blob ids on `index` lines and the hunk headers, whose line
    // numbers and function context come from around the change. `--binary` puts a binary
    // file's content in it, and it is hashed byte for byte (`latin1` is one character a byte).
    // An empty diff answers ''. `error` when git could not say.
    patch ({ dir, base }) {
      const failed = (r, what) => ({ error: (r.err || r.out).split('\n')[0].trim() || `git could not read ${what} in ${dir}` })
      const head = git(dir, 'rev-parse', 'HEAD')
      if (head.code !== 0) return failed(head, 'HEAD')
      const from = git(dir, 'merge-base', ref(base), 'HEAD')
      if (from.code !== 0) return failed(from, `where HEAD leaves ${base}`)
      const diff = run('git', ['-C', dir, '-c', 'core.quotePath=false', 'diff-tree', '-p', '-r', '--binary', '--no-color', '--no-ext-diff', '--no-textconv', from.out, head.out],
        { maxBuffer: 1024 * 1024 * 1024, encoding: 'latin1' })
      if (diff.code !== 0) return failed(diff, 'the diff')
      const moved = diff.out.split('\n')
        .filter(line => !line.startsWith('index '))
        .map(line => (line.startsWith('@@ ') ? '@@' : line))
        .join('\n')
      return { branch: checkedOut(dir), head: head.out, base: from.out, patchId: diff.out ? createHash('sha1').update(moved, 'latin1').digest('hex') : '' }
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
    // `branch` is optional and answers three extra questions: has this branch reached the
    // remote, how much of what is checked out has not, and which branch is checked out?
    // `repoState` passes one.
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
      } else {
        const [behind, ahead] = counts.out.split(/\s+/).map(Number)
        s.behind = behind || 0
        s.ahead = ahead || 0
      }
      // `ahead` is not what is unpushed, for the reason `pushed` is not asked of `@{u}`: against
      // *main* it counts every commit that has not landed, pushed or not (hugoforte/rig#192).
      // This counts the commits on HEAD that no branch on the remote holds: the distance from
      // `origin/<branch>` once it is pushed, and while it never was, what it has over the remote
      // branch it was cut from. A count git could not make is a distance nobody could tell.
      if (branch) {
        const u = git(dir, 'rev-list', '--count', 'HEAD', '--not', '--remotes=origin')
        s.unpushed = u.code === 0 ? Number(u.out) : null
        if (u.code !== 0) s.distanceUnknown ??= (u.err || u.out).split('\n')[0].trim() || `git could not count what ${dir} has not pushed`
        // Null on a detached HEAD, and not always `branch` (`onLandedStage` in stages.mjs).
        s.on = checkedOut(dir)
        // A detached HEAD's own commits are on no branch, so removing the worktree loses them,
        // and a merged PR says nothing about them. Asked only when detached: on a branch, the
        // branch outlives the worktree. Null when git could not count them.
        if (s.on === null) {
          const d = git(dir, 'rev-list', '--count', 'HEAD', '--not', '--branches', '--remotes')
          s.unbranched = d.code === 0 ? Number(d.out) : null
        }
      }
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
      const r = toRemote(dir, 'checkout', '-b', branch, base)
      return r.code === 0 ? null : ((r.err || r.out).split('\n').find(Boolean) || '').trim()
    },

    // Where a branch is, as the mirror has it: `local`, the copy a worktree commits to, and
    // `remote`, the one last fetched. Each a sha, or null where there is no such copy. No fetch.
    tips ({ org, repo, branch }) {
      const mirror = mirrorPath(org, repo)
      const sha = r => {
        if (!fs.existsSync(mirror) || !has(mirror, r)) return null
        const out = git(mirror, 'rev-parse', '--verify', '--quiet', `${r}^{commit}`)
        return out.code === 0 ? out.out.trim() : null
      }
      return { local: sha(local(branch)), remote: sha(ref(branch)) }
    },

    // Whether every commit of `ancestor` is in `of`, both shas or refs the mirror knows.
    ancestor ({ org, repo, ancestor, of }) {
      return isAncestor(mirrorPath(org, repo), ancestor, of)
    },

    // An attempt's worktree: a new branch at `from`, a commit, in a new folder. `cut` makes the
    // work branch off the remote HEAD and `cutHere` a stage in a worktree that exists; this is the
    // third kind, a sibling of the branch it is an attempt at. Answers git's refusal, or null.
    cutAttempt ({ org, repo, branch, from, dest }) {
      const mirror = mirrorPath(org, repo)
      if (fs.existsSync(dest)) return `${dest} already exists`
      git(mirror, 'worktree', 'prune')
      step(`worktree ${path.basename(dest)} → ${branch}`)
      const r = run('git', ['-C', mirror, 'worktree', 'add', '-b', branch, dest, from], { env: NO_PROMPT_ENV })
      return r.code === 0 ? null : ((r.err || r.out).split('\n').find(Boolean) || '').trim()
    },

    // Move `branch` forward to `to`, never anywhere else. In `dir`, the worktree that has it
    // checked out, it is a fast-forward merge, which git refuses when it would not be one; with
    // no worktree on it, the ref is set, here only after the same question has been asked, which
    // also makes a branch that does not exist yet. Answers git's refusal, or null.
    fastForward ({ org, repo, branch, to, dir = null }) {
      const mirror = mirrorPath(org, repo)
      const firstLine = r => ((r.err || r.out).split('\n').find(Boolean) || '').trim()
      if (dir) {
        const r = git(dir, 'merge', '--ff-only', '--quiet', to)
        return r.code === 0 ? null : firstLine(r)
      }
      if (has(mirror, local(branch)) && !isAncestor(mirror, local(branch), to)) return `${branch} is not an ancestor of ${to.slice(0, 7)}`
      const r = git(mirror, 'branch', '--force', '--no-track', branch, to)
      return r.code === 0 ? null : firstLine(r)
    },

    // Delete the mirror's copy of a branch while it is still at `expect`: an attempt that lost is
    // discarded on purpose, which is what `--keep` and `--dropped` were told, but only as it was
    // when they looked. A commit made on it since is refused, and the branch kept. The remote is
    // never asked.
    deleteLocal ({ org, repo, branch, expect }) {
      const mirror = mirrorPath(org, repo)
      if (!has(mirror, local(branch))) return null
      // `update-ref` asks no worktree, so a branch some worktree still has checked out would be
      // deleted from under it, its HEAD left naming nothing.
      const at = this.worktreesOn({ org, repo }).get(branch)
      if (at) return `it is checked out in ${at}`
      const r = git(mirror, 'update-ref', '-d', local(branch), expect)
      return r.code === 0 ? null : `it has moved since ${expect.slice(0, 7)}`
    },

    // Which branch each of a mirror's worktrees has checked out, as a map from branch to folder.
    // A detached worktree has no branch and is left out; so is a worktree whose folder is gone.
    worktreesOn ({ org, repo }) {
      const mirror = mirrorPath(org, repo)
      const out = new Map()
      if (!fs.existsSync(mirror)) return out
      const r = git(mirror, 'worktree', 'list', '--porcelain')
      if (r.code !== 0) return out
      let dir = null
      for (const line of r.out.split('\n')) {
        if (line.startsWith('worktree ')) dir = line.slice('worktree '.length).trim()
        else if (line.startsWith('branch refs/heads/') && dir && fs.existsSync(dir)) out.set(line.slice('branch refs/heads/'.length).trim(), path.normalize(dir))
      }
      return out
    },

    // What a worktree's HEAD has of its own over the branches it was cut among: the commits no
    // copy of `others` holds, and the diff from where it left them. `others` are branch names;
    // the copies that exist, here or on the remote, are the ones asked about. `commits` is null,
    // with `error`, when git could not count.
    own ({ dir, others }) {
      const refs = others.flatMap(b => [local(b), ref(b)]).filter(r => has(dir, r))
      const counted = git(dir, 'rev-list', '--count', 'HEAD', '--not', ...refs)
      if (counted.code !== 0) return { commits: null, error: (counted.err || counted.out).split('\n')[0] }
      const commits = Number(counted.out)
      if (!commits) return { commits, files: 0, insertions: 0, deletions: 0 }
      // Where it left them: the parent of its oldest commit of its own, along the first parent.
      const mine = git(dir, 'rev-list', '--first-parent', 'HEAD', '--not', ...refs).out.split('\n').filter(Boolean)
      const from = git(dir, 'rev-parse', '--verify', '--quiet', `${mine.at(-1)}^`)
      const stat = git(dir, 'diff', '--shortstat', '--no-ext-diff', from.code === 0 ? from.out.trim() : mine.at(-1), 'HEAD').out
      const count = re => Number(re.exec(stat)?.[1] ?? 0)
      return { commits, files: count(/(\d+) files? changed/), insertions: count(/(\d+) insertions?/), deletions: count(/(\d+) deletions?/) }
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
    // of them asked for a network round trip to read the stack. `rig pr` fetches for itself,
    // once, just before it opens a pull request (`standing`). A branch cut in a worktree is already in the
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
