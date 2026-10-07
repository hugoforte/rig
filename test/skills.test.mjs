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

test('rig ships its entry-point skill', () => {
  assert.ok(skills.includes('rig'), `skills/ holds ${skills.join(', ')}`)
})

test('every skill rig sends someone to is one it ships', () => {
  // rig names its skills in what it prints and in the entry point. A skill renamed or removed
  // without them would leave rig pointing at nothing, and no list here to fall out of date.
  const sources = [
    ...fs.readdirSync(path.join(ROOT, 'bin')).filter(f => f.endsWith('.mjs')).map(f => path.join(ROOT, 'bin', f)),
    path.join(SKILLS, 'rig', 'SKILL.md'),
  ]
  const named = new Set(sources.flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/\b(rig-[a-z-]+)`? skill\b/g)].map(m => m[1])))
  assert.ok(named.size > 0, 'rig names at least one skill, or this reads nothing')
  for (const name of named) assert.ok(skills.includes(name), `${name} is named, and skills/ holds ${skills.join(', ')}`)
})

for (const name of skills) {
  test(`skills/${name} is a skill a host can link: SKILL.md, name equal to the folder, a description`, () => {
    const fm = frontmatter(path.join(SKILLS, name, 'SKILL.md'))
    assert.equal(fm.name, name)
    assert.ok(fm.description, 'a description, which is what a host triggers on')
    assert.ok(name === 'rig' || name.startsWith('rig-'), 'the bare name is the entry point; everything else is rig-*')
  })
}

test('every skill rig ships but the entry point sends its reply to AGENTS.md\'s Replying to the user (#325)', () => {
  // The entry point reads AGENTS.md in full; the others are loaded on their own, often outside a
  // work folder, where no generated file says it.
  for (const name of skills.filter(n => n !== 'rig')) {
    assert.match(fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8'), /`AGENTS\.md`'s "Replying to the user"/, `skills/${name} points at it`)
  }
})

test('the stops are listed once, in AGENTS.md, and the skill and prompts that stop point there', () => {
  // A work chooses which gates it stops at, so a list of stops copied into each prompt would be
  // one more place to go wrong the day the list changes.
  assert.match(fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8'), /^## Stops$/m)
  for (const file of ['skills/rig/SKILL.md', 'prompts/new-work.md', 'prompts/select-repos.md']) {
    assert.match(fs.readFileSync(path.join(ROOT, file), 'utf8'), /AGENTS\.md`?'s "Stops"/, `${file} points at the list`)
  }
})

test('every prompt rig sends someone to is one it ships', () => {
  const prompts = fs.readdirSync(path.join(ROOT, 'prompts')).map(f => f.replace(/\.md$/, ''))
  const sources = [
    ...fs.readdirSync(path.join(ROOT, 'bin')).filter(f => f.endsWith('.mjs')).map(f => path.join(ROOT, 'bin', f)),
    path.join(SKILLS, 'rig', 'SKILL.md'),
    path.join(ROOT, 'AGENTS.md'),
  ]
  const named = new Set(sources.flatMap(f => [...fs.readFileSync(f, 'utf8').matchAll(/rig prompt ([a-z][a-z-]*)/g)].map(m => m[1])))
  assert.ok(named.has('pickup'), 'the pickup is sent to its prompt')
  for (const name of named) assert.ok(prompts.includes(name), `rig prompt ${name} is named, and prompts/ holds ${prompts.join(', ')}`)
})
