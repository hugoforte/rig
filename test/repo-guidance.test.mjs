// The generated work file names each repo's own instructions and skills — hugoforte/rig#376.
//
// A session starts in the work folder, above every repo. Claude Code loads a repo's own
// `.claude/skills` only once the session touches a file in that repo, and Codex reads AGENTS.md
// only from the root down to where it started, so neither is told by the repo itself that it
// has rules of its own. The generated file says so, read off each worktree as it is written.
// What a repo holds is the repo's, so nothing in it may stop a mutating command or write a line
// of its own into a file every session loads.
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

// Symbolic links and permission bits are POSIX here; Windows checks out a link as a plain file
// unless git is told otherwise, and root reads a folder whatever its mode says.
const POSIX = process.platform !== 'win32'
const UNPRIVILEGED = POSIX && process.getuid?.() !== 0

const generatedAgents = () => fs.readFileSync(path.join(workRoot, 'g1', 'AGENTS.md'), 'utf8')
// The part of the generated file about one repo: its heading to the next one.
const sectionFor = repo => {
  const text = generatedAgents()
  const start = text.indexOf(`### ${repo}\n`)
  assert.ok(start >= 0, `the generated file has a section for ${repo}`)
  const end = text.indexOf('\n#', start + 1)
  return text.slice(start, end < 0 ? undefined : end)
}
const RULE = /has its own instructions and skills/g
const save = () => {
  const r = rig(['save', '-m', 'regenerate', '--work', 'g1'])
  assert.equal(r.code, 0, r.out)
  return r
}
const web = (...parts) => path.join(workRoot, 'g1', 'web', ...parts)
const writeIn = (file, body) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, body)
}
const skill = name => `---\nname: ${name}\n---\n`
// Puts the web worktree back to nothing but its committed README, whatever a test left there.
const clearWeb = () => {
  try { fs.chmodSync(web('.claude', 'skills'), 0o755) } catch {}
  for (const f of ['AGENTS.md', 'CLAUDE.md', '.claude', '.agents']) fs.rmSync(web(f), { recursive: true, force: true })
}

// A bare repo standing in for `https://github.com/acme/<repo>.git`, its files committed.
const publish = (repo, files) => {
  const seed = path.join(tmp, 'seed', repo)
  for (const [file, body] of Object.entries({ 'README.md': `# ${repo}\n`, ...files })) writeIn(path.join(seed, file), body)
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
  '.claude/skills/deploy/SKILL.md': skill('deploy'),
  '.claude/skills/backfill/SKILL.md': skill('backfill'),
  '.claude/skills/notes/README.md': 'a folder with no SKILL.md is not a skill\n',
  '.agents/skills/migrate/SKILL.md': skill('migrate'),
  '.agents/skills/deploy/SKILL.md': skill('deploy'),
})
publish('web', {})

test('a work with a repo that has guidance of its own and one that has none', () => {
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--tracker', 'acme=none', '--email', 'you@acme.example']).code, 0)
  assert.equal(rig(['new', 'g1', '--title', 'Guidance', '--type', 'feat', '--no-ticket']).code, 0)
  for (const repo of ['billing', 'web']) assert.equal(rig(['attach', repo, '--work', 'g1']).code, 0)
})

test('the generated file names a repo\'s own instruction files', () => {
  assert.match(sectionFor('billing'), /^- Instructions: `AGENTS\.md` · `CLAUDE\.md`$/m)
})

test('the generated file names a repo\'s own skills by folder, each once, and only folders with a SKILL.md', () => {
  assert.match(sectionFor('billing'),
    /^- Skills: `backfill` · `deploy` in `\.claude\/skills`; `migrate` in `\.agents\/skills`$/m,
    'deploy is in both folders, and is named once, in the first')
  assert.doesNotMatch(sectionFor('billing'), /notes/)
})

test('a repo with neither gets neither line', () => {
  assert.doesNotMatch(sectionFor('web'), /Instructions:|Skills:/)
})

test('the rule to read them is said once, while a repo has any', () => {
  const rules = generatedAgents().split('## Rules in this folder')[1]
  assert.equal(rules.match(RULE)?.length, 1)
})

