import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  versionFromTag, bumpFor, expectedVersion, checkBump, bumpOfRelease, pullsOf, releaseVerdict, releaseNotes, parseDescribe, releaseMark, PLACEHOLDER_VERSION,
} from '../bin/release.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

// A PR that would land as a minor: what `rig new --type feat` writes, and no labels.
const featPr = { branch: 'feat/name-the-release', labels: [] }

// One commit and every pull request GitHub associates with it, which is the shape the workflow
// gathers. `commit(sha, null)` is the commit it could name none for.
const commit = (sha, ...pulls) => ({ sha, pulls: pulls.filter(Boolean) })
const pr = (number, branch, labels = [], over = {}) => ({ number, title: `PR ${number}`, url: `u/${number}`, body: '', headRefName: branch, baseRefName: 'main', labels, ...over })

test('a tag names a version whether or not it wears the v', () => {
  assert.equal(versionFromTag('v1.2.3'), '1.2.3')
  assert.equal(versionFromTag('1.2.3'), '1.2.3')
})

test('anything that is not a release tag names no version', () => {
  for (const junk of ['v1.2', 'nightly', 'v1.2.3-rc1', '', null, undefined]) {
    assert.equal(versionFromTag(junk), null, `${JSON.stringify(junk)} is not a release tag`)
  }
})

test('the branch prefix rig already writes is the bump', () => {
  assert.equal(bumpFor(featPr).bump, 'minor')
  assert.equal(bumpFor({ branch: 'fix/doctor-exits-1-on-linux', labels: [] }).bump, 'patch')
})

test('a release label overrides the prefix, because the prefix is a default not a decree', () => {
  assert.equal(bumpFor({ ...featPr, labels: ['enhancement', 'release:patch'] }).bump, 'patch')
  assert.equal(bumpFor({ branch: 'fix/typo', labels: ['release:none'] }).bump, 'none')
})

test('the prefixes that ask for nothing say so, instead of needing a label each time', () => {
  for (const prefix of ['docs', 'chore', 'test', 'ci', 'refactor']) {
    assert.equal(bumpFor({ branch: `${prefix}/tidy-the-tests`, labels: [] }).bump, 'none', prefix)
  }
})

test('a branch prefix rig never writes asks for a label rather than guessing', () => {
  // Listing the none-prefixes is not the same as defaulting to none: a branch nobody named
  // still fails, because a feature branched `wip/…` must not ship inside a patch release.
  const { bump, reason } = bumpFor({ branch: 'wip/tidy-the-tests', labels: [] })
  assert.equal(bump, null)
  assert.match(reason, /release:minor/)
  assert.match(reason, /wip\/tidy-the-tests/)
})

test('two release labels are a contradiction to resolve, not a race to read', () => {
  const { bump, reason } = bumpFor({ ...featPr, labels: ['release:minor', 'release:patch'] })
  assert.equal(bump, null)
  assert.match(reason, /release:minor, release:patch/)
})

test('a feature moves the minor and zeroes the patch', () => {
  assert.equal(expectedVersion({ latestTag: 'v1.4.2', bump: 'minor', major: 1 }), '1.5.0')
})

test('a fix moves the patch', () => {
  assert.equal(expectedVersion({ latestTag: 'v1.4.2', bump: 'patch', major: 1 }), '1.4.3')
})

test('release:none holds the version exactly where the last release left it', () => {
  assert.equal(expectedVersion({ latestTag: 'v1.4.2', bump: 'none', major: 1 }), '1.4.2')
})

test('adding a migration takes the version to the derived major, whatever the PR asked for', () => {
  // The major is `MIGRATIONS.length` (ADR 0002) and is never chosen by a label. A PR that
  // adds a migration lands as `MAJOR.0.0` even when it is labelled `release:none`.
  for (const bump of ['minor', 'patch', 'none']) {
    assert.equal(expectedVersion({ latestTag: 'v1.4.2', bump, major: 2 }), '2.0.0', bump)
  }
})

