// The installation the installation family drives, and the moves the tests make against it: a
// tool checkout with a real remote, which is the one thing test/smoke.test.mjs cannot be — it
// copies the tool without a `.git`, so every freshness path short-circuits there. Everything
// here is local: a bare repo on disk stands in for the remote, so no test touches a network.
// test/harness.mjs builds it; `checkout` is what makes it a real clone rather than the bare
// copy the other suites run.
//
// Three files drive it, each with an installation of its own built from here: how an
// installation hears that it is behind its remote in installation-freshness, what
// `rig update` does to the tool checkout and what the tool says of the installation in
// installation-update, and whether `rig update` migrates a data root in
// installation-migrations. Together they would be the slowest file in the suite, about 25 s
// alone on a Windows runner, and `node --test` parallelises by file: apart, none is above
// about 12 s, which is what lets CI deal the suite across runners in parts of a similar size
// (hugoforte/rig#160). Within a file the tests may run in order, each leaving the
// installation where the next one expects it; between the files nothing is shared.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall } from './harness.mjs'

// `prefix` names the temp directory, so a failing run says which file left it behind.
export function installationFixture (prefix) {
  const m = makeInstall({
    prefix,
    author: 'rig install test',
    email: 'install@example.invalid',
    checkout: true,
    // No tracker CLI is reached by anything here, but the in-memory adapter keeps it that way.
    github: { auth: 'missing' },
  })
  // The roots are built before the test file has registered `after(cleanup)`, so a build that
  // throws would leave the installation behind unless this removes it.
  try {
    return { ...m, ...build(m) }
  } catch (e) {
    m.cleanup()
    throw e
  }
}

function build ({ tmp, origin, install, dataRoot, workRoot, env, git }) {
  // A data root and work root for the installation, set up as `rig init` would leave them.
  fs.mkdirSync(workRoot)
  assert.equal(git(tmp, 'init', '-q', '-b', 'main', dataRoot).status, 0)
  fs.writeFileSync(path.join(dataRoot, 'rig.json'),
    JSON.stringify({ orgs: ['acme'], tracker: { acme: { kind: 'none' } }, writtenBy: '1.0.0' }, null, 2) + '\n')
  assert.equal(git(dataRoot, 'add', '-A').status, 0)
  assert.equal(git(dataRoot, 'commit', '-q', '-m', 'rig.json').status, 0)
  fs.writeFileSync(path.join(install, 'rig.local.json'), JSON.stringify({ dataRoot, workRoot }, null, 2) + '\n')

  // The tool spawned directly, for the tests that need the streams apart or an environment
  // the harness's runner will not build. `cwd` is the temp directory for the same reason the
  // runner defaults to it: rig resolves its data root partly from the folder it runs in, and
  // this suite is itself run from inside a rig work folder often enough that inheriting would
  // let that folder's `.rig/data` name a root the temp installation does not configure.
  const spawnRig = (args, spawnEnv = env) =>
    spawnSync(process.execPath, [path.join(install, 'bin', 'rig.mjs'), ...args],
      { encoding: 'utf8', env: spawnEnv, cwd: tmp })

  // rig.local.json in the installation, rewritten for the duration of `body` and put back
  // afterwards.
  const withLocalConfig = (extra, body) => {
    const file = path.join(install, 'rig.local.json')
    const before = fs.readFileSync(file, 'utf8')
    fs.writeFileSync(file, JSON.stringify({ dataRoot, workRoot, ...extra }, null, 2) + '\n')
    try { body() } finally { fs.writeFileSync(file, before) }
  }

  // Another machine pushes a commit to the tool's remote, which leaves this installation one
  // further behind it.
  const pushToOrigin = message => {
    const clone = path.join(tmp, `push-${Math.random().toString(36).slice(2, 8)}`)
    assert.equal(git(tmp, 'clone', '-q', origin, clone).status, 0)
    fs.appendFileSync(path.join(clone, 'NOTES.md'), `${message}\n`)
    assert.equal(git(clone, 'add', '-A').status, 0)
    assert.equal(git(clone, 'commit', '-q', '-m', message).status, 0)
    assert.equal(git(clone, 'push', '-q').status, 0)
  }

  return { spawnRig, withLocalConfig, pushToOrigin }
}
