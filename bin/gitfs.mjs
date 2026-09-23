// The questions rig asks git that its own files already answer, exactly.
//
// A git subprocess costs 55–65ms on Windows — `git --version`, which does nothing, is 55 of
// them — and before this module the test suite made some forty-eight hundred of them, of
// which `rev-parse --show-toplevel` alone was a fifth. That question is "walk up from here
// until something is a repository", which is a handful of `stat` calls: a thousandth of the
// price, for the same answer.
//
// **The same answer, or none.** Everything here is either what git would have said or
// `null`, and `null` means nobody could tell and the caller should go and ask. A guess
// worded as a fact is the worst outcome this codebase has a rule about, and a fast wrong
// toplevel would put a work's records in the wrong data root — so the layouts this cannot
// commit to (`core.worktree`, a ref storage it cannot read, `GIT_DIR` in the environment)
// are named, and each of them hands the question back.
//
// Nothing here spawns anything, which is why there is no injected runner: the seam that
// `worktrees.mjs` and `checkouts.mjs` both take is a seam around a subprocess, and this
// module's whole point is that there isn't one. Its tests stand up real repositories with
// real git and compare, which is `checkouts.test.mjs`'s precedent for the same reason —
// faster to read and harder to fool than a fake.
import fs from 'node:fs'
import path from 'node:path'

// Environment variables that move git's idea of where the repository is. One of these set —
// even to nothing, which git still reads as set — means git is answering a different
// question from the one the filesystem was asked, and reproducing each of them here would be
// a second implementation of the part of git most likely to change.
// `GIT_DISCOVERY_ACROSS_FILESYSTEM` is in the list for the opposite reason: without it POSIX
// git stops the walk at a filesystem boundary, which the walk below reproduces there, and
// with it git does not.
export const MOVED_BY = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]

// git's `validate_headref`: a HEAD is `ref:` naming something under `refs/`, or starts with
// forty hex digits in either case — which a SHA-256 id also does — and git reads nothing
// after them. Checking it is what stops an empty directory called `.git` being read as a
// repository, which git walks straight past. It is git's test exactly, because a mistake
// either way is a wrong answer rather than a missing one: rejecting a HEAD git accepts walks
// on and answers for the checkout further up, and accepting one git rejects answers for a
// directory git walks past.
const VALID_HEAD = /^(?:ref:[ \t\n\r]*refs\/|[0-9a-fA-F]{40})/

const read = file => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
const statOf = p => { try { return fs.statSync(p) } catch { return null } }
const isDir = p => statOf(p)?.isDirectory() === true

// HEAD as git reads it. `core.preferSymlinkRefs` makes it a symbolic link rather than a
// file, and git takes a link into `refs/` as the ref it names without following it — an
// unborn branch's link points at nothing yet — and a link anywhere else as no HEAD at all.
// Node reads the link back in this platform's separators, and git compares it in `/`.
function headOf (gitDir) {
  const file = path.join(gitDir, 'HEAD')
  let link
  try { link = fs.readlinkSync(file) } catch { return read(file) }
  link = link.split(path.sep).join('/')
  return link.startsWith('refs/') ? `ref: ${link}` : null
}

// A linked worktree's git dir holds a `commondir` pointing at the main checkout's, which is
// where the objects and the refs actually live. git resolves it before it decides whether a
// directory is a repository at all, and so must this: the administrative directory
// `git worktree add` creates has neither `objects` nor `refs` of its own.
const commonOf = gitDir => {
  const text = read(path.join(gitDir, 'commondir'))
  return text === null ? gitDir : path.resolve(gitDir, text.trim())
}

// git's `is_git_directory`, which is the test that makes a directory a repository rather
// than a directory with a suggestive name.
function isGitDir (dir) {
  const head = headOf(dir)
  if (head === null || !VALID_HEAD.test(head)) return false
  const common = commonOf(dir)
  return isDir(path.join(common, 'objects')) && isDir(path.join(common, 'refs'))
}

