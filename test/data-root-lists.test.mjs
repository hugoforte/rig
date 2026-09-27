// Every place rig lists what a data root holds names all of it.
//
// The data root's contents are listed in six places, in two vocabularies: paths where the
// reader is looking at the tree, prose where they are reading about it. When the org doc added
// `orgs/`, four of the six were missed and only an adversarial review found them — prose that
// goes stale says nothing, so the lists are checked rather than trusted.
//
// Each list is found by an anchor in the text around it. A list this file cannot find fails,
// rather than passing on nothing: a reworded sentence has to be pointed at again here, on the
// pull request that reworded it.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { SRC } from './harness.mjs'

const PATHS = ['catalog/', 'orgs/', 'work/', 'rig.json']
const PROSE = ['catalogue', 'org docs', 'work records', 'rig.json']

// The text from the first line matching `from` up to, not including, the next line matching
// `to` — or just that line when there is no `to`.
const slice = (file, from, to) => {
  const lines = fs.readFileSync(path.join(SRC, file), 'utf8').split(/\r?\n/)
  const start = lines.findIndex(l => from.test(l))
  assert.notEqual(start, -1, `${file}: no line matches ${from} — point this test at where the list went`)
  if (!to) return lines[start]
  const end = lines.findIndex((l, i) => i > start && to.test(l))
  assert.notEqual(end, -1, `${file}: nothing after ${from} matches ${to}`)
  return lines.slice(start, end).join('\n')
}

const LISTS = [
  { where: 'AGENTS.md, the three roots', names: PATHS, text: () => slice('AGENTS.md', /^\| the data root \|/) },
  { where: 'DESIGN.md §3, the on-disk layout', names: PATHS, text: () => slice('DESIGN.md', /^D:\\rig-data\\/, /^D:\\w\\/) },
  { where: 'DESIGN.md §9, publishing this repo', names: PATHS, text: () => slice('DESIGN.md', /^- \*\*Publishing this repo\*\*/, /^- |^$/) },
  { where: 'README.md, the three-roots diagram', names: PATHS, text: () => slice('README.md', /subgraph data\[/, /^\s+end$/) },
  { where: 'the README `rig init` writes into a new data root', names: PROSE, text: () => slice('bin/rig.mjs', /^The data root for \[rig\]/) },
  { where: 'the rig skill', names: PROSE, text: () => slice('skills/rig/SKILL.md', /a committed checkout holding/) },
]

for (const { where, names, text } of LISTS) {
  test(`${where} names everything a data root holds`, () => {
    const found = text()
    assert.deepEqual(names.filter(n => !found.includes(n)), [], `${where} leaves these out`)
  })
}
