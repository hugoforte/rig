// `run(argv, io)` as a seam, rather than through what it happens to make possible.
//
// The rest of the suite drives rig through `test/harness.mjs`'s `rig()`, which now has two
// adapters and picks the in-process one for most files — so if the seam leaked, what would
// fail is whichever test happened to run second, with a message about a data root or a
// catalogue and nothing about the leak. These are the five properties that make the in-process
// adapter honest, each asserted where it is the subject, and after them the half of the seam
// that only the CLI uses.
//
// The installations are `makeInstall`'s, because what has to be shown is a *run* against an
// installation that is not this checkout; `run` is called directly rather than through `rig()`,
// because `rig()` choosing the adapter is the thing under test everywhere else.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import { run } from '../bin/rig.mjs'
import { DEFAULT_ROOT_NAME } from '../bin/roots.mjs'
import { makeInstall, strip } from './harness.mjs'

// Two installations, because one cannot show that a run does not read the other's. Each has
// its machine file outside the tool copy (`localConfig`), which is what lets two of them exist
// on one machine at all.
const one = makeInstall({ prefix: 'rig-invocation-one-', localConfig: true, github: { auth: 'ok' } })
const two = makeInstall({ prefix: 'rig-invocation-two-', localConfig: true, github: { auth: 'ok' } })

after(() => { one.cleanup(); two.cleanup() })

// One invocation against one installation, with everything of the machine it may reach named.
const drive = (m, args, { cwd = m.tmp, input = '', chdir } = {}) => {
  let out = ''
  let err = ''
  const code = run(args, {
    toolRoot: m.install,
    cwd,
    env: m.env,
    stdin: () => input,
    out: s => { out += s },
    err: s => { err += s },
    chdir,
  })
  return { code, out: strip(out), err: strip(err) }
}

const setUp = m => assert.equal(drive(m, ['init', '--data-root', m.dataRoot,
  '--work-root', m.workRoot, '--orgs', 'acme', '--tracker', 'acme=none']).code, 0)

test('a run answers with an exit code, and every word of it reaches the writers it was handed', () => {
  const answered = drive(one, ['help'])
  assert.equal(answered.code, 0)
  assert.match(answered.out, /cross-repo work harness/)
  assert.equal(answered.err, '', 'a command that worked says nothing on the error stream')

  // The refusal, on the other stream and with the exit code that carries it. This used to be
  // `process.exit(1)`, which a caller in the same process could not have survived.
  const refused = drive(one, ['nonsense'])
  assert.equal(refused.code, 1)
  assert.match(refused.err, /unknown command "nonsense"/)
  assert.equal(refused.out, '', 'and nothing on the answer stream to confuse a pipe')
})

test('two installations, one process, and neither run resolves the other\'s data root', () => {
  setUp(one)
  setUp(two)
  // Interleaved on purpose: the failure this catches is a resolved location memoised past the
  // end of a run, which a test that finished with one installation before starting the other
  // would never see.
  assert.equal(drive(one, ['new', 'in-one', '--title', 'In one', '--no-ticket']).code, 0)
  assert.equal(drive(two, ['new', 'in-two', '--title', 'In two', '--no-ticket']).code, 0)
  assert.equal(drive(one, ['new', 'in-one-again', '--title', 'Again', '--no-ticket']).code, 0)

  const records = m => fs.readdirSync(path.join(m.dataRoot, 'work')).sort()
  assert.deepEqual(records(one), ['in-one', 'in-one-again'])
  assert.deepEqual(records(two), ['in-two'])
})

test('the folder a run is standing in is the one it was handed, never the process\'s', () => {
  // Nothing has changed this process's directory, so a work found here can only have been
  // found by walking up from the cwd the run was given.
  const inside = drive(one, ['status'], { cwd: path.join(one.workRoot, 'in-one') })
  assert.equal(inside.code, 0, inside.out + inside.err)
  assert.match(inside.out, /in-one/)

  const outside = drive(one, ['status'])
  assert.equal(outside.code, 1)
  assert.match(outside.err, /not inside a work/)
})

