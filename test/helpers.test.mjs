import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  parseArgs, parseFrontmatter, parseTrackerFlag, isJiraKey, isGithubKey, slug, trackerFor, RigError,
  anyTrackerConfigured, orgForJiraKey, ticketsLabel, statusLine,
  spawnDefaults, refreshSpawn, parseDf, bytesFree, freeSpace, realGitFor, activityAt, relativeAge, prTiming, terminalPr, branchFirstCommitAt, sinceFlag,
  baseLabel, baseMoved, directionSection, directionBody, directionIsTodo,
} from '../bin/rig.mjs'

test('parseArgs: values, booleans, and a positional after a boolean flag', () => {
  const { flags, positional } = parseArgs(['new', '--ticket', 'my-id', '--title', 'T', '--type=chore', '--force'])
  assert.deepEqual(positional, ['new', 'my-id'])
  assert.equal(flags.ticket, true)
  assert.equal(flags.title, 'T')
  assert.equal(flags.type, 'chore')
  assert.equal(flags.force, true)
})

test('parseArgs: a value flag at the end is true, not undefined', () => {
  assert.equal(parseArgs(['--email']).flags.email, true)
})

test('parseArgs: -m is --message, and a short flag is never eaten as another flag\'s value', () => {
  const { flags, positional } = parseArgs(['save', '-m', 'design agreed', '--designed'])
  assert.deepEqual(positional, ['save'])
  assert.equal(flags.message, 'design agreed')
  assert.equal(flags.designed, true)
  const swapped = parseArgs(['save', '--work', '-m', 'note']).flags
  assert.equal(swapped.work, true, '--work sees a flag next, not a value')
  assert.equal(swapped.message, 'note')
})

test('parseArgs: an unknown short flag fails rather than swallowing a positional', () => {
  assert.throws(() => parseArgs(['detach', '-f', 'billing']), /unknown flag -f/)
})

test('parseFrontmatter: scalars, an empty list, and a list of objects', () => {
  const { data, body } = parseFrontmatter(`---
repo: billing
org: acme
setup: []
talks_to:
  - repo: orders-api
    how: emits OrderReturned
  - repo: orders-web
---

Prose here.`)
  assert.equal(data.repo, 'billing')
  assert.deepEqual(data.setup, [])
  assert.deepEqual(data.talks_to, [{ repo: 'orders-api', how: 'emits OrderReturned' }, { repo: 'orders-web' }])
  assert.equal(body.trim(), 'Prose here.')
})

test('parseFrontmatter: no frontmatter means empty data and the whole text as body', () => {
  const { data, body } = parseFrontmatter('just text')
  assert.deepEqual(data, {})
  assert.equal(body, 'just text')
})

test('isJiraKey: upper-case PROJECT-number only', () => {
  assert.ok(isJiraKey('PROJ-42'))
  assert.ok(!isJiraKey('proj-42'))
  assert.ok(!isJiraKey('PROJ-42-slug'))
})

test('isGithubKey: owner/repo#number only', () => {
  assert.ok(isGithubKey('acme/platform#7'))
  assert.ok(!isGithubKey('platform#7'))
  assert.ok(!isGithubKey('acme/platform'))
})

test('slug: lower-case, dashed, bounded', () => {
  assert.equal(slug('Refunds double-charge on retry!'), 'refunds-double-charge-on-retry')
  assert.equal(slug('x'.repeat(80)).length, 48)
})

test('parseTrackerFlag: every kind, merged into one object', () => {
  assert.deepEqual(parseTrackerFlag('a=github:acme/platform,b=jira:PROJ,c=none'), {
    a: { kind: 'github', repo: 'acme/platform' },
    b: { kind: 'jira', project: 'PROJ' },
    c: { kind: 'none' },
  })
})

test('parseTrackerFlag: rejects bad shapes with a RigError', () => {
  for (const bad of ['a=github', 'a=github:noslash', 'a=jira:proj', 'a=none:junk', 'a=svn:x', 'nonsense']) {
    assert.throws(() => parseTrackerFlag(bad), RigError, bad)
  }
})

const oneTracker = { tracker: { a: { kind: 'github', repo: 'x/y' }, b: { kind: 'none' } } }
const twoTrackers = { tracker: { a: { kind: 'github', repo: 'x/y' }, b: { kind: 'jira', project: 'P' } } }

test('trackerFor: the only live tracker wins without --org', () => {
  assert.deepEqual(trackerFor(oneTracker), { org: 'a', kind: 'github', repo: 'x/y' })
})