test('the first release is the derived major at zero', () => {
  assert.equal(expectedVersion({ latestTag: null, bump: 'minor', major: 1 }), '1.0.0')
})

// ------------------------------------------------------------------------ the PR gate

test('the check asks whether the PR named a bump, and nothing about the version', () => {
  const v = checkBump(featPr)
  assert.equal(v.ok, true)
  assert.equal(v.bump, 'minor')
  // Deliberately absent: no expected version, no tag read. Whatever else merges cannot make
  // this answer wrong, which is the whole reason the check is safe to require (ADR 0004).
  assert.equal(v.expected, undefined)
})

test('a PR naming no bump fails the check, naming the options', () => {
  const v = checkBump({ branch: 'wip/x', labels: [] })
  assert.equal(v.ok, false)
  assert.equal(v.bump, null)
  assert.match(v.message, /release:minor/)
})

// ------------------------------------------------------------- the bump a release asks for

test('a release asks for the strongest bump its pull requests asked for', () => {
  const b = bumpOfRelease([
    commit('aaa', pr(1, 'fix/one')),
    commit('bbb', pr(2, 'feat/two')),
    commit('ccc', pr(3, 'docs/three')),
  ])
  assert.equal(b.ok, true)
  assert.equal(b.bump, 'minor')
})

test('a release every pull request asked nothing of asks for nothing', () => {
  const b = bumpOfRelease([commit('aaa', pr(1, 'docs/one')), commit('bbb', pr(2, 'chore/two'))])
  assert.equal(b.ok, true)
  assert.equal(b.bump, 'none')
})

test('a commit with no pull request refuses the release rather than folding away', () => {
  // Folding what the API happened to return is how a feature ships inside a patch release
  // with nobody told — the same silent wrong answer ADR 0004 exists to remove.
  const b = bumpOfRelease([commit('abc1234def', pr(1, 'feat/one')), commit('deadbeefcafe', null)])
  assert.equal(b.ok, false)
  assert.equal(b.bump, null)
  assert.match(b.message, /deadbee/)
})

