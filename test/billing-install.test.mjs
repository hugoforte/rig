// `billingInstall` itself, rather than the commands the files built on it test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { billingInstall } from './billing-install.mjs'

test('a billingInstall that fails part way leaves no temp directory behind', t => {
  const prefix = `rig-billing-fails-${process.pid}-`
  const mkdir = fs.mkdirSync
  t.mock.method(fs, 'mkdirSync', (dir, ...rest) => {
    if (String(dir).includes(`${path.sep}seed${path.sep}`)) throw new Error('no space left on device')
    return mkdir(dir, ...rest)
  })

  assert.throws(() => billingInstall(prefix), /no space left on device/)
  assert.deepEqual(fs.readdirSync(os.tmpdir()).filter(name => name.startsWith(prefix)), [])
})
