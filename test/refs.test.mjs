// A ref read from git's own files, checked against git's own answer on real repositories,
// the way test/gitfs.test.mjs checks the walk. Every case here is one where a reader that
// was nearly right would answer with a real sha that is wrong — a packed line under a newer
// loose file, a peeled tag, a ref packed between two reads — so every test asks git the same
// question and asserts the two agree, or that the reader handed the question back.
//
// One temp tree, shared, with every shape made in `before` so no test depends on another
// having run — `--test-name-pattern` has to work.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { discover, MOVED_BY, noSuchRef, refSha, symref } from '../bin/gitfs.mjs'

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
const commit = (dir, message) => {
  fs.appendFileSync(path.join(dir, 'README.md'), `${message}\n`)
  gitMust(dir, 'add', '-A')
  gitMust(dir, 'commit', '-q', '-m', message)
  return gitMust(dir, 'rev-parse', 'HEAD')
}
const place = dir => {
  const p = discover(dir, env)
  assert.notEqual(p, null, `${dir}: gitfs handed the question back`)
  return p
}

// What `rev-parse --verify -q` says, in the reader's own shape: the sha, or no such ref.
const gitSha = (dir, ref) => {
  const r = git(dir, 'rev-parse', '--verify', '-q', ref)
  return r.code === 0 ? { sha: r.out } : { sha: null }
}
// What `symbolic-ref` says: the target, or not a symbolic ref.
const gitSymref = (dir, ref) => {
  const r = git(dir, 'symbolic-ref', ref)
  return r.code === 0 ? { target: r.out } : { target: null }
}
const agreesOnSha = (dir, ref, what = ref) => {
  const ours = refSha(place(dir), ref)
  assert.notEqual(ours, null, `${what}: the reader handed the question back`)
  assert.deepEqual(ours, gitSha(dir, ref), what)
  return ours
}
const agreesOnSymref = (dir, ref, what = ref) => {
  const ours = symref(place(dir), ref)
  assert.notEqual(ours, null, `${what}: the reader handed the question back`)
  assert.deepEqual(ours, gitSymref(dir, ref), what)
  return ours
}

// A checkout with one commit on `main`.
const seeded = name => {
  const dir = mk(path.join(tmp, name))
  gitMust(dir, 'init', '-q', '-b', 'main')
  commit(dir, `# ${name}`)
  return dir
}

