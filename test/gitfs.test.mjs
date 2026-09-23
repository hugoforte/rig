// The filesystem's answers, checked against git's own, on real repositories. Every test
// here asks git the question it is replacing and asserts the two agree — a module that
// claims to say what git says is only worth having if something makes it prove that, and
// the failures it exists to prevent are all cases nobody would think to hard-code: a bare
// repository inside a checkout, a `.git` file naming a directory that has gone, an empty
// directory called `.git` that git walks straight past.
//
// One temp tree, shared, with every shape made in `before` so no test depends on another
// having run — `--test-name-pattern` has to work.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discover, headBranch, MOVED_BY, notARepository } from '../bin/gitfs.mjs'

let tmp, env
const git = (dir, ...args) => {
  const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
  if (r.error) throw r.error
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
}
const gitMust = (dir, ...args) => {
  const r = git(dir, ...args)
  assert.equal(r.code, 0, `git ${args.join(' ')}: ${r.err || r.out}`)
  return r.out
}
const mk = p => { fs.mkdirSync(p, { recursive: true }); return p }
const real = p => fs.realpathSync.native(p).toLowerCase()
const same = (a, b) => real(a) === real(b)

// git prints forward slashes on Windows and this module prints the platform's own, so the
// two are compared as directories rather than as strings — which is how `sameDir` already
// compares them everywhere else in the tool.
function agreesWithGit (dir, what) {
  const place = discover(dir, env)
  assert.notEqual(place, null, `${what}: gitfs handed the question back`)
  const top = git(dir, 'rev-parse', '--show-toplevel')
  if (top.code === 0) assert.ok(same(place.top, top.out), `${what}: top ${place.top} vs ${top.out}`)
  else assert.equal(place.top, null, `${what}: git has no work tree here, gitfs found ${place.top}`)
  const gitDir = git(dir, 'rev-parse', '--absolute-git-dir')
  if (gitDir.code === 0) {
    assert.ok(same(place.gitDir, gitDir.out), `${what}: git dir ${place.gitDir} vs ${gitDir.out}`)
    const common = gitMust(dir, 'rev-parse', '--git-common-dir')
    assert.ok(same(place.commonDir, path.resolve(dir, common)), `${what}: common dir ${place.commonDir} vs ${common}`)
  } else {
    assert.equal(place.gitDir, null, `${what}: git found no repository, gitfs found ${place.gitDir}`)
  }
  return place
}

// A checkout with one commit on `main`.
const seeded = name => {
  const dir = mk(path.join(tmp, name))
  gitMust(dir, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(dir, 'README.md'), `# ${name}\n`)
  gitMust(dir, 'add', '-A')
  gitMust(dir, 'commit', '-q', '-m', 'first')
  return dir
}

