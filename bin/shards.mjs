#!/usr/bin/env node
// One shard of the suite, for CI to run the test files across several runners at once:
// `node bin/shards.mjs 3/8` runs the third of eight, and `--print` names its files instead.
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

// Seconds each file took alone on a windows-latest runner, the mean of three (run 36000370498;
// hugoforte/rig#160 says how they were taken), with the temp directory on the runner's D:
// drive and Node 22, which is how the shard jobs run. Runners differ by up to half again, so
// the last digit means little; what the table has to keep right is the order and the rough
// size. Take them again when one shard's step drifts well past the others'.
export const WEIGHTS = {
  'smoke.test.mjs': 13.3,
  'stages-e2e.test.mjs': 11.5,
  'install.test.mjs': 10.5,
  'worktrees.test.mjs': 10.5,
  'attach.test.mjs': 9.4,
  'scenarios.test.mjs': 8.9,
  'installation-update.test.mjs': 8.6,
  'close.test.mjs': 8.4,
  'checkouts-forward.test.mjs': 7.6,
  'worktrees-stack-edge.test.mjs': 7.4,
  'worktrees-stack.test.mjs': 7.2,
  'installation-freshness.test.mjs': 7.1,
  'stage-tickets.test.mjs': 6.9,
  'refs.test.mjs': 6.4,
  'installation-migrations.test.mjs': 6.1,
  'checkouts-push.test.mjs': 5.8,
  'gitfs.test.mjs': 5.7,
  'checkouts-read.test.mjs': 5.7,
  'stage-cut.test.mjs': 4.9,
  'release-e2e.test.mjs': 4.0,
  'pr.test.mjs': 3.9,
  'dataroots.test.mjs': 3.8,
  'check.test.mjs': 3.7,
  'plan.test.mjs': 3.5,
  'impact.test.mjs': 3.1,
  'base.test.mjs': 2.8,
  'invocation.test.mjs': 2.4,
  'dash.test.mjs': 2.1,
  'doctor-selection.test.mjs': 1.6,
  'helpers.test.mjs': 1.4,
  'jira.test.mjs': 0.8,
  'identity.test.mjs': 0.7,
  'release.test.mjs': 0.7,
  'demo.test.mjs': 0.5,
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