test('trackerFor: several live trackers need --org', () => {
  assert.throws(() => trackerFor(twoTrackers), /pass --org/)
  assert.equal(trackerFor(twoTrackers, 'b').project, 'P')
})

test('trackerFor: none configured, or an unknown --org, dies', () => {
  assert.throws(() => trackerFor({ tracker: {} }), /no tracker configured/)
  assert.throws(() => trackerFor(twoTrackers, 'zzz'), /no tracker configured for org/)
})

test('anyTrackerConfigured: true when any org has a live tracker, false for none/absent', () => {
  assert.equal(anyTrackerConfigured({ tracker: { a: { kind: 'github', repo: 'x/y' } } }), true)
  assert.equal(anyTrackerConfigured({ tracker: { a: { kind: 'none' } } }), false)
  assert.equal(anyTrackerConfigured({ tracker: {} }), false)
  assert.equal(anyTrackerConfigured({}), false)
})

test('orgForJiraKey: the org whose tracker project matches the key\'s prefix', () => {
  const cfg = { tracker: { linenmaster: { kind: 'jira', project: 'KTLO' }, acme: { kind: 'github', repo: 'x/y' } } }
  assert.equal(orgForJiraKey(cfg, 'KTLO-42'), 'linenmaster')
  assert.equal(orgForJiraKey(cfg, 'OTHER-1'), null)
  assert.equal(orgForJiraKey(cfg, 'acme/platform#3'), null, 'not a Jira key at all')
})

test('orgForJiraKey: null (not a guess) when two orgs claim the same project', () => {
  const cfg = { tracker: { a: { kind: 'jira', project: 'KTLO' }, b: { kind: 'jira', project: 'KTLO' } } }
  assert.equal(orgForJiraKey(cfg, 'KTLO-1'), null)
})

test('ticketsLabel: keys joined, declined, or the placeholder', () => {
  assert.equal(ticketsLabel({ tickets: ['PROJ-1', 'PROJ-2'] }), 'PROJ-1, PROJ-2')
  assert.equal(ticketsLabel({ tickets: [], ticketsDeclined: true }), 'none (declined)')
  assert.equal(ticketsLabel({ tickets: [] }), '_none_')
})

test('statusLine: what a document may carry, which is only what the record can prove', () => {
  // `nextStatusAfterAttach` went with the stored field: "repos attached" was one of the two
  // values that were an observable fact written down, and `phaseOf` reads it off `repos`.
  assert.equal(statusLine({ repos: [] }), 'Planning')
  assert.equal(statusLine({ repos: [{ repo: 'a' }] }), 'Designing')
  assert.equal(statusLine({ repos: [{ repo: 'a' }], designedAt: '2026-09-19T10:00:00.000Z' }),
    'Building (design agreed 2026-09-19)')
  assert.equal(statusLine({ repos: [], closedAt: '2026-09-19T10:00:00.000Z' }), 'Closed')
})

// These assert options rather than behaviour, deliberately. Each field is a contract with
// the operating system whose only symptom is cost, and the cost does not show on an idle
// machine — the refresh that took forty seconds under load and hung a desktop finished inside
// its deadline when nothing else was running, so the behavioural test went green on exactly
// the machines that were fine. A wrong option here is not a refactor; it is the regression.
// The fetch's own option, `GIT_TERMINAL_PROMPT`, is asserted the same way in
// `test/checkouts.test.mjs`, where the operation it guards now lives.
test('only the console-less run hides its spawns, because a hidden console is a whole process', () => {
  // `CREATE_NO_WINDOW` does not suppress a console, it allocates a hidden one — a
  // `conhost.exe` per spawn, and a process creation on Windows is ~17ms. Set on everything it
  // was doubling the price of every git call to hide a console the command already had.
  assert.equal(spawnDefaults('status').windowsHide, false,
    'an ordinary command has a console its children inherit, and must not buy a second one')
  assert.equal(spawnDefaults('freshness-refresh').windowsHide, true,
    'the detached child has none to inherit, and every git call it makes would pop a window')
})

// Windows only: everywhere else `git` is the binary and there is nothing to step past. The
// programs are empty files, because which `git` rig runs is decided from where files are and
// never from what is in them.
const onWindows = { skip: process.platform !== 'win32' }
const programTree = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-gitpath-'))
  const layout = (name, ...parts) => {
    const p = path.join(root, name, ...parts)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, '')
    return p
  }
  return { root, layout }
}

