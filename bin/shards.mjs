#!/usr/bin/env node
// One shard of the suite, for CI to run the test files across several runners at once:
// `node bin/shards.mjs 3/6` runs the third of six, and `--print` names its files instead.
//
// Every `test/*.test.mjs` on disk is dealt, heaviest first, each to whichever shard is lightest
// so far, by how long the file took alone on a Windows runner (WEIGHTS). A file the table does
// not know weighs a second and is dealt like any other, so a new test file beside the others
// runs in CI without anyone editing a list. The weights balance the shards and never decide
// what runs; test/shards.test.mjs holds that nothing node would run under test/ goes undealt.
//
// `node --test --test-shard` deals round-robin over the sorted names instead, which put the
// heaviest files together and made the slowest shard three times the fastest.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Seconds each file took alone on a windows-latest runner, the mean of two (run 35923718667;
// hugoforte/rig#155 says how they were taken). Runners differ by up to half again, so the last
// digit means little; what the table has to keep right is the order and the rough size. Take
// them again when one shard's step drifts well past the others'.
export const WEIGHTS = {
  'smoke.test.mjs': 18.6,
  'stages-e2e.test.mjs': 16.7,
  'checkouts-forward.test.mjs': 15.2,
  'attach.test.mjs': 14.7,
  'worktrees.test.mjs': 13.6,
  'checkouts-read.test.mjs': 12.9,
  'close.test.mjs': 12.6,
  'scenarios.test.mjs': 12.6,
  'worktrees-stack.test.mjs': 11.8,
  'installation-update.test.mjs': 11.5,
  'checkouts-push.test.mjs': 11.4,
  'worktrees-stack-edge.test.mjs': 10.3,
  'stage-tickets.test.mjs': 10.1,
  'install.test.mjs': 9.8,
  'installation-freshness.test.mjs': 9.6,
  'stage-cut.test.mjs': 7.5,
  'installation-migrations.test.mjs': 7.3,
  'gitfs.test.mjs': 6.6,
  'dataroots.test.mjs': 5.1,
  'pr.test.mjs': 5.1,
  'check.test.mjs': 5.0,
  'release-e2e.test.mjs': 4.7,
  'invocation.test.mjs': 4.6,
  'plan.test.mjs': 4.6,
  'base.test.mjs': 3.5,
  'impact.test.mjs': 3.3,
  'dash.test.mjs': 2.2,
  'doctor-selection.test.mjs': 2.1,
  'helpers.test.mjs': 1.9,
  'jira.test.mjs': 1.1,
  'package.test.mjs': 1.0,
  'identity.test.mjs': 0.9,
  'release.test.mjs': 0.7,
  'demo.test.mjs': 0.6,
}
const UNKNOWN = 1

export const weight = file => WEIGHTS[file] ?? UNKNOWN

// The test files a directory holds, by name, so the deal is the same wherever it is made.
export const testFiles = dir => fs.readdirSync(dir).filter(f => f.endsWith('.test.mjs')).sort()

// `total` shards, each `{ files, weight }`, every file in exactly one of them. Ties in weight
// go by name and the first lightest shard wins, so the same files always deal the same way.
export function deal (files, total) {
  const shards = Array.from({ length: total }, () => ({ files: [], weight: 0 }))
  const heaviestFirst = [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))
  for (const file of heaviestFirst) {
    const lightest = shards.reduce((min, s) => (s.weight < min.weight ? s : min))
    lightest.files.push(file)
    lightest.weight += weight(file)
  }
  return shards
}

// `<index>/<total>`, one-based, the way `--test-shard` writes it.
export function parseShard (spec) {
  const m = /^([1-9]\d*)\/([1-9]\d*)$/.exec(spec ?? '')
  const index = m && Number(m[1])
  const total = m && Number(m[2])
  if (!m || index > total) throw new Error(`expected <index>/<total> with index ≤ total, got "${spec}"`)
  return { index, total }
}

function main (argv) {
  const print = argv.includes('--print')
  const { index, total } = parseShard(argv.find(a => !a.startsWith('--')))
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'test')
  const mine = deal(testFiles(dir), total)[index - 1]
  const files = mine.files.map(f => path.join(dir, f))
  console.log(`shard ${index}/${total}: ${mine.files.length} files, ${mine.weight.toFixed(1)} s alone: ${mine.files.join(' ')}`)
  // `node --test` with no files runs its default glob, which is the whole suite.
  if (print || mine.files.length === 0) return 0
  const r = spawnSync(process.execPath, ['--test', ...files], { stdio: 'inherit' })
  if (r.error) throw r.error
  return r.status ?? 1
}

// Node realpaths the main module before evaluating it, so compare realpaths: through a
// junction argv[1] is the link, and a guard that compared paths would run nothing and exit 0.
const isMain = (() => {
  if (!process.argv[1]) return false
  try { return fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) } catch { return false }
})()
if (isMain) process.exitCode = main(process.argv.slice(2))
