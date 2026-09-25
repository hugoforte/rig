// What `npm install -g <the clone>` reads to make `rig` a command. The install itself — a link
// to the checkout, which is what lets `rig update` move the command by fast-forwarding it — is
// driven end to end by test/install.test.mjs, through the scripts the README hands people.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

test('package.json names rig as a command, pointing at a script a POSIX shell can run', () => {
  assert.equal(pkg.bin?.rig, 'bin/rig.mjs')
  const first = fs.readFileSync(path.join(ROOT, pkg.bin.rig), 'utf8').split('\n')[0]
  assert.equal(first, '#!/usr/bin/env node', 'a global install on Linux and macOS runs the file itself')
})