test('the Git for Windows launcher is stepped past, and nobody else\'s git is', onWindows, () => {
  // The saving is real — 60ms through the launcher against 32ms straight to the binary, on
  // every git call — but the risk is that somebody's own `git` is a program they put on PATH
  // deliberately. So the launcher is *recognised*, never assumed: the right layout, with the
  // real binary actually sitting where that layout says it would.
  const { root, layout } = programTree()
  const proper = path.dirname(layout('proper', 'cmd', 'git.exe'))
  const real = layout('proper', 'mingw64', 'bin', 'git.exe')
  assert.equal(realGitFor(proper), real, 'the launcher names the binary it would have started')

  const bin = path.dirname(layout('bin-layout', 'bin', 'git.exe'))
  const binReal = layout('bin-layout', 'mingw64', 'bin', 'git.exe')
  assert.equal(realGitFor(bin), binReal, 'Git for Windows puts a launcher in bin\\ as well as cmd\\')

  const headless = path.dirname(layout('headless', 'cmd', 'git.exe'))
  assert.equal(realGitFor(headless), 'git', 'the layout without the binary in it proves nothing')

  const shim = path.dirname(layout('shim', 'tools', 'git.exe'))
  layout('shim', 'mingw64', 'bin', 'git.exe')
  assert.equal(realGitFor(shim), 'git',
    'a git somewhere of its own is a program someone meant to put there')
  assert.equal(realGitFor([shim, proper].join(';')), 'git',
    'and one ahead of the launcher on PATH is the git a spawn runs, whatever comes after it')

  assert.equal(realGitFor(path.join(root, 'nothing-here')), 'git', 'and no git on PATH is left to fail as it always did')
  fs.rmSync(root, { recursive: true, force: true })
})

test('PATH is searched as a spawn searches it, and an entry it cannot read that way ends the search', onWindows, () => {
  // Node's spawn strips one pair of quotes from an entry and tries `git.com`, then `git.exe`,
  // and nothing else. Reading PATH any other way walks past the directory the spawn takes its
  // git from, on to a layout further along that is somebody else's git.
  const { root, layout } = programTree()
  const proper = path.dirname(layout('proper', 'cmd', 'git.exe'))
  const real = layout('proper', 'mingw64', 'bin', 'git.exe')
  const own = path.dirname(layout('own', 'git.exe'))
  const script = path.dirname(layout('script', 'git.bat'))
  const split = path.dirname(layout('semi;colon', 'git.exe'))
  const searching = (...entries) => realGitFor(entries.join(';'))

  assert.equal(searching(`"${own}"`, proper), 'git', 'a quoted entry is still where the spawn finds its git')
  assert.equal(searching(`"${proper}"`), real, 'and a quoted launcher is still the launcher')
  assert.equal(searching(script, proper), real, 'a git.bat is not a program the spawn would start')
  assert.equal(searching('relative', proper), 'git',
    'a relative entry is read against where the run stands, which is no part of this answer')
  assert.equal(searching(`"${split}"`, proper), 'git',
    'a quoted entry holding a ; is one directory to the spawn, and not one this reads')
  fs.rmSync(root, { recursive: true, force: true })
})

test('with MSYSTEM set the launcher is kept, because it is what gives git its own PATH', onWindows, () => {
  const { root, layout } = programTree()
  const proper = path.dirname(layout('proper', 'cmd', 'git.exe'))
  layout('proper', 'mingw64', 'bin', 'git.exe')
  assert.equal(realGitFor(proper, 'MINGW64'), 'git',
    'the binary sets up its PATH only when MSYSTEM is unset, so here it could not start a hook')
  fs.rmSync(root, { recursive: true, force: true })
})

test('the freshness refresh is detached, silent, rooted in the tool, and hidden', () => {
  const spawn = refreshSpawn('C:\\rig', { PATH: 'somewhere' })
  assert.equal(spawn.detached, true, 'the fetch has to outlive the command that armed it')
  assert.equal(spawn.stdio, 'ignore', 'a child holding the pipe stops `rig prompt` ever closing')
  assert.equal(spawn.windowsHide, true, 'see above; this is the one that hung a machine')
  assert.equal(spawn.cwd, 'C:\\rig', 'a child sitting in a worktree is one `rig close` cannot remove')
  assert.deepEqual(spawn.env, { PATH: 'somewhere' },
    'the run that armed it decides what it may reach, not the process that happened to host it')
})