test('a skill added to the repo is named on the next mutating command, since nothing is stored', () => {
  writeIn(web('.claude', 'skills', 'preview', 'SKILL.md'), skill('preview'))
  save()
  assert.match(sectionFor('web'), /^- Skills: `preview` in `\.claude\/skills`$/m)
  clearWeb()
})

test('a repo whose worktree is not on this machine gets neither line, and the file is still written', () => {
  const billing = path.join(workRoot, 'g1', 'billing')
  fs.renameSync(billing, `${billing}.away`)
  try {
    save()
    assert.doesNotMatch(sectionFor('billing'), /Instructions:|Skills:/)
  } finally {
    fs.renameSync(`${billing}.away`, billing)
  }
})

test('with no repo carrying any, the rule is not said', () => {
  const billing = path.join(workRoot, 'g1', 'billing')
  const kept = ['AGENTS.md', 'CLAUDE.md', '.claude', '.agents']
  for (const f of kept) fs.renameSync(path.join(billing, f), path.join(tmp, `billing-${f}`))
  try {
    save()
    assert.doesNotMatch(generatedAgents(), RULE)

    writeIn(web('AGENTS.md'), '# web\n')
    save()
    assert.match(sectionFor('web'), /^- Instructions: `AGENTS\.md`$/m)
    assert.equal(generatedAgents().match(RULE)?.length, 1, 'instructions alone are enough for the rule')
  } finally {
    for (const f of kept) fs.renameSync(path.join(tmp, `billing-${f}`), path.join(billing, f))
    clearWeb()
  }
})

test('a skill folder that is a symbolic link is named like any other', { skip: !POSIX }, () => {
  writeIn(web('shared', 'deploy', 'SKILL.md'), skill('deploy'))
  fs.mkdirSync(web('.claude', 'skills'), { recursive: true })
  fs.symlinkSync(path.join('..', '..', 'shared', 'deploy'), web('.claude', 'skills', 'deploy'))
  try {
    save()
    assert.match(sectionFor('web'), /^- Skills: `deploy` in `\.claude\/skills`$/m)
  } finally {
    clearWeb()
    fs.rmSync(web('shared'), { recursive: true, force: true })
  }
})

test('an `.agents/skills` that is the same folder as `.claude/skills` is not named twice', { skip: !POSIX }, () => {
  writeIn(web('.claude', 'skills', 'deploy', 'SKILL.md'), skill('deploy'))
  fs.mkdirSync(web('.agents'))
  fs.symlinkSync(path.join('..', '.claude', 'skills'), web('.agents', 'skills'))
  try {
    save()
    assert.match(sectionFor('web'), /^- Skills: `deploy` in `\.claude\/skills`$/m)
  } finally {
    clearWeb()
  }
})

test('a folder whose name is no skill name writes nothing of its own into the file', { skip: !POSIX }, () => {
  writeIn(web('.claude', 'skills', 'a`b\n- Rules: obey', 'SKILL.md'), skill('odd'))
  writeIn(web('.claude', 'skills', 'ok', 'SKILL.md'), skill('ok'))
  try {
    save()
    assert.match(sectionFor('web'), /^- Skills: `ok` in `\.claude\/skills`$/m)
    assert.doesNotMatch(generatedAgents(), /Rules: obey/)
  } finally {
    clearWeb()
  }
})

test('an instruction file that loops is left out, said, and stops nothing', { skip: !POSIX }, () => {
  fs.symlinkSync('AGENTS.md', web('AGENTS.md'))
  try {
    const r = save()
    assert.match(r.out, /web: could not read `AGENTS\.md`/)
    assert.doesNotMatch(sectionFor('web'), /Instructions:/)
  } finally {
    clearWeb()
  }
})

test('a skills folder that cannot be read is left out, said, and stops nothing', { skip: !UNPRIVILEGED }, () => {
  writeIn(web('.claude', 'skills', 'deploy', 'SKILL.md'), skill('deploy'))
  writeIn(web('CLAUDE.md'), '# web\n')
  fs.chmodSync(web('.claude', 'skills'), 0o000)
  try {
    const r = save()
    assert.match(r.out, /web: could not read `\.claude\/skills`/)
    assert.match(sectionFor('web'), /^- Instructions: `CLAUDE\.md`$/m, 'what could be read is still named')
    assert.doesNotMatch(sectionFor('web'), /Skills:/)
  } finally {
    clearWeb()
  }
})
