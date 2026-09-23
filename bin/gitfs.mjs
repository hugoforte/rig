// The questions rig asks git that its own files already answer, exactly.
//
// A git subprocess costs 55–65ms on Windows — `git --version`, which does nothing, is 55 of
// them — and the test suite makes some forty-eight hundred of them, of which `rev-parse
// --show-toplevel` alone is a fifth. That question is "walk up from here until something
// is a repository", which is a handful of `stat` calls: a thousandth of the price, for the
// same answer.
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
// `GIT_DISCOVERY_ACROSS_FILESYSTEM` is in the list for the opposite reason: without it git
// stops the walk at a filesystem boundary, which the walk below reproduces, and with it git
// does not.
export const MOVED_BY = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY',
  'GIT_CEILING_DIRECTORIES', 'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]

// git's `validate_headref`: a HEAD is a symbolic ref, or a raw object id — forty hex digits
// under SHA-1 and sixty-four under SHA-256. Checking it is what stops an empty directory
// called `.git` being read as a repository, which git walks straight past. Deliberately no
// stricter than git about what a symbolic ref may name: rejecting a HEAD git accepts would
// not hand the question back, it would walk on and answer for the checkout further up.
const VALID_HEAD = /^(ref:\s*\S|[0-9a-f]{40}(?:[0-9a-f]{24})?\s*$)/

const read = file => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
const statOf = p => { try { return fs.statSync(p) } catch { return null } }
const isDir = p => statOf(p)?.isDirectory() === true

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
  const head = read(path.join(dir, 'HEAD'))
  if (head === null || !VALID_HEAD.test(head)) return false
  const common = commonOf(dir)
  return isDir(path.join(common, 'objects')) && isDir(path.join(common, 'refs'))
}

// `.git` as a *file* holds `gitdir: <path>`, which a linked worktree writes absolute and a
// submodule writes relative to the file's own directory.
function gitFileTarget (file, dir) {
  const m = /^gitdir:\s*(.+)$/m.exec(read(file) ?? '')
  return m ? path.resolve(dir, m[1].trim()) : null
}

// The three settings that make this walk's answer *wrong* rather than merely missing.
// `core.worktree` puts the work tree somewhere no `.git` entry names — git reports that
// other directory as the toplevel, and the walk would report the one holding the file.
// `core.bare` on a discovered `.git` says there is no work tree at all. And a ref storage
// this module cannot read (`reftable`) leaves a placeholder in HEAD, so `headBranch` below
// would name a branch that does not exist.
//
// Read from the common config, plus the per-worktree one when `extensions.worktreeConfig`
// put a second file there. Conservative on purpose: the cost of handing a question back is
// one subprocess in a layout nobody here has, and the cost of getting it wrong is a wrong
// answer stated confidently.
function overridden (gitDir, commonDir, bareExpected) {
  const text = (read(path.join(commonDir, 'config')) ?? '') +
    '\n' + (read(path.join(gitDir, 'config.worktree')) ?? '')
  if (/^\s*worktree\s*=/mi.test(text)) return true
  if (/^\s*refstorage\s*=/mi.test(text)) return true
  return !bareExpected && /^\s*bare\s*=\s*(true|yes|on|1)\s*$/mi.test(text)
}

const NO_REPOSITORY = Object.freeze({ top: null, gitDir: null, commonDir: null })

// `discover` gives three answers, and a caller that only wants one of them should not have
// to know the shape to tell them apart: `null` is "ask git", a `gitDir` is "here it is", and
// neither is **"there is no repository here"** — a fact, not a shrug. Worth its own name
// because acting on the difference is the whole point: the shrug must fall through to git,
// and the fact is allowed to end the matter.
export const notARepository = place => place !== null && place.gitDir === null

// Where the repository containing `dir` is, answered the way git answers it: walk up, and
// at each level look at the directory itself before looking for a `.git` inside it. That
// order is not cosmetic — a bare repository sitting inside somebody's checkout answers for
// itself, and rig's own mirrors are bare repositories under a work root — so checking
// `.git` first would report the enclosing checkout as the toplevel of a mirror.
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
// The one case this answers and git refuses is a repository owned by another user, which
// git stops on for `safe.directory`. Nothing is done about it because nothing can be: a
// machine where git refuses to read rig's own checkouts has no working rig to protect.
export function discover (start, env = process.env) {
  for (const name of MOVED_BY) if (env[name] !== undefined) return null
  let dir
  try { dir = fs.realpathSync.native(path.resolve(start)) } catch { return null }
  // git records the starting directory's device and stops when the walk leaves it, so that
  // a repository on the far side of a mount point is not claimed to own what is under it.
  const device = statOf(dir)?.dev ?? null

  for (;;) {
    if (isGitDir(dir)) {
      const common = commonOf(dir)
      return overridden(dir, common, true) ? null : { top: null, gitDir: dir, commonDir: common }
    }
    const entry = path.join(dir, '.git')
    const found = statOf(entry)
    if (found) {
      // A `.git` file naming a directory that is not a repository is where git stops and
      // says so, rather than carrying on up — so a broken submodule inside a checkout is
      // not silently answered for by the checkout around it.
      const gitDir = found.isDirectory() ? entry : gitFileTarget(entry, dir)
      if (!gitDir) return NO_REPOSITORY
      if (isGitDir(gitDir)) {
        const common = commonOf(gitDir)
        return overridden(gitDir, common, false) ? null : { top: dir, gitDir, commonDir: common }
      }
      // A `.git` *directory* that is not a repository is not a repository at all, and git
      // keeps walking; only the file form is fatal.
      if (!found.isDirectory()) return NO_REPOSITORY
    }
    const up = path.dirname(dir)
    if (up === dir) return NO_REPOSITORY
    if ((statOf(up)?.dev ?? null) !== device) return NO_REPOSITORY
    dir = up
  }
}

// The branch a git dir's HEAD names, and null when it names no branch — a detached HEAD, an
// unreadable HEAD, or a HEAD pointing outside `refs/heads/`. Exact for every case rig
// creates, and it differs from `symbolic-ref --short HEAD` in two places worth naming,
// because in both of them `--short` was answering a question rig was not asking.
//
// `--short` abbreviates for *display*, and abbreviates less when the short form would be
// ambiguous: on a branch `rel` in a repository that also has a tag `rel`, it prints
// `heads/rel` — which rig would then compare against a default branch, put in a message and
// stamp into the freshness cache as the name of a branch. The ref is what rig wants, and
// the ref says `rel`.
//
// A HEAD pointing at, say, `refs/other/thing` is the other one: `--short` prints
// `other/thing`, and that is not a branch. Null is what rig's readers already handle, and
// it is what they should do with it — `fastForward` calls it detached and declines to move
// anything, which is the right answer for a head that is not on a branch.
export function headBranch (gitDir) {
  const m = /^ref:\s*refs\/heads\/(.+)$/m.exec(read(path.join(gitDir, 'HEAD')) ?? '')
  return m ? m[1].trim() : null
}