// `.git` as a *file* holds `gitdir: <path>`, which a linked worktree writes absolute and a
// submodule writes relative to the file's own directory. Read as git's `read_gitfile_gently`
// reads it — `gitdir: ` exactly, at the very start, and the rest bar the line ending is the
// path — so a file git refuses names nothing here either.
function gitFileTarget (file, dir) {
  const m = /^gitdir: (.+?)[\r\n]*$/.exec(read(file) ?? '')
  return m ? path.resolve(dir, m[1]) : null
}

// The settings that make this walk's answer *wrong* rather than merely missing.
// `core.worktree` puts the work tree somewhere no `.git` entry names — git reports that
// other directory as the toplevel, and the walk would report the one holding the file.
// `core.bare` on a discovered `.git` says there is no work tree at all. And a repository
// format past the plain one is git's to read: a `repositoryformatversion` past 1, or an
// extension it does not know, is a repository git refuses to open, and the extensions it
// does know change what this reads — a ref storage that is not files leaves a placeholder in
// HEAD, a per-worktree config file adds settings. So any `[extensions]` section at all hands
// the question back, rather than being told apart.
//
// Read from the common config, for every way git's grammar lets a key be written, not only
// the way git writes one: after any number of section headers on its line, with no value,
// with a comment after it, in any section. Anything short of a plain `bare = false` counts as
// bare. The per-worktree `config.worktree` is not read, because git reads it only when
// `extensions.worktreeConfig` is on, and that is already handed back.
//
// Conservative on purpose, and not cheap: every worktree rig makes is a linked worktree of a
// `git clone --bare` mirror, whose common config says `bare = true`. git ignores that for a
// linked worktree, and this reads it all the same, so rig's own commonest layout is handed
// back to git and paid for in subprocesses. The cost of getting it wrong is a wrong answer
// stated confidently.
function overridden (commonDir, bareExpected) {
  const text = read(path.join(commonDir, 'config')) ?? ''
  if (/\[\s*extensions\s*\]/i.test(text)) return true
  const lines = text.split('\n').map(line => line.replace(/^\s*(?:\[[^\]]*\]\s*)*/, '').trim())
  if (lines.some(line => /^worktree\b/i.test(line))) return true
  if (lines.some(line => /^repositoryformatversion\b/i.test(line) && !/^repositoryformatversion\s*=\s*[01]$/i.test(line))) return true
  return !bareExpected &&
    lines.some(line => /^bare\b/i.test(line) && !/^bare\s*=\s*(false|no|off|0)$/i.test(line))
}

const NO_REPOSITORY = Object.freeze({ top: null, gitDir: null, commonDir: null })

// `discover` gives three answers, and a caller that only wants one of them should not have
// to know the shape to tell them apart: `null` is "ask git", a `gitDir` is "here it is", and
// neither is **"there is no repository here"** — a fact, not a shrug. Worth its own name
// because acting on the difference is the whole point: the shrug must fall through to git,
// and the fact is allowed to end the matter.
export const notARepository = place => place !== null && place.gitDir === null

