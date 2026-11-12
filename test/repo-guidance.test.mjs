// The generated work file names each repo's own instructions and skills — hugoforte/rig#376.
//
// A session starts in the work folder, above every repo. Claude Code loads a repo's own
// `.claude/skills` only once the session touches a file in that repo, and Codex reads AGENTS.md
// only from the root down to where it started, so neither is told by the repo itself that it
// has rules of its own. The generated file says so, read off each worktree as it is written.
//
// `RIG_FAKE_REMOTES` makes the mirror and the worktrees real git, only local; test/harness.mjs
// builds the installation, and the tests run in order on one work.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { makeInstall } from './harness.mjs'

const { tmp, dataRoot, workRoot, remotesDir, rig, gitMust, cleanup } = makeInstall({
  inProcess: true,
  prefix: 'rig-guidance-',
  remotes: true,
  github: { auth: 'ok', repos: { 'acme/billing': { language: 'JavaScript' }, 'acme/web': { language: 'TypeScript' } } },
})

after(cleanup)

const generatedAgents = () => fs.readFileSync(path.join(workRoot, 'g1', 'AGENTS.md'), 'utf8')
// The part of the generated file about one repo: its heading to the next one.
const sectionFor = repo => {
  const text = generatedAgents()
  const start = text.indexOf(`### ${repo}\n`)
  assert.ok(start >= 0, `the generated file has a section for ${repo}`)
  const end = text.indexOf('\n#', start + 1)
  return text.slice(start, end < 0 ? undefined : end)
}

// A bare repo standing in for `https://github.com/acme/<repo>.git`, its files committed.
const publish = (repo, files) => {
  const seed = path.join(tmp, 'seed', repo)
  for (const [file, body] of Object.entries({ 'README.md': `# ${repo}\n`, ...files })) {
    fs.mkdirSync(path.dirname(path.join(seed, file)), { recursive: true })
    fs.writeFileSync(path.join(seed, file), body)
  }
  gitMust(seed, 'init', '-q', '-b', 'main')
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = path.join(remotesDir, 'acme', `${repo}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
}

publish('billing', {
  'AGENTS.md': '# billing\n',
  'CLAUDE.md': 'See AGENTS.md.\n',
  '.claude/skills/deploy/SKILL.md': '---\nname: deploy\n---\n',
  '.claude/skills/backfill/SKILL.md': '---\nname: backfill\n---\n',
  '.claude/skills/notes/README.md': 'a folder with no SKILL.md is not a skill\n',
  '.agents/skills/migrate/SKILL.md': '---\nname: migrate\n---\n',
})
publish('web', {})

test('a work with a repo that has guidance of its own and one that has none', () => {
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example']).code, 0)
  assert.equal(rig(['new', 'g1', '--title', 'Guidance', '--type', 'feat', '--no-ticket']).code, 0)
  for (const repo of ['billing', 'web']) assert.equal(rig(['attach', repo, '--work', 'g1']).code, 0)
})

test('the generated file names a repo\'s own instruction files', () => {
  assert.match(sectionFor('billing'), /^- Instructions: `AGENTS\.md` · `CLAUDE\.md`/m)
})

test('the generated file names a repo\'s own skills, by where each one lives, and only folders with a SKILL.md', () => {
  assert.match(sectionFor('billing'),
    /^- Skills: `\.claude\/skills\/backfill` · `\.claude\/skills\/deploy` · `\.agents\/skills\/migrate`$/m)
  assert.doesNotMatch(sectionFor('billing'), /notes/)
})

test('a repo with neither gets neither line', () => {
  assert.doesNotMatch(sectionFor('web'), /Instructions:|Skills:/)
})

test('the rule to read them is said once, while a repo has any', () => {
  const rules = generatedAgents().split('## Rules in this folder')[1]
  assert.equal(rules.match(/its own instructions and skills/g)?.length, 1)
})

test('a skill added to the repo is named on the next mutating command, since nothing is stored', () => {
  const skill = path.join(workRoot, 'g1', 'web', '.claude', 'skills', 'preview', 'SKILL.md')
  fs.mkdirSync(path.dirname(skill), { recursive: true })
  fs.writeFileSync(skill, '---\nname: preview\n---\n')
  assert.equal(rig(['save', '-m', 'touch', '--work', 'g1']).code, 0)
  assert.match(sectionFor('web'), /^- Skills: `\.claude\/skills\/preview`$/m)
})

test('a repo whose worktree is not on this machine gets neither line, and the file is still written', () => {
  const billing = path.join(workRoot, 'g1', 'billing')
  fs.renameSync(billing, `${billing}.away`)
  try {
    assert.equal(rig(['save', '-m', 'away', '--work', 'g1']).code, 0)
    assert.doesNotMatch(sectionFor('billing'), /Instructions:|Skills:/)
  } finally {
    fs.renameSync(`${billing}.away`, billing)
  }
})

test('with no repo carrying any, the rule is not said', () => {
  fs.rmSync(path.join(workRoot, 'g1', 'web', '.claude'), { recursive: true, force: true })
  for (const f of ['AGENTS.md', 'CLAUDE.md', '.claude', '.agents']) {
    fs.renameSync(path.join(workRoot, 'g1', 'billing', f), path.join(tmp, `billing-${f}`))
  }
  try {
    assert.equal(rig(['save', '-m', 'bare', '--work', 'g1']).code, 0)
    assert.doesNotMatch(generatedAgents(), /its own instructions and skills/)
  } finally {
    for (const f of ['AGENTS.md', 'CLAUDE.md', '.claude', '.agents']) {
      fs.renameSync(path.join(tmp, `billing-${f}`), path.join(workRoot, 'g1', 'billing', f))
    }
  }
})
