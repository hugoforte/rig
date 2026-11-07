// `rig page`, and what `rig pr` and `rig next` say of a reading page: end to end, over the
// in-memory GitHub, so that "never readable by more people than the code" is asserted where the
// write happens. No test here reaches a real Pages site: the adapter keeps what it would have
// written.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall } from './billing-install.mjs'

const m = billingInstall('rig-page-')
const { tmp, dataRoot, rig, gitMust, github, setGithub, withVisibility, worktree, record, cleanup } = m

after(cleanup)

const SITE = { url: 'https://pages.example.invalid/site/', public: false, branch: 'gh-pages', path: '/', build: 'legacy' }
const HEAD = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)

const setPages = (spec, pages) => {
  const state = github()
  state.repos[spec] = { prs: [], ...state.repos[spec], pages }
  setGithub(state)
}
const prOf = branch => github().repos['acme/billing'].prs.find(p => p.branch === branch)
const setPr = (branch, over) => {
  const state = github()
  Object.assign(state.repos['acme/billing'].prs.find(p => p.branch === branch), over)
  setGithub(state)
}

// A pushed work on one repo, its PR open and sized.
function workWithPr (id, size = { additions: 1000, deletions: 240, changedFiles: 31 }) {
  assert.equal(rig(['new', id, '--title', id, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  const dest = worktree(id, 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), `${id}\n`)
  gitMust(dest, 'commit', '-qam', id)
  gitMust(dest, 'push', '-q', 'origin', 'HEAD')
  const r = rig(['pr', '--work', id])
  assert.equal(r.code, 0, r.out)
  setPr(`feat/${id}`, { head: HEAD, ...size })
  return `feat/${id}`
}

const pageFile = (over = {}) => {
  const { pr = 'https://github.com/acme/billing/pull/1', head = HEAD, name = 'dist.html' } = over
  const file = path.join(tmp, name)
  fs.writeFileSync(file, `<!doctype html><head><meta name="rig:pr" content="${pr}"><meta name="rig:head" content="${head}"></head><p>a page</p>`)
  return file
}

// The data root in this installation has no remote, which counts as private.
before(() => setPages('acme/billing', null))

test('page --help prints how it is used and publishes nothing', () => {
  const r = rig(['page', '--help'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ {2}rig page/m)
  assert.match(r.out, /--publish/)
})

test('a big PR\'s `rig page` says its size and where a page can go, and writes nothing', () => {
  const branch = workWithPr('big-pr')
  setPages('acme/billing', SITE)
  const before = fs.readFileSync(path.join(dataRoot, 'work', 'big-pr', 'work.json'), 'utf8')
  const r = rig(['page', '--work', 'big-pr'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: this PR is 1,240 lines across 31 files/)
  assert.match(r.out, /acme\/billing's own site/)
  assert.equal(fs.readFileSync(path.join(dataRoot, 'work', 'big-pr', 'work.json'), 'utf8'), before)

  const [fact] = JSON.parse(rig(['page', '--work', 'big-pr', '--json']).out)
  assert.equal(fact.repo, 'billing')
  assert.equal(fact.due, true)
  assert.deepEqual(fact.size, { lines: 1240, files: 31 })
  assert.equal(fact.pr.url, prOf(branch).url)
  assert.equal(fact.pr.head, HEAD)
  assert.equal(fact.pr.base, 'main')
  assert.equal(fact.pr.branch, branch)
  assert.equal(fact.site.host, 'repo')
  assert.equal(fact.site.url, `${SITE.url}rig-pr-pages/acme/billing/${prOf(branch).number}/`)
  assert.match(fact.source, /work[\\/]big-pr[\\/]pages[\\/]billing\.md$/, 'private beside private: the source stays with the work')
})

test('`rig next` offers the page on a big PR, and nothing on a small one', () => {
  assert.match(rig(['next', '--work', 'big-pr']).out, /this PR is 1,240 lines across 31 files[\s\S]*rig-pr-page skill/)
  workWithPr('small-pr', { additions: 10, deletions: 2, changedFiles: 1 })
  assert.doesNotMatch(rig(['next', '--work', 'small-pr']).out, /reading page/)
})

test('a repo\'s catalogue entry and its org in rig.json can move the threshold, the repo winning', () => {
  const entry = path.join(dataRoot, 'catalog', 'acme', 'billing.md')
  const rigJson = path.join(dataRoot, 'rig.json')
  const [wasEntry, wasJson] = [fs.readFileSync(entry, 'utf8'), fs.readFileSync(rigJson, 'utf8')]
  try {
    const small = () => rig(['next', '--work', 'small-pr']).out
    fs.writeFileSync(rigJson, JSON.stringify({ ...JSON.parse(wasJson), prPage: { acme: { lines: 5, files: 'off' } } }))
    assert.match(small(), /12 lines across 1 file,.*\(5 lines\)/, 'the org lowered it')
    fs.writeFileSync(entry, wasEntry.replace(/^---\n/, '---\npr_page_lines: off\n'))
    assert.doesNotMatch(small(), /reading page/, 'the repo turned the measure off')
    fs.writeFileSync(entry, wasEntry.replace(/^---\n/, '---\npr_page_lines: heaps\n'))
    const r = rig(['next', '--work', 'small-pr'])
    assert.equal(r.code, 0, 'a typo stops nothing')
    assert.match(r.out, /"heaps" is neither a positive whole number nor off/)
  } finally {
    fs.writeFileSync(entry, wasEntry)
    fs.writeFileSync(rigJson, wasJson)
  }
})

test('--publish writes the page to one path of the site, and records its head on the work branch', () => {
  const branch = 'feat/big-pr'
  const { number, url } = prOf(branch)
  const r = rig(['page', 'billing', '--work', 'big-pr', '--publish', pageFile({ pr: url })])
  assert.equal(r.code, 0, r.out)
  const [write] = github().repos['acme/billing'].pageWrites
  assert.equal(write.branch, 'gh-pages')
  assert.equal(write.path, `rig-pr-pages/acme/billing/${number}/index.html`)
  assert.match(write.content, /a page/)
  const recorded = record('big-pr').repos[0].branches.find(b => b.branch === branch).page
  assert.equal(recorded.url, `${SITE.url}rig-pr-pages/acme/billing/${number}/`)
  assert.equal(recorded.head, HEAD)
  assert.equal(recorded.host, 'repo')
  assert.ok(recorded.at)
  assert.match(r.out, /rig pr --refresh/)
  assert.match(gitMust(dataRoot, 'log', '-1', '--format=%s'), /big-pr/, 'mutating, like `rig check --run`')
})

test('`rig next` then offers the refresh that carries the link, and `rig pr --refresh` writes it', () => {
  assert.match(rig(['next', '--work', 'big-pr']).out, /no longer says what the record does[\s\S]*rig pr --refresh/)
  assert.doesNotMatch(rig(['next', '--work', 'big-pr']).out, /this PR is 1,240 lines/, 'the page is written: no more offers')
  const r = rig(['pr', '--refresh', '--work', 'big-pr'])
  assert.equal(r.code, 0, r.out)
  const body = prOf('feat/big-pr').body
  assert.match(body, /Reading page, at `aaaaaaa`: https:\/\/pages\.example\.invalid\/site\/rig-pr-pages\/acme\/billing\/\d+\//)
  assert.ok(body.indexOf('Reading page') < body.indexOf('Context doc'), 'where a reviewer starts')
  assert.match(rig(['pr', '--refresh', '--work', 'big-pr']).out, /already up to date/)
})

test('a head moved past the page is said by `rig next`, `rig page` and `rig pr`', () => {
  setPr('feat/big-pr', { head: NEWER })
  const moved = /head has moved past its reading page \(page at aaaaaaa, PR at bbbbbbb\)/
  assert.match(rig(['next', '--work', 'big-pr']).out, moved)
  assert.match(rig(['page', '--work', 'big-pr']).out, moved)
  assert.match(rig(['pr', '--work', 'big-pr']).out, moved)
  assert.equal(JSON.parse(rig(['page', '--work', 'big-pr', '--json']).out)[0].stale, true)
})

test('publishing again replaces the page, and moves the head the record and the body name', () => {
  const { url } = prOf('feat/big-pr')
  assert.equal(rig(['page', 'billing', '--work', 'big-pr', '--publish', pageFile({ pr: url, head: NEWER })]).code, 0)
  assert.equal(github().repos['acme/billing'].pageWrites.length, 2)
  assert.doesNotMatch(rig(['next', '--work', 'big-pr']).out, /moved past/)
  rig(['pr', '--refresh', '--work', 'big-pr'])
  assert.match(prOf('feat/big-pr').body, /Reading page, at `bbbbbbb`/)
})

test('a page built at another head still publishes, and says so', () => {
  const { url } = prOf('feat/big-pr')
  const r = rig(['page', 'billing', '--work', 'big-pr', '--publish', pageFile({ pr: url, head: HEAD })])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /moved past/)
  assert.equal(rig(['page', 'billing', '--work', 'big-pr', '--publish', pageFile({ pr: url, head: NEWER })]).code, 0)
})

test('--publish refuses a file that is no page of this PR, and records nothing', () => {
  const writes = () => github().repos['acme/billing'].pageWrites.length
  const was = writes()
  const r = rig(['page', 'billing', '--work', 'big-pr', '--publish', pageFile({ pr: 'https://github.com/acme/billing/pull/999' })])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /describes https:\/\/github\.com\/acme\/billing\/pull\/999/)
  const bare = path.join(tmp, 'bare.html')
  fs.writeFileSync(bare, '<p>hand made</p>')
  assert.equal(rig(['page', 'billing', '--work', 'big-pr', '--publish', bare]).code, 1)
  assert.equal(rig(['page', 'billing', '--work', 'big-pr', '--publish', path.join(tmp, 'absent.html')]).code, 1)
  assert.equal(writes(), was)
})

test('a private repo whose own site is public gets no page, one line why, and --publish refuses', () => {
  const branch = workWithPr('open-site')
  setPages('acme/billing', { ...SITE, public: true })
  try {
    const said = rig(['next', '--work', 'open-site']).out
    assert.match(said, /billing: no reading page — acme\/billing is private: its own Pages site is public/)
    assert.match(rig(['page', '--work', 'open-site']).out, /no reading page/)
    const [fact] = JSON.parse(rig(['page', '--work', 'open-site', '--json']).out)
    assert.equal(fact.site, null)
    assert.match(fact.why, /own Pages site is public/)

    const was = github().repos['acme/billing'].pageWrites.length
    const r = rig(['page', 'billing', '--work', 'open-site', '--publish', pageFile({ pr: prOf(branch).url })])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /no reading page/)
    assert.equal(github().repos['acme/billing'].pageWrites.length, was, 'nothing written')
    assert.equal(record('open-site').repos[0].branches.find(b => b.branch === branch).page, undefined)
    assert.doesNotMatch(prOf(branch).body, /Reading page|Pages site/, 'the reason stays out of the PR body')
  } finally {
    setPages('acme/billing', SITE)
  }
})

test('the data root\'s site is used at the repo\'s own level, and its link goes once the repo is wider', () => {
  const remote = 'https://github.com/acme/rig-data.git'
  const branch = workWithPr('root-site')
  setPages('acme/billing', null)
  setPages('acme/rig-data', SITE)
  gitMust(dataRoot, 'remote', 'add', 'origin', remote)
  gitMust(dataRoot, 'config', 'remote.origin.pushurl', path.join(tmp, 'no-such-remote'))
  try {
    withVisibility('acme/rig-data', 'private', () => {
      const [fact] = JSON.parse(rig(['page', '--work', 'root-site', '--json']).out)
      assert.equal(fact.site.host, 'root')
      assert.equal(fact.site.spec, 'acme/rig-data')
      const r = rig(['page', 'billing', '--work', 'root-site', '--publish', pageFile({ pr: prOf(branch).url })])
      assert.equal(r.code, 0, r.out)
      assert.equal(github().repos['acme/rig-data'].pageWrites.length, 1, 'written to the data root\'s site')

      rig(['pr', '--refresh', '--work', 'root-site'])
      assert.match(prOf(branch).body, /Reading page/)

      withVisibility('acme/billing', 'public', () => {
        rig(['pr', '--refresh', '--work', 'root-site'])
        assert.doesNotMatch(prOf(branch).body, /Reading page|rig-data/, 'it would name the private data root in public')
        const [refused] = JSON.parse(rig(['page', '--work', 'root-site', '--json']).out)
        assert.equal(refused.site, null)
      })
    })
  } finally {
    gitMust(dataRoot, 'remote', 'remove', 'origin')
    setPages('acme/billing', SITE)
  }
})

test('GitHub not saying whether a site exists is no page, and stops no other command', () => {
  workWithPr('unsure')
  const state = github()
  state.repos['acme/billing'].pagesLookupFails = 'gh: Forbidden (HTTP 403)'
  setGithub(state)
  try {
    const r = rig(['next', '--work', 'unsure'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /no reading page — .*GitHub would not say whether it has a Pages site/)
  } finally {
    const clear = github()
    delete clear.repos['acme/billing'].pagesLookupFails
    setGithub(clear)
  }
})

test('`rig pr` says the size beside a PR it opens, and opens it whatever the answer', () => {
  assert.equal(rig(['new', 'opens-big', '--title', 'opens-big', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'opens-big']).code, 0)
  const dest = worktree('opens-big', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'opens-big\n')
  gitMust(dest, 'commit', '-qam', 'opens-big')
  gitMust(dest, 'push', '-q', 'origin', 'HEAD')
  const state = github()
  state.prSizeOnCreate = { additions: 700, deletions: 0, changedFiles: 4 }
  setGithub(state)
  const r = rig(['pr', '--work', 'opens-big'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: PR #\d+ → main/)
  assert.match(r.out, /billing: this PR is 700 lines across 4 files/)
  assert.ok(prOf('feat/opens-big'))
})

test('a work with no PR has nothing to measure, and --publish refuses', () => {
  assert.equal(rig(['new', 'no-pr', '--title', 'no-pr', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'no-pr']).code, 0)
  assert.match(rig(['page', '--work', 'no-pr']).out, /billing: no open PR/)
  const r = rig(['page', 'billing', '--work', 'no-pr', '--publish', pageFile()])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no open PR/)
})

test('a page record that is no page is refused when the work is read', () => {
  const file = path.join(dataRoot, 'work', 'no-pr', 'work.json')
  const was = fs.readFileSync(file, 'utf8')
  const w = JSON.parse(was)
  w.repos[0].branches = [{ branch: 'feat/no-pr', base: 'main', page: { url: 3 } }]
  fs.writeFileSync(file, JSON.stringify(w))
  try {
    const r = rig(['status', '--work', 'no-pr'])
    assert.notEqual(r.code, 0)
    assert.match(r.out, /`page` of billing/)
  } finally {
    fs.writeFileSync(file, was)
  }
})

test('`rig status` and `rig list --json` carry the page recorded', () => {
  const url = prOf('feat/big-pr').url
  assert.match(rig(['status', '--work', 'big-pr']).out, /page +at bbbbbbb https:\/\/pages\.example\.invalid/)
  const listed = JSON.parse(rig(['list', '--json']).out)
  const list = Array.isArray(listed) ? listed : listed.works
  const big = list.find(w => w.id === 'big-pr')
  assert.equal(big.repos[0].branches.find(b => b.branch === 'feat/big-pr').page.head, NEWER, url)
})