// Where the repository containing `dir` is, answered the way git answers it: walk up, and
// at each level look for a `.git` inside the directory before asking whether the directory
// is itself a bare repository. That order is not cosmetic — a stray `git init --bare .` in
// a checkout's root leaves a directory that is both, and git calls it a checkout. A bare
// repository inside somebody's checkout still answers for itself, which matters because
// rig's own mirrors are bare repositories under a work root: a mirror has no `.git`, and
// the walk reaches it before it reaches the checkout around it.
//
//   null                       nobody could tell; ask git, whose answer is the only one
//   { top: null, gitDir: null} no repository above this directory — `fatal: not a git
//                              repository`, which is what every caller reads a failure as
//   { top: null, gitDir }      a repository with no work tree; `--show-toplevel` is fatal
//                              here too, and `--absolute-git-dir` still answers
//   { top, gitDir, commonDir}  a work tree, `top` its root
//
// Paths come back absolute and in this platform's own separators, where git prints forward
// slashes on Windows. Every reader of them either compares with `sameDir`, which resolves
// both sides, or prints them for a person, for whom the native form is the better one.
//
// Two of git's refusals are placed all the same, because what decides them is not in the
// repository: one owned by another user, which git refuses for `safe.directory`, and a bare
// repository found by walking, which `safe.bareRepository=explicit` refuses. Both are read
// from the global config, which this never reads. Either is placed where git would have
// placed it had it agreed to look, and a caller that goes on to ask git anything gets git's
// refusal then, in git's words; `repoAtCwd`, which would otherwise name a repository from the
// placement alone, asks git first.
export function discover (start, env = process.env) {
  for (const name of MOVED_BY) if (env[name] !== undefined) return null
  let dir
  try { dir = fs.realpathSync.native(path.resolve(start)) } catch { return null }
  // POSIX git records the starting directory's device and stops when the walk leaves it, so
  // that a repository on the far side of a mount point is not claimed to own what is under
  // it, and so does this. Git for Windows makes the same comparison with an `st_dev` that is
  // always zero, so it never stops, and Node's `dev` there is a volume's serial on some paths
  // and zero on others — so on Windows leaving the starting device hands the question back.
  const device = statOf(dir)?.dev ?? null

  for (;;) {
    const entry = path.join(dir, '.git')
    const found = statOf(entry)
    // A `.git` that is neither a file nor a directory — a FIFO, a socket, a device — git
    // stats and walks past without opening, which is as well: a FIFO would never answer.
    if (found?.isFile() || found?.isDirectory()) {
      // A `.git` file naming a directory that is not a repository is where git stops and
      // says so, rather than carrying on up — so a broken submodule inside a checkout is
      // not silently answered for by the checkout around it.
      const gitDir = found.isDirectory() ? entry : gitFileTarget(entry, dir)
      if (!gitDir) return NO_REPOSITORY
      if (isGitDir(gitDir)) {
        const common = commonOf(gitDir)
        return overridden(common, false) ? null : { top: dir, gitDir, commonDir: common }
      }
      // A `.git` *directory* that is not a repository is not a repository at all, and git
      // keeps walking; only the file form is fatal.
      if (!found.isDirectory()) return NO_REPOSITORY
    }
    if (isGitDir(dir)) {
      const common = commonOf(dir)
      return overridden(common, true) ? null : { top: null, gitDir: dir, commonDir: common }
    }
    const up = path.dirname(dir)
    if (up === dir) return NO_REPOSITORY
    if ((statOf(up)?.dev ?? null) !== device) return process.platform === 'win32' ? null : NO_REPOSITORY
    dir = up
  }
}

// The branch a git dir's HEAD names, and null when it names no branch — a detached HEAD, an
// unreadable HEAD, or a HEAD pointing outside `refs/heads/`. It differs from
// `symbolic-ref --short HEAD` in two places, and in both `--short` was answering a question
// rig was not asking.
//
// `--short` abbreviates for *display*, and abbreviates less when the short form would be
// ambiguous: on a branch `rel` in a repository that also has a tag `rel`, it prints
// `heads/rel` — which rig would then compare against a default branch, put in a message and
// stamp into the freshness cache as the name of a branch. The ref is what rig wants, and
// the ref says `rel`.
//
// A HEAD pointing at, say, `refs/other/thing` is the second: `--short` prints
// `other/thing`, and that is not a branch. Null is what rig's readers already handle, and
// it is what they should do with it — `fastForward` calls it detached and declines to move
// anything, which is the right answer for a head that is not on a branch.
//
// A branch that is itself a symbolic ref — the alias a rename from `master` to `main` can
// leave behind, HEAD naming `refs/heads/master` and that naming `refs/heads/main` — is
// followed the way git follows it, to `main`. A symbolic ref is only ever a loose file, and a
// ref storage that is not files has already been handed back, so the loose file in the common
// directory is the whole of the reading. git gives up after five links, and so does this.
//
// A HEAD that starts with a sha is detached whatever follows it, because git reads the sha
// and nothing after it.
export function headBranch (gitDir) {
  const common = commonOf(gitDir)
  let text = headOf(gitDir)
  for (let links = 0; links <= 5; links++) {
    const m = /^ref:\s*refs\/heads\/(.+?)\s*$/.exec(text ?? '')
    if (!m) return null
    const next = read(path.join(common, 'refs', 'heads', m[1]))
    if (next === null || !next.startsWith('ref:')) return m[1]
    text = next
  }
  return null
}