test('a pull request naming no bump refuses the release, naming the pull request', () => {
  const b = bumpOfRelease([commit('aaa', pr(1, 'feat/one')), commit('bbb', pr(7, 'wip/two'))])
  assert.equal(b.ok, false)
  assert.match(b.message, /#7/)
})


// ------------------------------------------------- the pull requests a release is made of

test('a release is made of the pull requests that landed on the branch it releases', () => {
  // The ordinary shape of a staged work: every commit is in its stage's pull request and in
  // the work branch's. Only the second landed on `main`, and counting both would describe one
  // change several times over in the notes of a release that contains it once.
  const commits = [commit('aaa', pr(1, 'feat/stage-one', [], { baseRefName: 'feat/the-work' }), pr(9, 'feat/the-work'))]
  assert.deepEqual(pullsOf(commits, { base: 'main' }).map(p => p.number), [9])
})

test('with no base named, every pull request counts', () => {
  const commits = [commit('aaa', pr(1, 'feat/one', [], { baseRefName: 'feat/the-work' }), pr(9, 'feat/the-work'))]
  assert.deepEqual(pullsOf(commits).map(p => p.number).sort(), [1, 9])
})

test('the bump is folded over the pull requests that landed here, not the ones below', () => {
  // The stage asked for a minor and never landed on this branch; the work branch asked for a
  // patch and did. A release of `main` is a patch.
  const commits = [commit('aaa', pr(1, 'feat/stage', [], { baseRefName: 'feat/the-work' }), pr(9, 'fix/the-work'))]
  assert.equal(bumpOfRelease(commits, { base: 'main' }).bump, 'patch')
  assert.equal(bumpOfRelease(commits).bump, 'minor', 'and everything, when no base is named')
})

// ------------------------------------------------------------- the shape of the notes

test("a pull request's own headings sit below its title, not beside it", () => {
  const body = ['# Top', '', '## Why', '', 'text', '', '### Detail'].join('\n')
  const notes = releaseNotes({ tag: 'v1.2.0', previousTag: 'v1.1.0', repo: 'o/r', pulls: [pr(1, 'feat/x', [], { body })] })
  assert.match(notes, /^## PR 1 /m, 'the title stays at two')
  assert.match(notes, /^## Top$/m)
  assert.match(notes, /^### Why$/m)
  assert.match(notes, /^#### Detail$/m)
})

test('a heading inside a fence is a shell comment and is left alone', () => {
  const body = ['before', '', '```bash', '# not a heading', '```', '', '## after'].join('\n')
  const notes = releaseNotes({ tag: 'v1.2.0', previousTag: 'v1.1.0', repo: 'o/r', pulls: [pr(1, 'feat/x', [], { body })] })
  assert.match(notes, /^# not a heading$/m, 'a shell comment is not deepened')
  assert.match(notes, /^### after$/m)
})

// ---------------------------------------------------------------------- the merge gate

test('a release is the latest tag moved by what its pull requests asked for', () => {
  const r = releaseVerdict({ commits: [commit('aaa', pr(1, 'feat/one'))], latestTag: 'v1.4.2', major: 1 })
  assert.equal(r.release, true)
  assert.equal(r.tag, 'v1.5.0')
  assert.equal(r.version, '1.5.0')
  assert.equal(r.previousTag, 'v1.4.2')
})

test('a push whose pull requests all asked for none releases nothing and says so', () => {
  const r = releaseVerdict({ commits: [commit('aaa', pr(1, 'docs/one'))], latestTag: 'v1.4.2', major: 1 })
  assert.equal(r.release, false)
  assert.equal(r.ok, true)
  assert.match(r.message, /nothing to release/)
})

test('a set that could not be read fails the release instead of publishing a guess', () => {
  const r = releaseVerdict({ commits: [commit('abc1234def', null)], latestTag: 'v1.4.2', major: 1 })
  assert.equal(r.ok, false)
  assert.equal(r.release, false)
  assert.equal(r.tag, null)
})

test('adding a migration takes the release to the derived major, whatever its PRs asked', () => {
  const r = releaseVerdict({ commits: [commit('aaa', pr(1, 'docs/one'))], latestTag: 'v1.4.2', major: 2 })
  assert.equal(r.release, true)
  assert.equal(r.tag, 'v2.0.0')
})

test('a release cut from a format this code does not contain is a broken state, not a bump', () => {
  // The major only ever grows, so a tag ahead of `MIGRATIONS.length` means the tag came from
  // something this commit is missing — releasing over the top of it would publish a downgrade
  // under a higher number.
  const r = releaseVerdict({ commits: [commit('aaa', pr(1, 'feat/one'))], latestTag: 'v2.0.0', major: 1 })
  assert.equal(r.ok, false)
  assert.match(r.message, /v2\.0\.0/)
})

test('the first release of all has no previous tag and still releases', () => {
  const r = releaseVerdict({ commits: [commit('aaa', pr(1, 'feat/one'))], latestTag: null, major: 1 })
  assert.equal(r.release, true)
  assert.equal(r.tag, 'v1.0.0')
  assert.equal(r.previousTag, null)
})

// The seam the workflow actually runs: `node bin/release.mjs`. Nothing here reads
// `package.json` — the check takes its whole question from the event, and the verdict takes
// its set from stdin.

const run = (args, input) => spawnSync(process.execPath, [path.join(ROOT, 'bin', 'release.mjs'), ...args], { encoding: 'utf8', input: input ?? '' })

test('the check passes a PR that named a bump', () => {
  const r = run(['check', '--branch', 'feat/x', '--labels', 'release:none'])
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /asks for none/)
})

test('the check exits non-zero and names the options when the PR named nothing', () => {
  const r = run(['check', '--branch', 'wip/x'])
  assert.equal(r.status, 1)
  assert.match(r.stdout, /release:minor/)
})

test('the verdict prints what the merge workflow reads, on stdout, alone', () => {
  const commits = JSON.stringify([commit('aaa', pr(1, 'feat/x'))])
  const r = run(['verdict', '--tag', 'v1.4.2'], commits)
  assert.equal(r.status, 0, r.stderr)
  const read = JSON.parse(r.stdout)
  assert.equal(read.release, true)
  assert.equal(read.previousTag, 'v1.4.2')
  assert.match(read.tag, /^v\d+\.\d+\.\d+$/)
})

test('the verdict exits non-zero on a set it could not read, and tags nothing', () => {
  const r = run(['verdict', '--tag', 'v1.4.2'], JSON.stringify([commit('abc1234def', null)]))
  assert.equal(r.status, 1)
  assert.equal(JSON.parse(r.stdout).tag, null)
})

test('the notes read the same stdin the verdict did, and skip the commits with no PR', () => {
  const commits = JSON.stringify([commit('aaa', pr(1, 'feat/x')), commit('bbb', null)])
  const r = run(['notes', '--tag', 'v1.2.0', '--previous', 'v1.1.0', '--repo', 'hugoforte/rig'], commits)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /PR 1/)
})

test('a pull request spread over several commits gets one section, not one each', () => {
  // The merge method decides this: squash keeps one commit per PR, rebase can keep several.
  const commits = JSON.stringify([commit('aaa', pr(4, 'feat/x')), commit('bbb', pr(4, 'feat/x'))])
  const r = run(['notes', '--tag', 'v1.2.0', '--previous', 'v1.1.0', '--repo', 'hugoforte/rig'], commits)
  assert.equal(r.status, 0, r.stderr)
  assert.equal(r.stdout.match(/## PR 4/g)?.length, 1, r.stdout)
})

test('a commit belonging to two pull requests counts both, and keeps both in the notes', () => {
  // The bug this pins: taking the first pull request GitHub lists would size this release as
  // a patch and drop #2 from the notes entirely.
  const commits = [commit('aaa', pr(1, 'fix/one'), pr(2, 'feat/two'))]
  assert.equal(bumpOfRelease(commits).bump, 'minor')
  const r = run(['notes', '--tag', 'v1.2.0', '--previous', 'v1.1.0', '--repo', 'hugoforte/rig'], JSON.stringify(commits))
  assert.match(r.stdout, /PR 1/)
  assert.match(r.stdout, /PR 2/)
})

// ---------------------------------------------------------------- the release itself

test('the notes are the merged PR descriptions, oldest first, under their titles', () => {
  const notes = releaseNotes({
    tag: 'v1.2.0',
    previousTag: 'v1.1.0',
    repo: 'hugoforte/rig',
    pulls: [
      { number: 34, title: 'Name the release', url: 'https://github.com/hugoforte/rig/pull/34', body: 'Why it was needed.' },
      { number: 33, title: 'Fix the probe', url: 'https://github.com/hugoforte/rig/pull/33', body: 'One line.' },
    ],
  })
  assert.match(notes, /## Fix the probe \(\[#33\]\(https:\/\/github.com\/hugoforte\/rig\/pull\/33\)\)/)
  assert.ok(notes.indexOf('Fix the probe') < notes.indexOf('Name the release'), 'oldest first')
  assert.match(notes, /Why it was needed\./)
})

test('the notes end in the comparison with the release they follow', () => {
  const notes = releaseNotes({ tag: 'v1.2.0', previousTag: 'v1.1.0', repo: 'hugoforte/rig', pulls: [] })
  assert.match(notes, /compare\/v1\.1\.0\.\.\.v1\.2\.0/)
})

test('a first release compares against nothing and says so', () => {
  const notes = releaseNotes({ tag: 'v1.0.0', previousTag: null, repo: 'hugoforte/rig', pulls: [] })
  assert.doesNotMatch(notes, /compare/)
  assert.match(notes, /commits\/v1\.0\.0/)
})

test('a range no pull request carried still produces notes, saying that', () => {
  const notes = releaseNotes({ tag: 'v1.2.0', previousTag: 'v1.1.0', repo: 'hugoforte/rig', pulls: [] })
  assert.match(notes, /no pull request/i)
})

test('the agent attribution footer is not release notes', () => {
  const body = 'The real description.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n'
  const notes = releaseNotes({ tag: 'v1.2.0', previousTag: 'v1.1.0', repo: 'hugoforte/rig', pulls: [{ number: 1, title: 'A', url: 'u', body }] })
  assert.match(notes, /The real description\./)
  assert.doesNotMatch(notes, /Generated with/)
})

test('a describe names the release the checkout is on and how far past it', () => {
  assert.deepEqual(parseDescribe('v1.1.0-0-gabc1234'), { tag: 'v1.1.0', distance: 0 })
  assert.deepEqual(parseDescribe('v1.1.0-3-gabc1234'), { tag: 'v1.1.0', distance: 3 })
})

test('anything git did not describe as a release names nothing', () => {
  for (const junk of ['', null, 'fatal: no names found', 'v1.1.0']) assert.equal(parseDescribe(junk), null)
})

test('a checkout standing on a release is named by it, not by a sha', () => {
  assert.equal(releaseMark({ describe: 'v1.1.0-0-gabc1234', head: 'abc1234def' }), 'v1.1.0')
})

test('a checkout past a release says how far past, and still names the commit', () => {
  assert.equal(releaseMark({ describe: 'v1.1.0-3-gabc1234', head: 'abc1234def' }), '3 past v1.1.0, abc1234')
  assert.equal(releaseMark({ describe: 'v1.1.0-1-gabc1234', head: 'abc1234def' }), '1 past v1.1.0, abc1234')
})

test('a checkout with no release in its history is named by its commit, as before', () => {
  assert.equal(releaseMark({ describe: null, head: 'abc1234def' }), 'abc1234')
  assert.equal(releaseMark({ describe: null, head: null }), null)
})

// ------------------------------------------------ naming a package that has no git at all

// An installation from the registry is a copy with no `.git`, so `git describe` answers
// nothing and the two facts that named a checkout — the release and the sha — are both gone.
// What it does have is a real version in `package.json`, injected at publish (ADR 0004 says
// the version is worked out at the release; a published artifact is where it lands).

test('a package with a real version is named by it when git describes nothing', () => {
  assert.equal(releaseMark({ describe: null, head: null, packageVersion: '3.9.0' }), 'v3.9.0')
})

test('the placeholder version names nothing — it is not a release', () => {
  assert.equal(releaseMark({ describe: null, head: null, packageVersion: PLACEHOLDER_VERSION }), null)
  assert.equal(releaseMark({ describe: null, head: null, packageVersion: '0.0.0-development' }), null,
    'and the literal, in case the constant ever stops being that string')
})

test('git wins over package.json: a clone is named by where it actually stands', () => {
  // The case that makes the order matter. A development checkout carries the placeholder *and*
  // real git history; naming it from `package.json` would report a release it is not on.
  assert.equal(releaseMark({ describe: 'v1.1.0-3-gabc1234', head: 'abc1234def', packageVersion: '9.9.9' }),
    '3 past v1.1.0, abc1234')
  assert.equal(releaseMark({ describe: null, head: 'abc1234def', packageVersion: PLACEHOLDER_VERSION }),
    'abc1234', 'a clone with no tags is still named by its commit')
})

test('a version that is not a plain release is not believed', () => {
  for (const junk of [null, undefined, '', 'nope', '1.2', '1.2.0-rc.1']) {
    assert.equal(releaseMark({ describe: null, head: null, packageVersion: junk }), null, `for ${junk}`)
  }
})

test('package.json still carries the placeholder ADR 0004 requires', () => {
  const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.version, PLACEHOLDER_VERSION,
    'the version is injected at publish; a real one committed here would name a release this tree is not')
})