// Off Windows, `df -Pk` carries the whole check and its output is the only part with anything
// to get wrong. The samples below are real output.
test('parseDf: GNU df -Pk', () => {
  const out = [
    'Filesystem     1024-blocks     Used Available Capacity Mounted on',
    '/dev/root         76026616 30988716  45021516      41% /',
  ].join('\n')
  assert.deepEqual(parseDf(out), { label: '/', bytes: 45021516 * 1024 })
})

test('parseDf: BSD df -Pk, as macOS answers', () => {
  const out = [
    'Filesystem 1024-blocks      Used Available Capacity  Mounted on',
    '/dev/disk3s1s1  483816524  10012345 219876543    5%    /',
  ].join('\n')
  assert.equal(parseDf(out).bytes, 219876543 * 1024)
})

test('parseDf: a mount point with spaces is the rest of the line, not one column', () => {
  const out = [
    'Filesystem     1024-blocks     Used Available Capacity Mounted on',
    '/dev/sdb1         41922560  1048576  40873984       3% /mnt/my disk',
  ].join('\n')
  assert.equal(parseDf(out).label, '/mnt/my disk')
})

test('parseDf: output it cannot read is null, so the check is dropped rather than wrong', () => {
  assert.equal(parseDf(''), null, 'no rows at all')
  assert.equal(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on'), null, 'a header and nothing else')
  assert.equal(parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/sda1 - - - - /'), null,
    'columns that are not numbers')
})

test('bytesFree: the blocks this user may still write, in bytes', () => {
  // Every count different, so reading the wrong one fails: `bfree` differs from `bavail`
  // wherever blocks are held back, `blocks` is the size of the disk, and a count on its own is
  // not bytes.
  assert.equal(bytesFree({ bavail: 10, bfree: 20, blocks: 100, bsize: 4096 }), 40960)
})

test('freeSpace: a real directory answers with bytes and the volume it measured', () => {
  const s = freeSpace(os.tmpdir())
  assert.ok(s, 'the temp directory is on a disk this machine can report on')
  assert.ok(Number.isFinite(s.bytes) && s.bytes > 0, `implausible free space: ${s.bytes}`)
  assert.ok(s.label, 'something to name the volume in the report')
  if (process.platform === 'win32') assert.match(s.label, /^[A-Za-z]:$/, 'the drive is the answer on Windows')
})

test('freeSpace: a work root junctioned onto another drive is labelled with that drive', t => {
  if (process.platform !== 'win32') return t.skip('drive letters are a Windows answer')
  // statfs follows the junction, so the number is the other drive's; a label taken from the
  // path as written names the drive that was not measured, and a user low on space goes and
  // clears the wrong one.
  const drive = p => path.parse(p).root.slice(0, 2).toUpperCase()
  const repo = path.dirname(fileURLToPath(import.meta.url))
  const elsewhere = [process.env.SystemRoot, repo].find(p => p && drive(p) !== drive(os.tmpdir()))
  if (!elsewhere) return t.skip('no second drive here for a junction to lead to')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-junction-'))
  const link = path.join(root, 'w')
  try {
    fs.symlinkSync(elsewhere, link, 'junction')
    assert.equal(freeSpace(link).label, drive(elsewhere))
  } finally {
    // The junction alone: what it leads to is not this test's to remove.
    if (fs.existsSync(link)) fs.unlinkSync(link)
    fs.rmdirSync(root)
  }
})

test('freeSpace: a path the filesystem will not report on is null, so the check is dropped', () => {
  // Decision 54: a work root that is not there, or one on a share nobody is connected to, is
  // a check rig cannot make. Dropped, never fatal — doctor is the command you run because
  // something is already broken.
  assert.equal(freeSpace(path.join(os.tmpdir(), 'rig-no-such-directory-8f3a1c')), null)
})

test('activityAt: the newest stamp the record already holds, whichever field it is on', () => {
  const at = t => `2026-03-0${t}T00:00:00.000Z`
  assert.equal(activityAt({ createdAt: at(1), repos: [{ attachedAt: at(2) }, { attachedAt: at(4) }] }), at(4),
    'a repo attached later than the work was created')
  assert.equal(activityAt({ createdAt: at(1), closedAt: at(5), repos: [{ attachedAt: at(4) }] }), at(5))
  assert.equal(activityAt({ createdAt: at(3), repos: [] }), at(3), 'a work with no repos still sorts')
  assert.equal(activityAt({ repos: [] }), '', 'a record with no stamps at all sorts first, and never throws')
})

test('relativeAge: buckets, and a stamp that is not one', () => {
  const ago = mins => new Date(Date.now() - mins * 60000).toISOString()
  assert.equal(relativeAge(ago(0)), 'just now')
  assert.equal(relativeAge(ago(5)), '5m ago')
  assert.equal(relativeAge(ago(150)), '2h ago')
  assert.equal(relativeAge(ago(60 * 24 * 3)), '3d ago')
  assert.equal(relativeAge(''), 'undated')
  assert.equal(relativeAge('not a date'), 'undated')
})

test('branchFirstCommitAt: the first commit the branch adds over its base', () => {
  // The state a throughput consumer meets constantly: work started, PR not opened yet.
  // With a PR this reads GitHub instead, because the branch is gone once it merges.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-first-'))
  const env = { ...process.env, GIT_CONFIG_GLOBAL: path.join(tmp, 'gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
  const commit = (dir, text) => {
    fs.writeFileSync(path.join(dir, 'a.md'), `${text}\n`)
    git(dir, 'add', '-A')
    assert.equal(git(dir, '-c', 'user.email=t@e.invalid', '-c', 'user.name=t', 'commit', '-q', '-m', text).status, 0)
    return git(dir, 'log', '-1', '--format=%H %aI').stdout.trim().split(' ')
  }
  try {
    const repo = path.join(tmp, 'repo'); fs.mkdirSync(repo)
    assert.equal(git(repo, 'init', '-q', '-b', 'main').status, 0)
    const [base] = commit(repo, 'base')
    // What a fetched remote-tracking ref would be, without a remote to fetch from.
    assert.equal(git(repo, 'update-ref', 'refs/remotes/origin/main', base).status, 0)
    assert.equal(git(repo, 'checkout', '-q', '-b', 'feat/x').status, 0)
    const [lower, firstDate] = commit(repo, 'the first commit of the work')
    const [, secondDate] = commit(repo, 'and a second')
    // The branch of the PR this one is stacked on, as a fetched remote-tracking ref.
    assert.equal(git(repo, 'update-ref', 'refs/remotes/origin/feat/lower', lower).status, 0)

    assert.equal(branchFirstCommitAt({ path: repo, base: 'main' }), firstDate,
      'the first of the branch commits, not the last and not the base')
    assert.equal(branchFirstCommitAt({ path: path.join(tmp, 'gone'), base: 'main' }), null,
      'a worktree that is not there is unknown, not an error')
    assert.equal(branchFirstCommitAt({ path: repo, base: 'no-such-base' }), null,
      'a base git cannot resolve answers nothing rather than the whole history')
    assert.equal(branchFirstCommitAt({ path: repo, base: 'main' }, 'feat/lower'), secondDate,
      'a stacked branch starts where the PR underneath it ends, not where main does')
    assert.equal(branchFirstCommitAt({ path: repo, base: 'main' }, 'feat/never-fetched'), firstDate,
      'a live base this checkout has never fetched falls back to the recorded one')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('baseLabel: the record alone when nothing disagrees with it', () => {
  assert.equal(baseLabel({ base: 'main', recordedBase: 'main' }), 'main')
  assert.equal(baseLabel({ base: 'trunk', recordedBase: 'trunk' }), 'trunk', 'the PR confirmed the record')
})

test('baseLabel: both bases when the PR lands somewhere the record does not know about', () => {
  // A bare `feat/other-work` would hide that the record still says `main`, which is the
  // thing a reader has to know before rebasing or closing.
  const stacked = { base: 'feat/other-work', recordedBase: 'main' }
  assert.equal(baseLabel(stacked), 'main → feat/other-work')
  assert.equal(baseMoved(stacked), true)
})

test('baseLabel: a refused lookup names the record as the record, never as the live base', () => {
  const refused = { base: 'main', recordedBase: 'main', prError: 'gh not found on PATH' }
  assert.equal(baseLabel(refused), 'main (recorded — GitHub would not say)')
  assert.equal(baseMoved(refused), false, 'nothing was confirmed, so nothing moved')
})

test('prTiming: a lookup GitHub refused is an error, never a work with no first commit', () => {
  // The whole point of the payload is measuring first commit to merge. A refused lookup
  // reported as `null` would silently drop the work from the numerator.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-first-err-'))
  try {
    const stateFile = path.join(tmp, 'github.json')
    fs.writeFileSync(stateFile, JSON.stringify({ auth: 'missing' }))
    process.env.RIG_FAKE_GITHUB = stateFile
    const answer = prTiming({ org: 'acme', repo: 'billing', base: 'main', path: path.join(tmp, 'gone') },
      { number: 12, state: 'MERGED' })
    assert.equal(answer.firstCommitAt, null)
    assert.match(answer.error, /gh not found on PATH/)

    // terminalPr is the narrow shape a MERGED pr is stored in (`rig close`, `rig backfill`):
    // the same refusal turns into "nothing to store", never a record built from guesses —
    // the no-negative-caching half of the contract. Reusing this test's GitHub, rather than
    // pointing `RIG_FAKE_GITHUB` at a second fixture: the adapter rig.mjs picks is resolved
    // once and memoized for the life of the process, so a second in-process fixture in this
    // file would be silently ignored.
    const { record, error } = terminalPr({ org: 'acme', repo: 'billing', base: 'main', path: path.join(tmp, 'gone') },
      { number: 12, url: 'u', state: 'MERGED', openedAt: 'o', mergedAt: 'm' })
    assert.equal(record, undefined)
    assert.match(error, /gh not found on PATH/)
  } finally {
    delete process.env.RIG_FAKE_GITHUB
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})

test('sinceFlag: a number of days, an ISO date, or a loud failure', () => {
  const days = new Date(sinceFlag('14d'))
  assert.ok(Math.abs((Date.now() - days) / 86400000 - 14) < 0.01, 'fourteen days back')
  assert.equal(sinceFlag('2026-03-01'), new Date('2026-03-01').toISOString())
  assert.equal(sinceFlag(undefined), null, 'no window asked for')
  assert.equal(sinceFlag(true), null, '--since with nothing after it is not a window')
  // A window nobody can parse, silently ignored, shows everything to someone who asked for
  // a fortnight — and they have no way to tell.
  assert.throws(() => sinceFlag('last tuesday'), /a number of days like 14d, or a date/)
  // `new Date('7')` is the year 2001, so the obvious slip for `7d` would otherwise pass.
  assert.throws(() => sinceFlag('7'), /a number of days like 14d, or a date/)
})

// ---------------------------------------------------------------- the Direction section

// `(?=^## |\Z)` looked like "the next heading, or end of input". `\Z` is not an end-of-input
// assertion in JavaScript — it is a literal `Z` — so the old expression lost a trailing
// Direction entirely and truncated any Direction containing a capital Z. Both were measured
// against the real data root: two of forty-six context docs, one losing 6,300 of 17,500
// characters at the word `listHostedZones`.

const doc = body => `# w\n\nTickets: none · Status: Designing\n\n## Problem\n\nthe brief\n\n## Direction\n\n${body}\n`

test('a Direction that is the last section is read, not lost', () => {
  assert.equal(directionBody(doc('Because the adjacent effort would have cost a third major.')),
    'Because the adjacent effort would have cost a third major.')
})

test('a Direction containing a capital Z is not truncated at it', () => {
  const prose = 'Mechanical: `listHostedZones` then `listResourceRecordSets`, in that order.'
  assert.equal(directionBody(doc(prose)), prose)
})

test('a Direction followed by another section stops at that section', () => {
  assert.equal(directionBody(`${doc('Agreed approach.')}\n## Status / Next steps\n\n- [ ] _next step_\n`),
    'Agreed approach.')
})

test('a document with no Direction section answers empty rather than throwing', () => {
  assert.equal(directionSection('# w\n\n## Problem\n\nthe brief\n'), '')
  assert.equal(directionBody(''), '')
})

test('the template guidance comments are stripped, and the scaffolded stub says nothing', () => {
  assert.equal(directionBody(doc('<!-- Why this approach; why NOT the adjacent effort. -->\n\n_TODO_')), '')
  assert.equal(directionIsTodo(doc('_TODO_')), true)
})

test('an unfinished checklist further down the document is not the Direction being a stub', () => {
  // The old test was `/^## Direction$[\s\S]*?^_TODO_$/m`, which finds a `_TODO_` anywhere below
  // the heading — so an agreed design with an open item three sections later read as undesigned.
  const agreed = `${doc('Agreed: derive the phase, store the gates.')}\n## Status / Next steps\n\n_TODO_\n`
  assert.equal(directionIsTodo(agreed), false)
  assert.equal(directionBody(agreed), 'Agreed: derive the phase, store the gates.')
})
