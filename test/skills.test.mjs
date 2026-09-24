// The agent skills rig ships, under skills/<name>/SKILL.md. rig links none of them anywhere —
// which agent hosts a machine runs is that machine's business — so what this checks is the
// contract a host's linker relies on: a folder per skill, a SKILL.md in it whose `name` is the
// folder's, and a description for the host to trigger on. `rig` is the entry point and carries
// the bare name; every other skill is prefixed `rig-`, so a host's skill list says at a glance
// which came from here.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILLS = path.join(ROOT, 'skills')

const frontmatter = file => {
  const text = fs.readFileSync(file, 'utf8')
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/)
  assert.ok(m, `${file} opens with a frontmatter block`)
  return Object.fromEntries(m[1].split(/\r?\n/).map(line => {
    const [key, ...rest] = line.split(':')
    return [key.trim(), rest.join(':').trim()]
  }))
}

const skills = fs.readdirSync(SKILLS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)

test('rig ships the entry-point skill and the handoff', () => {
  assert.deepEqual(skills.sort(), ['rig', 'rig-handoff'])
})

for (const name of skills) {
  test(`skills/${name} is a skill a host can link: SKILL.md, name equal to the folder, a description`, () => {
    const fm = frontmatter(path.join(SKILLS, name, 'SKILL.md'))
    assert.equal(fm.name, name)
    assert.ok(fm.description, 'a description, which is what a host triggers on')
    assert.ok(name === 'rig' || name.startsWith('rig-'), 'the bare name is the entry point; everything else is rig-*')
  })
}
