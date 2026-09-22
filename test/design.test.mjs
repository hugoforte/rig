// The decision log's third column names the test that enforces each decision, and this file is
// what stops that column becoming the thing it exists to prevent.
//
// DESIGN.md's decisions are claims about how rig behaves. Some are enforced by a test and some
// are not, and until the column existed there was no way to tell which — `bin/worktrees.mjs:7`
// said decisions 4, 9 and 10 were "restated as this module's job" without naming anything that
// checks it. A decision that quietly stopped being true read exactly like one that still held.
//
// A column of test names nobody resolves would fail the same way, and worse: it would assert
// enforcement that had gone. "Something has to read it back" is the standard this repo uses to
// decide whether an artifact deserves to exist — `rig plan` failed it for its whole existence —
// so the reference is checked, not trusted. A renamed or deleted test fails here, on the pull
// request that renamed it, which is the only moment the rename is cheap to think about.
//
// What is deliberately *not* a failure: an empty cell. The unenforced decisions are the output,
// not the bug — they are the list of places the design is asserted and unchecked, which is what
// someone choosing where to spend test effort wants to read. The check fires on a dangling
// reference and never on an honest gap.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESIGN = fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8')

const NONE = '—'

// The decision log, as rows. The section ends at the next heading or the end of the file; a row
// is a table line whose first cell is the decision number, which skips the header and the
// alignment rule without having to recognise either.
function decisionRows () {
  const start = DESIGN.indexOf('\n## 10. Decision log')
  assert.notEqual(start, -1, 'DESIGN.md has no "## 10. Decision log" section')
  const rest = DESIGN.slice(start + 1)
  const end = rest.indexOf('\n## ', 1)
  const section = end === -1 ? rest : rest.slice(0, end)

  return section.split('\n').flatMap(line => {
    const cells = splitRow(line)
    if (cells.length < 3 || cells[0].trim() !== '') return []
    const n = cells[1].trim()
    if (!/^[0-9]+$/.test(n)) return []
    return [{ n: Number(n), decision: cells[2].trim(), enforcedBy: (cells[3] || '').trim(), cells, line }]
  })
}

// Cells are separated by pipes the row did not escape. Splitting on every pipe instead is what
// this test caught on its first run: decision 51 escapes the pipes in a `release:` label and
// decision 67 did not, so one row silently rendered with columns nobody wrote.
function splitRow (line) {
  return line.split(/(?<!\\)\|/)
}

// One reference is a backticked path followed by the test's title in double quotes. Several in a
// cell are separated by a semicolon, which is why the title is quoted rather than bare: titles
// contain commas, colons and apostrophes, and the quotes are what make the end of one findable.
const referencesIn = cell => [...cell.matchAll(/`([^`]+)`\s+"([^"]+)"/g)].map(m => ({ file: m[1], title: m[2] }))

// A test title in source carries the escapes its quoting needed: `'the base is the repo\'s own
// remote HEAD'`. The column quotes titles differently, so the source is normalised before the
// comparison rather than the column being made to match a quoting style it does not use.
const unescaped = src => src.replace(/\\(['"`])/g, '$1')

const rows = decisionRows()

test('the decision log is a table of decisions, each with a cell for what enforces it', () => {
  assert.ok(rows.length > 0, 'no decision rows parsed out of section 10')
  const wrong = rows.filter(r => r.cells.length !== 5)
  assert.deepEqual(wrong.map(r => r.n), [],
    'these rows are not three cells wide — a missing enforced-by cell, or an unescaped pipe in the decision')
})

test('every test a decision names is a file that exists', () => {
  const missing = []
  for (const row of rows) {
    for (const ref of referencesIn(row.enforcedBy)) {
      if (!fs.existsSync(path.join(ROOT, ref.file))) missing.push(`decision ${row.n} -> ${ref.file}`)
    }
  }
  assert.deepEqual(missing, [], 'a decision names a test file that is gone')
})

test('every test a decision names is still in the file it names', () => {
  const sources = new Map()
  const gone = []
  for (const row of rows) {
    for (const ref of referencesIn(row.enforcedBy)) {
      const full = path.join(ROOT, ref.file)
      if (!fs.existsSync(full)) continue   // already reported by the test above
      if (!sources.has(ref.file)) sources.set(ref.file, unescaped(fs.readFileSync(full, 'utf8')))
      if (!sources.get(ref.file).includes(ref.title)) gone.push(`decision ${row.n} -> ${ref.file} "${ref.title}"`)
    }
  }
  assert.deepEqual(gone, [], 'a decision names a test that has been renamed or removed')
})

test('a cell claiming enforcement parses to at least one reference', () => {
  // The failure this catches is a cell filled in by hand in a shape the parser does not read:
  // a bare path with no title, curly quotes, a missing backtick. Silently parsing to nothing
  // would make an unenforced decision look enforced, which is the one outcome worse than an
  // empty cell.
  const unparsed = rows
    .filter(r => r.enforcedBy !== '' && r.enforcedBy !== NONE && referencesIn(r.enforcedBy).length === 0)
    .map(r => `decision ${r.n}: ${r.enforcedBy}`)
  assert.deepEqual(unparsed, [], 'these cells are neither empty nor a readable reference')
})