let own, mirror, unborn, detached, linked, chained

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-refs-'))
  env = { ...process.env }
  for (const name of MOVED_BY) delete env[name]
  fs.writeFileSync(path.join(tmp, 'gitconfig'), '')
  Object.assign(env, { GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' })
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig refs'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'refs@example.invalid'

  // A checkout with a branch, an annotated tag, and a symref alias the way a rename from
  // `master` leaves one.
  own = seeded('own')
  gitMust(own, 'branch', 'side')
  gitMust(own, 'tag', '-a', '-m', 'the tag', 'v1')
  gitMust(own, 'symbolic-ref', 'refs/heads/alias', 'refs/heads/main')

  // The mirror rig makes: a bare clone with the fetch refspec rig gives it, fetched once.
  // `clone --bare` writes its refs packed; `fetch` writes the remote-tracking ones loose.
  mirror = path.join(tmp, 'mirror.git')
  assert.equal(spawnSync('git', ['clone', '-q', '--bare', own, mirror], { encoding: 'utf8', env }).status, 0)
  gitMust(mirror, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*')
  gitMust(mirror, 'fetch', '-q', '--prune', 'origin')
  gitMust(mirror, 'remote', 'set-head', 'origin', '-a')

  unborn = mk(path.join(tmp, 'unborn'))
  gitMust(unborn, 'init', '-q', '-b', 'main')

  detached = seeded('detached')
  gitMust(detached, 'checkout', '-q', '--detach')

  // A linked worktree of `own`, on `side`, with a per-worktree ref of its own.
  linked = path.join(tmp, 'linked')
  gitMust(own, 'worktree', 'add', '-q', linked, 'side')
  commit(linked, 'on side')
  gitMust(linked, 'update-ref', 'refs/bisect/bad', 'HEAD')

  // Six symrefs in a row, one past what git follows.
  chained = seeded('chained')
  let target = 'refs/heads/main'
  for (const link of ['l1', 'l2', 'l3', 'l4', 'l5', 'l6']) {
    gitMust(chained, 'symbolic-ref', `refs/heads/${link}`, target)
    target = `refs/heads/${link}`
  }
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

test('a loose ref is the sha in its file, and HEAD through the branch it names', () => {
  agreesOnSha(own, 'refs/heads/main')
  agreesOnSha(own, 'HEAD')
  assert.equal(refSha(place(own), 'HEAD').sha, gitMust(own, 'rev-parse', 'HEAD'))
})

test('a packed ref is read from packed-refs, past the header line', () => {
  assert.ok(!fs.existsSync(path.join(mirror, 'refs', 'heads', 'main')), 'clone --bare packs its refs')
  assert.match(fs.readFileSync(path.join(mirror, 'packed-refs'), 'utf8'), /^# pack-refs with:/)
  agreesOnSha(mirror, 'refs/heads/main')
  agreesOnSha(mirror, 'refs/heads/side')
})

test('a loose ref wins over the packed line it has moved on from', () => {
  const dir = seeded('moved-on')
  gitMust(dir, 'pack-refs', '--all')
  const packed = gitMust(dir, 'rev-parse', 'refs/heads/main')
  const newer = commit(dir, 'newer')
  assert.notEqual(newer, packed)
  assert.match(fs.readFileSync(path.join(dir, '.git', 'packed-refs'), 'utf8'), new RegExp(packed), 'the old sha is still packed')
  assert.equal(agreesOnSha(dir, 'refs/heads/main').sha, newer)
})

test('an annotated tag is the tag object, never the `^` peeled line under it', () => {
  gitMust(own, 'pack-refs', '--all')
  const text = fs.readFileSync(path.join(own, '.git', 'packed-refs'), 'utf8')
  assert.match(text, /\n\^[0-9a-f]{40}\n/, 'the tag is packed with its peeled line')
  const tag = agreesOnSha(own, 'refs/tags/v1').sha
  assert.notEqual(tag, gitMust(own, 'rev-parse', 'refs/tags/v1^{}'))
})

test('a ref in neither place is no such ref: a fact, not a shrug', () => {
  const ours = refSha(place(own), 'refs/heads/nope')
  assert.deepEqual(ours, { sha: null })
  assert.ok(noSuchRef(ours))
  assert.equal(git(own, 'rev-parse', '--verify', '-q', 'refs/heads/nope').code, 1)
  assert.ok(!noSuchRef(null), 'null is a shrug, not a no')
  assert.ok(!noSuchRef(refSha(place(own), 'HEAD')))
})

test('an unborn HEAD names a branch that exists nowhere, which is no sha, as git says', () => {
  assert.deepEqual(refSha(place(unborn), 'HEAD'), { sha: null })
  assert.equal(git(unborn, 'rev-parse', '--verify', '-q', 'HEAD').code, 1)
  assert.deepEqual(refSha(place(unborn), 'refs/heads/main'), { sha: null })
  assert.deepEqual(agreesOnSymref(unborn, 'HEAD'), { target: 'refs/heads/main' }, 'the branch it will be')
})

test('a detached HEAD is the sha in it', () => {
  assert.equal(agreesOnSha(detached, 'HEAD').sha, gitMust(detached, 'rev-parse', 'HEAD'))
  assert.deepEqual(agreesOnSymref(detached, 'HEAD'), { target: null })
})

test('a symref is followed the way git follows it, and a chain past five reads is handed back', () => {
  agreesOnSha(own, 'refs/heads/alias')
  assert.deepEqual(agreesOnSymref(own, 'refs/heads/alias'), { target: 'refs/heads/main' })
  for (const link of ['l1', 'l2', 'l3', 'l4']) {
    agreesOnSha(chained, `refs/heads/${link}`)
    assert.deepEqual(agreesOnSymref(chained, `refs/heads/${link}`), { target: 'refs/heads/main' }, `${link} ends on main, not one link down`)
  }
  for (const link of ['l5', 'l6']) {
    assert.notEqual(git(chained, 'rev-parse', '--verify', '-q', `refs/heads/${link}`).code, 0, `git gives up on ${link}`)
    assert.equal(refSha(place(chained), `refs/heads/${link}`), null)
    assert.equal(symref(place(chained), `refs/heads/${link}`), null)
  }
})

test('a symbolic ref names its target, a plain ref is not one, and an absent one is git\'s', () => {
  assert.deepEqual(agreesOnSymref(mirror, 'refs/remotes/origin/HEAD'), { target: 'refs/remotes/origin/main' })
  assert.deepEqual(agreesOnSymref(own, 'HEAD'), { target: 'refs/heads/main' })
  assert.deepEqual(agreesOnSymref(mirror, 'refs/remotes/origin/main'), { target: null })
  agreesOnSymref(mirror, 'refs/heads/main', 'a packed plain ref')
  assert.deepEqual(agreesOnSymref(mirror, 'refs/remotes/origin/nope', 'a ref that is not there'), { target: null })
})

test('HEAD is the worktree\'s own, and its per-worktree refs are handed back', () => {
  assert.equal(agreesOnSha(linked, 'HEAD').sha, gitMust(own, 'rev-parse', 'refs/heads/side'))
  assert.notEqual(refSha(place(linked), 'HEAD').sha, refSha(place(own), 'HEAD').sha)
  agreesOnSha(linked, 'refs/heads/main', 'a shared ref from a linked worktree')
  assert.equal(refSha(place(linked), 'refs/bisect/bad'), null)
  assert.equal(refSha(place(linked), 'refs/worktree/x'), null)
  assert.equal(refSha(place(linked), 'refs/rewritten/x'), null)
})

test('a ref packed between the loose miss and the packed read is still found', t => {
  const dir = seeded('packing')
  const sha = gitMust(dir, 'rev-parse', 'refs/heads/main')
  // The reader opens the file under the real path `discover` resolved, which on a Windows
  // runner is the long form of a temp directory git was handed in its 8.3 short form.
  const loose = fs.realpathSync.native(path.join(dir, '.git', 'refs', 'heads', 'main')).toLowerCase()
  // The first read of the loose file is where a concurrent `pack-refs` lands: the ref has
  // gone from `refs/heads/` to `packed-refs` before the file is opened. A reader that took
  // its snapshot of `packed-refs` first would have seen no line for it and said no such ref.
  const original = fs.readFileSync
  let packed = false
  fs.readFileSync = function (file, ...rest) {
    if (!packed && path.resolve(String(file)).toLowerCase() === loose) {
      packed = true
      gitMust(dir, 'pack-refs', '--all')
      assert.ok(!fs.existsSync(loose), 'pack-refs moved the ref')
    }
    return original.call(this, file, ...rest)
  }
  t.after(() => { fs.readFileSync = original })
  assert.deepEqual(refSha(place(dir), 'refs/heads/main'), { sha })
  assert.ok(packed, 'the loose file was read first')
})

test('a name git would have to guess at is handed back: short names, @{u}, and anything not under refs/', () => {
  for (const name of ['main', 'origin/main', '@{u}', 'HEAD~1', 'refs/heads/main^{}', 'heads/main', 'refs/../main', 'refs/heads/', '']) {
    assert.equal(refSha(place(own), name), null, name)
    assert.equal(symref(place(own), name), null, name)
  }
})

test('a loose file that is not a sha and not a symref is handed back, whatever git makes of it', () => {
  const dir = seeded('garbage')
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'short'), 'abc123\n')
  fs.writeFileSync(path.join(dir, '.git', 'refs', 'heads', 'empty'), '')
  assert.equal(refSha(place(dir), 'refs/heads/short'), null)
  assert.equal(refSha(place(dir), 'refs/heads/empty'), null)
  assert.equal(symref(place(dir), 'refs/heads/short'), null)
})

test('a packed-refs file the parser cannot read whole is handed back', () => {
  const dir = seeded('badpack')
  gitMust(dir, 'pack-refs', '--all')
  fs.appendFileSync(path.join(dir, '.git', 'packed-refs'), 'not a ref line\n')
  assert.equal(refSha(place(dir), 'refs/heads/main'), null)
  assert.equal(refSha(place(dir), 'refs/heads/nope'), null, 'absence cannot be asserted from a file half read')
})

test('a place the walk handed back, or one with no repository, reads nothing', () => {
  assert.equal(refSha(null, 'HEAD'), null)
  assert.equal(symref(null, 'HEAD'), null)
  const nowhere = discover(mk(path.join(tmp, 'nowhere')), env)
  assert.equal(nowhere.gitDir, null)
  assert.equal(refSha(nowhere, 'HEAD'), null)
})

test('a bare mirror is placed and read like any repository', () => {
  const p = place(mirror)
  assert.equal(p.top, null)
  assert.equal(refSha(p, 'refs/remotes/origin/main').sha, gitMust(mirror, 'rev-parse', 'refs/remotes/origin/main'))
  assert.deepEqual(refSha(p, 'refs/remotes/origin/gone'), { sha: null })
})
