// The install path the README promises: clone, `npm install -g <the clone>`, and `rig` is a
// command. Global installs of a folder are links, not copies, which is what lets `rig update`
// move the command by fast-forwarding the checkout.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WINDOWS = process.platform === 'win32'
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

// The npm that ships with the node running these tests, run as a script so no shell is
// involved: the `npm.cmd` shim resolves its own location wrongly when spawned through one.
const nodeDir = path.dirname(process.execPath)
const npmCli = [
  path.join(nodeDir, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  path.join(nodeDir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
].find(fs.existsSync)

test('package.json names rig as a command, pointing at a script a POSIX shell can run', () => {
  assert.equal(pkg.bin?.rig, 'bin/rig.mjs')
  const first = fs.readFileSync(path.join(ROOT, pkg.bin.rig), 'utf8').split('\n')[0]
  assert.equal(first, '#!/usr/bin/env node', 'a global install on Linux and macOS runs the file itself')
})

test('npm install -g from the checkout puts a `rig` command on PATH that runs this checkout', () => {
  assert.ok(npmCli, `no npm-cli.js beside ${process.execPath}`)
  const prefix = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-npm-'))
  try {
    const install = spawnSync(process.execPath, [npmCli, 'install', '-g', '--prefix', prefix, ROOT], { encoding: 'utf8' })
    assert.equal(install.status, 0, install.stderr)

    // The shim npm wrote is a batch file on Windows, which only a shell can run.
    const command = WINDOWS ? path.join(prefix, 'rig.cmd') : path.join(prefix, 'bin', 'rig')
    const r = spawnSync(WINDOWS ? `"${command}"` : command, ['help'], { encoding: 'utf8', shell: WINDOWS })
    assert.equal(r.status, 0, r.stderr)
    assert.match(r.stdout, /cross-repo work harness/)

    const installed = path.join(prefix, WINDOWS ? 'node_modules' : path.join('lib', 'node_modules'), 'rig')
    assert.equal(fs.realpathSync(installed), fs.realpathSync(ROOT),
      'installed as a link to the checkout, so fast-forwarding the checkout moves the command')
  } finally {
    fs.rmSync(prefix, { recursive: true, force: true })
  }
})