test('a tracker is a run\'s, so the next run reads the state file again rather than what it remembered', () => {
  assert.match(drive(one, ['doctor']).out, /gh authenticated/)

  fs.writeFileSync(one.githubStateFile, JSON.stringify({ auth: 'missing' }))
  // The adapter used to be resolved once per process, which is right for a process that runs
  // one command and wrong for anything else: this second run would have been answered by the
  // first run's client, reading the state that had already been loaded into memory.
  assert.match(drive(one, ['doctor']).out, /gh not on PATH/)
})

test('a run handed a crippled PATH is never told what a run with a whole one found', () => {
  // What is remembered across runs is keyed on PATH, so the key has to be the PATH a child is
  // actually given. `{ ...env, PATH }` from a shell that spells it `Path` holds both, and a
  // Windows child is handed whichever sorts first, which is not the one inserted first.
  const whole = Object.entries(one.env).find(([k]) => k.toUpperCase() === 'PATH')[1]
  const crippled = Object.fromEntries(Object.entries(one.env).filter(([k]) => k.toUpperCase() !== 'PATH'))
  crippled.Path = whole
  crippled.PATH = path.join(one.tmp, 'no-git-here')
  const doctor = env => drive({ ...one, env }, ['doctor']).out

  assert.match(doctor(crippled), /git — not on PATH/, 'the crippled run was answered from the whole one')
  assert.doesNotMatch(doctor(one.env), /git — not on PATH/, 'the whole run was answered from the crippled one')
})

// ------------------------------------------------------------ the CLI's half

// What `run` does with what it was *not* handed, which is how the CLI calls it and how no
// in-process caller in the suite does, and what the process it runs in needs from it: to be
// moved out of a folder it removes, and to outlive a reader that stops early. The CLI's stdin
// is read in test/smoke.test.mjs, beside the command that reads it.

test('a run handed no cwd asks the process for one only when a command needs it', () => {
  // `rig close` run from inside a work folder leaves the shell standing in a directory that is
  // gone, and there `process.cwd()` throws. `help` and a command pinned to a root by name need
  // no directory at all, and the next command from that shell is often one of them.
  const real = process.cwd
  process.cwd = () => { throw Object.assign(new Error('ENOENT: no such file or directory, uv_cwd'), { code: 'ENOENT' }) }
  try {
    for (const args of [['help'], ['list', '--quick', '--data', DEFAULT_ROOT_NAME]]) {
      let said = ''
      const code = run(args, { toolRoot: one.install, env: one.env, out: s => { said += s }, err: s => { said += s } })
      assert.equal(code, 0, `rig ${args.join(' ')}: ${strip(said)}`)
    }
  } finally {
    process.cwd = real
  }
})

test('a reader that stops reading is the end of the output, not a crash', async () => {
  // `rig list | head -1`: the reader goes, and every line rig writes after that meets a closed
  // pipe. Closed here before rig has written a word, so that none of them can win the race.
  const child = spawn(process.execPath, [path.join(one.install, 'bin', 'rig.mjs'), 'list', '--quick'],
    { env: one.env, cwd: one.tmp, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.destroy()
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  const code = await new Promise(resolve => child.on('close', resolve))
  assert.equal(code, 0, stderr)
  assert.doesNotMatch(stderr, /EPIPE|Unhandled 'error'/)
})

test('a run moves out of the folder it is closing, and moves the process only by the caller\'s hand', () => {
  // The run's own cwd always moves. The process belongs to the caller, so the move is handed
  // to the caller's `chdir` — here one that only notes where it was asked to go, which is what
  // an in-process caller that must not move the process would do.
  const before = process.cwd()
  const moved = []
  const r = drive(one, ['close'], { cwd: path.join(one.workRoot, 'in-one'), chdir: dir => moved.push(dir) })
  assert.equal(r.code, 0, r.out + r.err)
  assert.deepEqual(moved, [one.install], 'the caller was asked to follow it to the tool root')
  assert.equal(process.cwd(), before, 'and nothing else moved the process')
})

test('the CLI moves its process out of the work folder it is closing, so the folder can go', () => {
  // A subprocess, because the process is the subject: Windows will not remove a directory that
  // is some process's cwd, and this one starts in the folder it removes. Everywhere else the
  // folder would go regardless, so what this pins is the CLI handing `run` a `chdir` that moves.
  const folder = path.join(one.workRoot, 'in-one-again')
  const r = one.rig(['close'], { cwd: folder, inProcess: false })
  assert.equal(r.code, 0, r.out)
  assert.ok(!fs.existsSync(folder), r.out)
})
