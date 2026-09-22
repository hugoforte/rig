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
// someone choosing where to spend test effort wants to read. The checks fire on a reference
// that no longer resolves, and never on an honest gap.
//
// Every check below is written to fail *closed*. A row this file cannot parse is a finding
// rather than a row it skips, because silently dropping one is how an unenforced decision would
// come to look enforced — which is the single outcome worse than an empty cell.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DESIGN = fs.readFileSync(path.join(ROOT, 'DESIGN.md'), 'utf8')

const NONE = '—'
const HEADER = '| # | Decision | Enforced by |'

// Cells are separated by the pipes a row did not escape. Splitting on every pipe instead is
// what this file caught on its first run: decision 51 escapes the pipes in a `release:` label
// and decision 67 did not, so one row had been rendering with columns nobody wrote.
const splitRow = line => line.split(/(?<!\\)\|/)

// ...and an escaped pipe is a pipe. Undone before anything reads a cell's text, because a test
// title may legitimately contain one — `release:minor|patch|none` is the shape already in the
// log — and a title that cannot be written down is a cell that has to be left empty instead.
const unescapePipes = s => s.replace(/\\\|/g, '|')

// A quoted string in source carries the escapes its quoting needed: `'the base is the repo\'s
// own remote HEAD'`. The column quotes titles differently, so the source's escapes come off
// before the two are compared, rather than the column being made to match a quoting style it
// does not use.
const unescapeQuotes = s => s.replace(/\\(['"`])/g, '$1')

// The decision log, as rows. The section ends at the next heading or the end of the file. Every
// table line that is not the header or the alignment rule is a decision row — including one
// whose number cell is malformed, which is reported rather than skipped.
function decisionRows () {
  const start = DESIGN.indexOf('\n' + '## 10. Decision log')
  assert.notEqual(start, -1, 'DESIGN.md has no "## 10. Decision log" section')
  const rest = DESIGN.slice(start + 1)
  const end = rest.indexOf('\n## ', 1)
  const section = end === -1 ? rest : rest.slice(0, end)

  return section.split('\n').flatMap(line => {
    if (!line.startsWith('|')) return []
    if (line.trim() === HEADER || /^\|[\s:|-]+\|$/.test(line)) return []
    const cells = splitRow(line)
    return [{
      n: (cells[1] ?? '').trim(),
      decision: (cells[2] ?? '').trim(),
      enforcedBy: unescapePipes((cells[3] ?? '').trim()),
      cells,
      line,
    }]
  })
}

// One reference, whole: a backticked path, then the test's own title in double quotes, and
// nothing else. Anchored, and applied to each semicolon-separated part of the cell rather than
// swept over the cell as a whole — an unanchored search finds the references that happen to be
// well formed and says nothing about the rest, so a cell of four claims with one typo among
// them would report three and drop the fourth.
const REFERENCE = /^`([^`]+)`\s+"([^"]+)"$/

function parseCell (cell) {
  if (cell === '' || cell === NONE) return { refs: [], malformed: [] }
  const refs = []
  const malformed = []
  for (const part of cell.split(';').map(s => s.trim())) {
    const m = REFERENCE.exec(part)
    if (m) refs.push({ file: m[1], title: m[2] })
    else malformed.push(part)
  }
  return { refs, malformed }
}

// The titles a file actually declares. A substring search over the source was the first version
// and it was too generous by half: it passed for a title that had been *added to* — the rename
// this column exists to catch — and for one left behind in a comment. So the titles are parsed
// out and matched whole.
const titleCache = new Map()
function titlesIn (file) {
  if (!titleCache.has(file)) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
    const found = [...src.matchAll(/^[ \t]*(?:await\s+)?test\(\s*(["'`])((?:\\.|(?!\1).)*)\1/gm)]
    titleCache.set(file, new Set(found.map(m => unescapeQuotes(m[2]))))
  }
  return titleCache.get(file)
}

const rows = decisionRows()
const cells = rows.map(r => ({ ...r, ...parseCell(r.enforcedBy) }))

test('every line of the decision log is a decision, three cells wide and numbered', () => {
  assert.ok(rows.length > 0, 'no decision rows parsed out of section 10')
  const wrong = rows
    .filter(r => r.cells.length !== 5 || !/^[0-9]+$/.test(r.n))
    .map(r => r.line.slice(0, 60))
  assert.deepEqual(wrong, [],
    'a row is not three cells wide, or its number cell is not a bare number — either way the ' +
    'checks below would skip it, and a skipped row is an unenforced decision that looks enforced')
})

test('a cell claiming enforcement is readable end to end', () => {
  // The failure this catches is a cell filled in by hand in a shape the parser does not read: a
  // bare path with no title, curly quotes, a missing backtick, or a second reference after a
  // semicolon that left the path off. Parsing what it can and ignoring the rest would make an
  // unchecked claim look checked.
  const unparsed = cells.flatMap(r => r.malformed.map(m => `decision ${r.n}: ${m}`))
  assert.deepEqual(unparsed, [], 'these are neither empty nor a readable `path` "title" reference')
})

test('every test a decision names is a file that exists', () => {
  const missing = cells.flatMap(r => r.refs
    .filter(ref => !fs.existsSync(path.join(ROOT, ref.file)))
    .map(ref => `decision ${r.n} -> ${ref.file}`))
  assert.deepEqual(missing, [], 'a decision names a test file that is gone')
})

test('every test a decision names is still declared, under that exact title', () => {
  const gone = cells.flatMap(r => r.refs
    .filter(ref => fs.existsSync(path.join(ROOT, ref.file)) && !titlesIn(ref.file).has(ref.title))
    .map(ref => `decision ${r.n} -> ${ref.file} "${ref.title}"`))
  assert.deepEqual(gone, [], 'a decision names a test that has been renamed or removed')
})