let own, bare, outside

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-gitfs-'))
  env = { ...process.env }
  // Any of these in the runner's own environment is a question for git, and every test here
  // would be handed it back rather than answered.
  for (const name of MOVED_BY) delete env[name]
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  Object.assign(env, { GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig gitfs'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'gitfs@example.invalid'
  own = seeded('own')
  bare = mk(path.join(tmp, 'bare.git'))
  assert.equal(spawnSync('git', ['init', '-q', '--bare', bare], { encoding: 'utf8', env }).status, 0)
  outside = mk(path.join(tmp, 'not-a-repo', 'deeper'))
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

test('a checkout answers its own root, and so does a directory inside it', () => {
  const place = agreesWithGit(own, 'a checkout')
  assert.ok(same(place.gitDir, path.join(own, '.git')))
  assert.ok(same(agreesWithGit(mk(path.join(own, 'a', 'b')), 'a directory inside it').top, own))
})

test('a linked worktree keeps its own git dir and the main checkout\'s common dir', () => {
  // The one shape where the two differ, and the only thing `identify` reads them for: a rig
  // running from a linked worktree is one whose freshness check must not fire.
  const linked = path.join(tmp, 'linked')
  gitMust(own, 'worktree', 'add', '-q', '-b', 'side', linked)
  const place = agreesWithGit(linked, 'a linked worktree')
  assert.ok(!same(place.gitDir, place.commonDir), 'a linked worktree is told apart by these two')
  assert.ok(same(place.commonDir, path.join(own, '.git')))
  assert.ok(same(agreesWithGit(mk(path.join(linked, 'deep')), 'inside a linked worktree').top, linked))
})

test('a bare repository has no work tree, and one inside a checkout still answers for itself', () => {
  // rig's mirrors are bare repositories under a work root. A mirror has no `.git`, so the
  // walk reaches it before the checkout above it — and answering with that checkout would
  // be a wrong answer rather than a missing one.
  assert.equal(agreesWithGit(bare, 'a bare repository').top, null)
  const inside = mk(path.join(own, 'inner.git'))
  assert.equal(spawnSync('git', ['init', '-q', '--bare', inside], { encoding: 'utf8', env }).status, 0)
  const place = agreesWithGit(inside, 'a bare repository inside a checkout')
  assert.equal(place.top, null, 'the checkout around it is not its work tree')
  assert.ok(same(place.gitDir, inside))
})

test('a checkout whose root is also shaped like a bare repository is still a checkout', () => {
  // The one shape that tells the order of git's two looks apart: a stray `git init --bare .`
  // in a checkout's root leaves `HEAD`, `objects` and `refs` beside its `.git`, and git finds
  // the `.git` before it asks whether the directory is itself a repository.
  const stray = seeded('stray-bare')
  gitMust(stray, 'init', '-q', '--bare', '.')
  assert.ok(same(agreesWithGit(stray, 'a checkout with a bare repository in its root').top, stray))
  assert.ok(same(agreesWithGit(mk(path.join(stray, 'sub')), 'a directory inside it').top, stray))
})

test('a directory that is no repository is said to be one, without a repository above it', () => {
  assert.deepEqual(discover(outside, env), { top: null, gitDir: null, commonDir: null })
  assert.equal(git(outside, 'rev-parse', '--show-toplevel').code !== 0, true, 'git agrees, at the price of a subprocess')
})

test('a `.git` file names the repository, and the directory holding it is the work tree', () => {
  // What a submodule and `git init --separate-git-dir` both leave behind, and the relative
  // form is the one a submodule writes.
  const moved = seeded('moved')
  const store = path.join(tmp, 'moved-store')
  fs.renameSync(path.join(moved, '.git'), store)
  fs.writeFileSync(path.join(moved, '.git'), 'gitdir: ../moved-store\n')
  const place = agreesWithGit(moved, 'a .git file')
  assert.ok(same(place.top, moved))
  assert.ok(same(place.gitDir, store))
  assert.ok(same(agreesWithGit(mk(path.join(moved, 'sub')), 'inside a .git file checkout').top, moved))
})

test('a `.git` file naming nothing stops the walk, the way it stops git', () => {
  // Inside a real checkout, so the failure being pinned is the tempting one: carrying on up
  // and answering with the checkout around it, which git does not do.
  const broken = mk(path.join(own, 'broken'))
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: ../nowhere-at-all\n')
  assert.deepEqual(discover(broken, env), { top: null, gitDir: null, commonDir: null })
  assert.notEqual(git(broken, 'rev-parse', '--show-toplevel').code, 0, 'git stops here too')
})

test('a `.git` file is read as strictly as git reads it', () => {
  // `gitdir: ` exactly, at the very start, with nothing after the path but the line ending.
  // Every one of these names a real repository, and git refuses all of them.
  const loose = mk(path.join(own, 'loose'))
  const store = path.join(tmp, 'loose-store').replace(/\\/g, '/')
  gitMust(loose, 'init', '-q', '--separate-git-dir', store)
  assert.ok(same(agreesWithGit(loose, 'the file git wrote').top, loose))
  // Removed rather than overwritten: git marks it hidden on Windows, which refuses a rewrite.
  fs.rmSync(path.join(loose, '.git'))
  for (const text of [`gitdir:${store}\n`, `gitdir:  ${store}\n`, `# a note\ngitdir: ${store}\n`,
    `gitdir: ${store}\nand more\n`, `gitdir: ${store} \n`]) {
    fs.writeFileSync(path.join(loose, '.git'), text)
    assert.equal(agreesWithGit(loose, JSON.stringify(text)).top, null)
  }
})

test('a `.git` that is neither a file nor a directory is walked past, the way git walks past it', {
  skip: process.platform === 'win32' && 'Windows has no FIFOs',
}, () => {
  // Reading one would block until something wrote to it; git only stats it and moves on.
  const piped = mk(path.join(own, 'piped'))
  assert.equal(spawnSync('mkfifo', [path.join(piped, '.git')]).status, 0)
  assert.ok(same(agreesWithGit(piped, 'a FIFO called .git').top, own))
})

test('an empty directory called `.git` is walked past, the way git walks past it', () => {
  const child = mk(path.join(own, 'child'))
  mk(path.join(child, '.git'))
  assert.ok(same(agreesWithGit(child, 'an empty .git directory').top, own))
})

test('a HEAD is judged the way git judges it, neither stricter nor looser', () => {
  // Stricter walks past a checkout git answers for and names the one around it; looser
  // answers for a directory git walks past. git wants `ref:` naming something under
  // `refs/`, or an object id's first forty hex digits in either case, and reads no further.
  const inner = mk(path.join(own, 'judged'))
  gitMust(inner, 'init', '-q', '-b', 'main')
  gitMust(inner, 'commit', '-q', '--allow-empty', '-m', 'first')
  const sha = gitMust(inner, 'rev-parse', 'HEAD')
  for (const head of [sha.toUpperCase(), `${sha} and more\n`, 'ref: main\n']) {
    fs.writeFileSync(path.join(inner, '.git', 'HEAD'), head)
    agreesWithGit(inner, `a HEAD of ${JSON.stringify(head)}`)
  }
  const shaped = mk(path.join(own, 'shaped'))
  mk(path.join(shaped, 'objects'))
  mk(path.join(shaped, 'refs'))
  fs.writeFileSync(path.join(shaped, 'HEAD'), 'ref: main\n')
  assert.ok(same(agreesWithGit(shaped, 'a would-be bare repository git rejects').top, own))
})

test('a HEAD that is a symbolic link names the ref it links to, the way git reads it', t => {
  // `core.preferSymlinkRefs` writes one. git reads the link rather than following it — an
  // unborn branch's points at nothing yet — and a link outside `refs/` is no HEAD at all.
  const inner = mk(path.join(own, 'linked-head'))
  gitMust(inner, 'init', '-q', '-b', 'main')
  const head = path.join(inner, '.git', 'HEAD')
  fs.rmSync(head)
  try { fs.symlinkSync('refs/heads/unborn', head) } catch (e) {
    if (e.code === 'EPERM') return t.skip('this machine will not make a symbolic link')
    throw e
  }
  assert.ok(same(agreesWithGit(inner, 'a HEAD linked to an unborn branch').top, inner))
  assert.equal(headBranch(discover(inner, env).gitDir), git(inner, 'symbolic-ref', '-q', '--short', 'HEAD').out)
  fs.rmSync(head)
  fs.symlinkSync('../elsewhere', head)
  assert.ok(same(agreesWithGit(inner, 'a HEAD linked outside refs/').top, own))
})

test('a work tree git has been told to look elsewhere for is handed back to git', () => {
  // `core.worktree` is the setting that makes the walk's answer wrong rather than missing:
  // git reports a directory no `.git` entry names. Null is this module saying so.
  const held = seeded('held')
  const store = path.join(tmp, 'held-store')
  const elsewhere = mk(path.join(tmp, 'held-tree'))
  fs.renameSync(path.join(held, '.git'), store)
  fs.writeFileSync(path.join(held, '.git'), `gitdir: ${store.replace(/\\/g, '/')}\n`)
  gitMust(store, 'config', 'core.worktree', elsewhere.replace(/\\/g, '/'))
  assert.ok(same(git(held, 'rev-parse', '--show-toplevel').out, elsewhere), 'git answers the other directory')
  assert.equal(discover(held, env), null, 'and this module declines rather than answering the wrong one')
})

test('a setting that shares its section header\'s line is still read, the way git reads it', () => {
  const headed = seeded('headed')
  const elsewhere = mk(path.join(tmp, 'headed-tree'))
  fs.appendFileSync(path.join(headed, '.git', 'config'), `[core] worktree = ${elsewhere.replace(/\\/g, '/')}\n`)
  assert.ok(same(git(headed, 'rev-parse', '--show-toplevel').out, elsewhere), 'git answers the other directory')
  assert.equal(discover(headed, env), null)
})

test('`core.bare` is handed back however it is spelled, unless it is plainly false', () => {
  // git takes a key on its section header's line, a key with no value as true, a trailing
  // comment, a quoted value and any number but nought. git writes none of them itself, and
  // each of them leaves a checkout with no work tree.
  const spelled = seeded('spelled')
  const config = path.join(spelled, '.git', 'config')
  const unset = fs.readFileSync(config, 'utf8').replace(/^[ \t]*bare = false\r?\n/m, '')
  for (const bare of ['[core] bare = true', '[core]\n\tbare', '[core]\n\tbare = true # a note',
    '[core]\n\tbare = "true"', '[core]\n\tbare = 2']) {
    fs.writeFileSync(config, `${unset}${bare}\n`)
    assert.notEqual(git(spelled, 'rev-parse', '--show-toplevel').code, 0, `git reads ${JSON.stringify(bare)} as bare`)
    assert.equal(discover(spelled, env), null, `${JSON.stringify(bare)} is handed back`)
  }
  fs.writeFileSync(config, `${unset}[core]\n\tbare = false\n`)
  assert.ok(same(agreesWithGit(spelled, 'bare = false').top, spelled))
})

test('GIT_DIR in the environment is git\'s question, and is handed back unanswered', () => {
  assert.equal(discover(own, { ...env, GIT_DIR: path.join(bare) }), null)
  assert.equal(discover(own, { ...env, GIT_CEILING_DIRECTORIES: tmp }), null)
  assert.equal(discover(own, { ...env, GIT_DIR: '' }), null, 'set and empty is still set, and git refuses it')
  assert.notEqual(discover(own, env), null, 'and an ordinary environment is still answered')
})

test('a shrug is never read as a no, which is the distinction callers act on', () => {
  // `notARepository` is what lets a caller stop early, so the one thing it must never do is
  // say "no repository" when the real answer was "ask git". The freshness epilogue ends the
  // whole check on a true here; reading a handed-back question as a fact would switch
  // freshness off for good on any machine that sets `GIT_DIR`.
  assert.equal(notARepository(discover(outside, env)), true, 'a directory that is no repository')
  assert.equal(notARepository(discover(own, env)), false, 'a checkout')
  assert.equal(notARepository(discover(bare, env)), false, 'a bare repository, which has a git dir and no work tree')
  assert.equal(notARepository(discover(own, { ...env, GIT_DIR: bare })), false,
    'and a question handed back to git, which is the one that would be a bug')
})

test('the branch is the ref HEAD names, and a detached HEAD is no branch', () => {
  assert.equal(headBranch(discover(own, env).gitDir), git(own, 'symbolic-ref', '-q', '--short', 'HEAD').out)
  const loose = seeded('loose')
  gitMust(loose, 'checkout', '-q', '--detach', 'HEAD')
  assert.equal(headBranch(discover(loose, env).gitDir), null)
  assert.notEqual(git(loose, 'symbolic-ref', '-q', '--short', 'HEAD').code, 0, 'git says the same by failing')
})

test('an unborn HEAD is still the branch it will be', () => {
  const fresh = mk(path.join(tmp, 'unborn'))
  gitMust(fresh, 'init', '-q', '-b', 'main')
  assert.equal(headBranch(discover(fresh, env).gitDir), 'main')
  assert.equal(git(fresh, 'symbolic-ref', '-q', '--short', 'HEAD').out, 'main')
})

test('a branch whose name a tag also carries is still named by its ref', () => {
  // The one place this deliberately differs from `symbolic-ref --short`, which abbreviates
  // for display and abbreviates less when the short form would be ambiguous. rig puts this
  // value in messages, compares it with a default branch and caches it as a branch name, so
  // `heads/rel` would be a branch name that names no branch.
  const both = seeded('both')
  gitMust(both, 'checkout', '-q', '-b', 'rel')
  gitMust(both, 'tag', 'rel')
  assert.equal(git(both, 'symbolic-ref', '-q', '--short', 'HEAD').out, 'heads/rel')
  assert.equal(headBranch(discover(both, env).gitDir), 'rel')
})

test('a branch name with slashes in it survives, since rig writes nothing else', () => {
  const sliced = seeded('sliced')
  gitMust(sliced, 'checkout', '-q', '-b', 'feat/PROJ-42-refunds')
  assert.equal(headBranch(discover(sliced, env).gitDir), 'feat/PROJ-42-refunds')
})

test('a HEAD pointing outside refs/heads is no branch, whatever `--short` would print', () => {
  // `--short` prints `other/thing`, which is not a branch and would be read as one. Null is
  // what every caller already does the right thing with: `fastForward` declines to move it.
  const odd = seeded('odd')
  gitMust(odd, 'update-ref', 'refs/other/thing', 'HEAD')
  gitMust(odd, 'symbolic-ref', 'HEAD', 'refs/other/thing')
  assert.equal(git(odd, 'symbolic-ref', '-q', '--short', 'HEAD').out, 'other/thing')
  assert.equal(headBranch(discover(odd, env).gitDir), null)
})
