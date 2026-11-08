// `rig page`, and what `rig pr` and `rig next` say of a reading page: end to end, over the
// in-memory GitHub, so that "only the data root's site, and never public" is asserted where the
// write happens. No test here reaches a real Pages site: the adapter keeps what it would have
// written.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall } from './billing-install.mjs'
import { readJson } from './harness.mjs'

const m = billingInstall('rig-page-')
const { tmp, dataRoot, rig, gitMust, github, setGithub, withVisibility, worktree, record, cutStage, cleanup } = m

after(cleanup)

const SITE = { url: 'https://wandering-otter-1a2b3c.pages.github.io/', public: false, branch: 'gh-pages', path: '/', build: 'legacy' }
const HEAD = 'a'.repeat(40)
const NEWER = 'b'.repeat(40)

const setPages = (spec, pages) => {
  const state = github()
  state.repos[spec] = { prs: [], ...state.repos[spec], pages }
  setGithub(state)
}
const writes = spec => github().repos[spec].pageWrites || []
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

// This installation's data root is given a remote, so it is a real candidate, with rig-data's
// visibility and site as each test sets them. Pushes go nowhere: the push URL does not exist, and
// a push that fails only warns.
before(() => {
  gitMust(dataRoot, 'remote', 'add', 'origin', 'https://github.com/acme/rig-data.git')
  gitMust(dataRoot, 'config', 'remote.origin.pushurl', path.join(tmp, 'no-such-remote'))
  const state = github()
  state.repos['acme/rig-data'] = { prs: [], visibility: 'private', pages: SITE }
  setGithub(state)
})

test('page --help prints how it is used and publishes nothing', () => {
  const r = rig(['page', '--help'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ {2}rig page/m)
  assert.match(r.out, /--publish/)
})

test('a big PR\'s `rig page` says its size and that the data root\'s site is where it goes, and writes nothing', () => {
  const branch = workWithPr('big-pr')
  const before = fs.readFileSync(path.join(dataRoot, 'work', 'big-pr', 'work.json'), 'utf8')
  const r = rig(['page', '--work', 'big-pr'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: this PR is 1,240 lines across 31 files/)
  assert.match(r.out, /the data root's site \(acme\/rig-data\)/)
  assert.equal(fs.readFileSync(path.join(dataRoot, 'work', 'big-pr', 'work.json'), 'utf8'), before)

  const [fact] = JSON.parse(rig(['page', '--work', 'big-pr', '--json']).out)
  assert.equal(fact.repo, 'billing')
  assert.equal(fact.due, true)
  assert.deepEqual(fact.size, { lines: 1240, files: 31 })
  assert.equal(fact.pr.url, prOf(branch).url)
  assert.equal(fact.pr.head, HEAD)
  assert.equal(fact.pr.base, 'main')
  assert.equal(fact.pr.branch, branch)
  assert.equal(fact.site.spec, 'acme/rig-data')
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

test('--publish writes the page to one path of the data root\'s site, and records its head on the work branch', () => {
  const branch = 'feat/big-pr'
  const { number, url } = prOf(branch)
  const r = rig(['page', 'billing', '--work', 'big-pr', '--publish', pageFile({ pr: url })])
  assert.equal(r.code, 0, r.out)
  const [write] = writes('acme/rig-data')
  assert.equal(write.branch, 'gh-pages')
  assert.equal(write.path, `rig-pr-pages/acme/billing/${number}/index.html`)
  assert.match(write.content, /a page/)
  assert.equal(writes('acme/billing').length, 0, 'nothing goes to the code\'s own repo')
  const recorded = record('big-pr').repos[0].branches.find(b => b.branch === branch).page
  assert.equal(recorded.url, `${SITE.url}rig-pr-pages/acme/billing/${number}/`)
  assert.equal(recorded.head, HEAD)
  assert.equal(recorded.host, undefined, 'one host, so nothing to say which')
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
  assert.match(body, /Reading page, at `aaaaaaa`: https:\/\/wandering-otter-1a2b3c\.pages\.github\.io\/rig-pr-pages\/acme\/billing\/\d+\//)
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
  const was = writes('acme/rig-data').length
  assert.equal(rig(['page', 'billing', '--work', 'big-pr', '--publish', pageFile({ pr: url, head: NEWER })]).code, 0)
  assert.equal(writes('acme/rig-data').length, was + 1)
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

test('--publish refuses a file that is no page of this work\'s PRs, and records nothing', () => {
  const was = writes('acme/rig-data').length
  const r = rig(['page', 'billing', '--work', 'big-pr', '--publish', pageFile({ pr: 'https://github.com/acme/billing/pull/999' })])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /describes https:\/\/github\.com\/acme\/billing\/pull\/999/)
  const bare = path.join(tmp, 'bare.html')
  fs.writeFileSync(bare, '<p>hand made</p>')
  assert.equal(rig(['page', 'billing', '--work', 'big-pr', '--publish', bare]).code, 1)
  assert.equal(rig(['page', 'billing', '--work', 'big-pr', '--publish', path.join(tmp, 'absent.html')]).code, 1)
  assert.equal(writes('acme/rig-data').length, was)
})

const PUBLIC_LINE = 'this page will be public: the data root\'s Pages site is on the open internet'

test('non-public code on a public site: --publish refuses without --public, saying why, and writes nothing', () => {
  const branch = workWithPr('open-site')
  setPages('acme/rig-data', { ...SITE, public: true })
  try {
    assert.match(rig(['next', '--work', 'open-site']).out, /this PR is 1,240 lines across 31 files.*this page would be public/)
    assert.match(rig(['page', '--work', 'open-site']).out, /this page would be public/)
    const [fact] = JSON.parse(rig(['page', '--work', 'open-site', '--json']).out)
    assert.equal(fact.site.public, true)
    assert.equal(fact.site.needsPublicFlag, true)

    const was = writes('acme/rig-data').length
    const r = rig(['page', 'billing', '--work', 'open-site', '--publish', pageFile({ pr: prOf(branch).url })])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /this page would be public: .*acme\/billing is private\. A published page cannot be taken back.*--public/)
    assert.match(r.out, /Nothing published/)
    assert.equal(writes('acme/rig-data').length, was, 'nothing written')
    assert.equal(record('open-site').repos[0].branches.find(b => b.branch === branch).page, undefined)
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('non-public code on a public site: with --public it warns and publishes', () => {
  const branch = 'feat/open-site'
  setPages('acme/rig-data', { ...SITE, public: true })
  try {
    const was = writes('acme/rig-data').length
    const r = rig(['page', 'billing', '--work', 'open-site', '--public', '--publish', pageFile({ pr: prOf(branch).url })])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /this page is public, by --public/)
    assert.equal(writes('acme/rig-data').length, was + 1)
    assert.equal(record('open-site').repos[0].branches.find(b => b.branch === branch).page.head, HEAD)
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('public code on a public site: `rig next` and `rig page` warn, and --publish needs no flag', () => {
  const branch = workWithPr('public-code')
  setPages('acme/rig-data', { ...SITE, public: true, url: 'https://acme.github.io/rig-data/' })
  try {
    withVisibility('acme/billing', 'public', () => {
      const offer = rig(['next', '--work', 'public-code']).out
      assert.ok(offer.includes(`rig-pr-page skill writes one — ${PUBLIC_LINE}`), offer)
      assert.ok(rig(['page', '--work', 'public-code']).out.includes(PUBLIC_LINE))
      const [fact] = JSON.parse(rig(['page', '--work', 'public-code', '--json']).out)
      assert.equal(fact.warning, PUBLIC_LINE)
      const was = writes('acme/rig-data').length
      const r = rig(['page', 'billing', '--work', 'public-code', '--publish', pageFile({ pr: prOf(branch).url })])
      assert.equal(r.code, 0, r.out)
      assert.match(r.out, /this page is public: the data root's Pages site is on the open internet/)
      assert.equal(writes('acme/rig-data').length, was + 1)
    })
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('a public site whose address names a private data root stays out of a public PR, and the link is printed', () => {
  const branch = 'feat/public-code'
  setPages('acme/rig-data', { ...SITE, public: true, url: 'https://acme.github.io/rig-data/' })
  try {
    withVisibility('acme/billing', 'public', () => {
      const r = rig(['page', 'billing', '--work', 'public-code', '--publish', pageFile({ pr: prOf(branch).url })])
      assert.match(r.out, /may not carry that link.*https:\/\/acme\.github\.io\/rig-data\//)
      rig(['pr', '--refresh', '--work', 'public-code'])
      assert.doesNotMatch(prOf(branch).body, /Reading page|acme\.github\.io/)
    })
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('a site that does not say it is private gets the same treatment', () => {
  const branch = workWithPr('silent-site')
  setPages('acme/rig-data', { ...SITE, public: undefined })
  try {
    const r = rig(['page', 'billing', '--work', 'silent-site', '--publish', pageFile({ pr: prOf(branch).url })])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /does not say it is private, so it counts as public/)
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('--public by URL works the same: refused without it, and with it published and nothing recorded', () => {
  seedOutsideFor('acme/refunds', 77)
  const url = 'https://github.com/acme/refunds/pull/77'
  setPages('acme/rig-data', { ...SITE, public: true })
  try {
    const was = writes('acme/rig-data').length
    assert.equal(rig(['page', url, '--publish', pageFile({ pr: url })]).code, 1)
    assert.equal(writes('acme/rig-data').length, was)
    const r = rig(['page', url, '--public', '--publish', pageFile({ pr: url })])
    assert.equal(r.code, 0, r.out)
    assert.equal(writes('acme/rig-data').length, was + 1)
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('the site is judged at the write, not trusted from an earlier look', () => {
  const branch = workWithPr('judged-late')
  assert.equal(JSON.parse(rig(['page', '--work', 'judged-late', '--json']).out)[0].site.public, false)
  setPages('acme/rig-data', { ...SITE, public: true })
  try {
    assert.equal(rig(['page', 'billing', '--work', 'judged-late', '--publish', pageFile({ pr: prOf(branch).url })]).code, 1)
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('a site served from the data root\'s main is refused, and the line says what to change', () => {
  const branch = workWithPr('main-site')
  setPages('acme/rig-data', { ...SITE, branch: 'main', build: 'workflow' })
  try {
    const r = rig(['page', 'billing', '--work', 'main-site', '--publish', pageFile({ pr: prOf(branch).url })])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /served from main by a workflow.*Pages settings.*root of a gh-pages branch/)
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('a public repo\'s PR carries a private site\'s link, whose random host names nothing', () => {
  const branch = workWithPr('public-pr')
  withVisibility('acme/billing', 'public', () => {
    const r = rig(['page', 'billing', '--work', 'public-pr', '--publish', pageFile({ pr: prOf(branch).url })])
    assert.equal(r.code, 0, r.out)
    rig(['pr', '--refresh', '--work', 'public-pr'])
    assert.match(prOf(branch).body, /Reading page, at `aaaaaaa`: https:\/\/wandering-otter-1a2b3c\.pages\.github\.io\//)
    assert.doesNotMatch(prOf(branch).body, /rig-data|Context doc/, 'and the data root stays unnamed')
  })
})

test('a custom domain keeps the context doc\'s rule: out of a PR more visible than the data root', () => {
  const branch = workWithPr('named-host')
  setPages('acme/rig-data', { ...SITE, url: 'https://docs.acme.example.invalid/' })
  try {
    const pr = prOf(branch).url
    assert.equal(rig(['page', 'billing', '--work', 'named-host', '--publish', pageFile({ pr })]).code, 0)
    rig(['pr', '--refresh', '--work', 'named-host'])
    assert.match(prOf(branch).body, /Reading page/, 'private beside private')
    withVisibility('acme/billing', 'public', () => {
      rig(['pr', '--refresh', '--work', 'named-host'])
      assert.doesNotMatch(prOf(branch).body, /Reading page|docs\.acme/, 'it may name the data root')
    })
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('GitHub not saying whether a site exists is no page, and stops no other command', () => {
  workWithPr('unsure')
  const state = github()
  state.repos['acme/rig-data'].pagesLookupFails = 'gh: Forbidden (HTTP 403)'
  setGithub(state)
  try {
    const r = rig(['next', '--work', 'unsure'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /no reading page — GitHub would not say whether the data root has a Pages site/)
  } finally {
    const clear = github()
    delete clear.repos['acme/rig-data'].pagesLookupFails
    setGithub(clear)
  }
})

// ------------------------------------------------- before the PR opens

function pushedBig (id, lines) {
  assert.equal(rig(['new', id, '--title', id, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  const dest = worktree(id, 'billing')
  fs.writeFileSync(path.join(dest, 'big.txt'), Array.from({ length: lines }, (_, i) => `line ${i}`).join('\n') + '\n')
  gitMust(dest, 'add', '-A')
  gitMust(dest, 'commit', '-qm', id)
  gitMust(dest, 'push', '-q', 'origin', 'HEAD')
}

test('`rig next` measures a pushed branch with git and offers the page before a PR exists', () => {
  pushedBig('pushed-big', 700)
  const r = rig(['next', '--work', 'pushed-big'])
  assert.match(r.out, /billing: about 700 lines across 1 file, over the size for a reading page \(500 lines or 20 files\)/)
  assert.match(r.out, /rig-pr-page skill/)
})

test('`rig pr` says the size before it opens the PR, and opens it whatever the answer', () => {
  const r = rig(['pr', '--work', 'pushed-big'])
  assert.equal(r.code, 0, r.out)
  const said = r.out.indexOf('about 700 lines across 1 file')
  const opened = r.out.search(/billing: PR #\d+ → main/)
  assert.ok(said >= 0 && opened > said, r.out)
  assert.ok(prOf('feat/pushed-big'))
})

test('`rig pr` says a small branch is under the size, and still opens it', () => {
  pushedBig('pushed-small', 3)
  const r = rig(['pr', '--work', 'pushed-small'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /about 3 lines across 1 file, under the size for a reading page/)
  assert.ok(prOf('feat/pushed-small'))
})

test('a pushed branch with no safe place says so before the PR, and `rig pr` opens it anyway', () => {
  pushedBig('pushed-nowhere', 700)
  setPages('acme/rig-data', null)
  try {
    assert.match(rig(['next', '--work', 'pushed-nowhere']).out, /billing: no reading page — the data root \(acme\/rig-data\) has no Pages site/)
    const r = rig(['pr', '--work', 'pushed-nowhere'])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /no reading page/)
    assert.ok(prOf('feat/pushed-nowhere'))
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('a branch nothing is pushed on has nothing measured', () => {
  assert.equal(rig(['new', 'unpushed', '--title', 'unpushed', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'unpushed']).code, 0)
  assert.doesNotMatch(rig(['next', '--work', 'unpushed']).out, /reading page/)
})

// ------------------------------------------------- stage PRs

const stagedWork = id => {
  const branch = workWithPr(id, { additions: 2, deletions: 0, changedFiles: 1 })
  const stage = `feat/${id}-schema`
  assert.equal(rig(['stage', stage, '--work', id, '--delivers', 'the schema']).code, 0)
  m.cutStage({ work: id, repo: 'billing', branch: stage, from: branch, back: branch, message: `${id} schema` })
  gitMust(worktree(id, 'billing'), 'push', '-q', 'origin', stage)
  m.seedPr({ branch: stage, base: branch, number: 700 + github().repos['acme/billing'].prs.length, url: `https://github.com/acme/billing/pull/${700 + github().repos['acme/billing'].prs.length}`, state: 'OPEN', title: 'The schema', body: 'What a person wrote.', head: HEAD, additions: 900, deletions: 0, changedFiles: 4 })
  return stage
}

test('each big open stage PR is measured and offered a page, through `rig next` and `rig page`', () => {
  const stage = stagedWork('staged')
  assert.match(rig(['next', '--work', 'staged']).out, new RegExp(`billing \\(${stage}\\): this PR is 900 lines across 4 files`))
  const facts = JSON.parse(rig(['page', '--work', 'staged', '--json']).out)
  const fact = facts.find(f => f.pr?.branch === stage)
  assert.equal(fact.due, true)
  assert.equal(fact.stage, true)
  assert.equal(facts.find(f => f.pr?.branch === 'feat/staged').due, false)
})

test('a stage PR\'s page is found from the page itself, recorded on the stage, and linked in a region of the body', () => {
  const stage = 'feat/staged-schema'
  const { url, number } = prOf(stage)
  const r = rig(['page', '--work', 'staged', '--publish', pageFile({ pr: url })])
  assert.equal(r.code, 0, r.out)
  const branches = record('staged').repos[0].branches
  assert.equal(branches.find(b => b.branch === stage).page.head, HEAD)
  assert.equal(branches.find(b => b.branch === 'feat/staged').page, undefined, 'the work branch\'s record is untouched')
  assert.ok(writes('acme/rig-data').some(w => w.path === `rig-pr-pages/acme/billing/${number}/index.html`), 'addressed by the PR\'s number')
  const body = prOf(stage).body
  assert.match(body, /<!-- rig:reading-page -->\nReading page, at `aaaaaaa`: \S+\n<!-- \/rig:reading-page -->/)
  assert.match(body, /What a person wrote\.$/)
  assert.equal(prOf(stage).title, 'The schema', 'its title is left alone')
})

test('publishing a stage\'s page again leaves one link, with the new head, and the person\'s text alone', () => {
  const stage = 'feat/staged-schema'
  setPr(stage, { body: `${prOf(stage).body}\n\nAdded by a person later.` })
  assert.equal(rig(['page', '--work', 'staged', '--publish', pageFile({ pr: prOf(stage).url, head: NEWER })]).code, 0)
  const { body } = prOf(stage)
  assert.equal(body.match(/<!-- rig:reading-page -->/g).length, 1)
  assert.match(body, /at `bbbbbbb`/)
  assert.doesNotMatch(body, /aaaaaaa/)
  assert.match(body, /Added by a person later\.$/)
})

test('a stage whose head moved is said by `rig next`, against its own record', () => {
  setPr('feat/staged-schema', { head: HEAD })
  assert.match(rig(['next', '--work', 'staged']).out, /billing \(feat\/staged-schema\): the PR's head has moved past its reading page/)
})

test('a page on a stage changes nothing about where the stack says it sits', () => {
  const said = rig(['stage', '--work', 'staged'])
  assert.equal(said.code, 0, said.out)
  assert.match(said.out, /feat\/staged-schema/)
  assert.doesNotMatch(said.out, /adrift|outside the stack|unknown/i)
  assert.equal(rig(['status', '--work', 'staged']).code, 0)
})

test('`rig pr --refresh` leaves a stage PR\'s body alone', () => {
  const { body } = prOf('feat/staged-schema')
  rig(['pr', '--refresh', '--work', 'staged'])
  assert.equal(prOf('feat/staged-schema').body, body)
})

test('a stage PR that may not carry the link keeps its body, and the link is printed', () => {
  const id = 'staged-named'
  const stage = stagedWork(id)
  setPages('acme/rig-data', { ...SITE, url: 'https://docs.acme.example.invalid/' })
  try {
    withVisibility('acme/billing', 'public', () => {
      const r = rig(['page', '--work', id, '--publish', pageFile({ pr: prOf(stage).url })])
      assert.equal(r.code, 0, r.out)
      assert.equal(prOf(stage).body, 'What a person wrote.')
      assert.match(r.out, /docs\.acme\.example\.invalid/)
    })
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

// ------------------------------------------------- any PR, by URL

const OUTSIDE = 'https://github.com/acme/orders/pull/55'
function seedOutsideFor (spec, number) {
  const state = github()
  state.repos[spec] = { visibility: 'private', prs: [{ number, branch: 'colleague/work', base: 'main', url: `https://github.com/${spec}/pull/${number}`, state: 'OPEN', title: 'A colleague\'s', body: 'Theirs.', head: HEAD, additions: 900, deletions: 40, changedFiles: 12 }] }
  setGithub(state)
}
const seedOutside = () => {
  const state = github()
  state.repos['acme/orders'] = { visibility: 'private', prs: [{ number: 55, branch: 'colleague/work', base: 'main', url: OUTSIDE, state: 'OPEN', title: 'A colleague\'s', body: 'Theirs.', head: HEAD, additions: 900, deletions: 40, changedFiles: 12 }] }
  setGithub(state)
}

test('`rig page <url>` reports on a PR outside any work, from any folder, with its org\'s data root', () => {
  seedOutside()
  const [fact] = JSON.parse(rig(['page', OUTSIDE, '--json'], { cwd: tmp }).out)
  assert.equal(fact.outside, true)
  assert.equal(fact.due, true)
  assert.equal(fact.pr.url, OUTSIDE)
  assert.equal(fact.pr.branch, 'colleague/work')
  assert.equal(fact.site.spec, 'acme/rig-data')
  assert.equal(fact.source, null, 'no work to keep it with')
  assert.match(rig(['page', OUTSIDE], { cwd: tmp }).out, /acme\/orders#55: this PR is 940 lines across 12 files/)
})

test('--publish by URL writes the page, records nothing, leaves the PR alone and prints the link', () => {
  const before = readJson(path.join(dataRoot, 'work', 'big-pr', 'work.json'))
  const commits = gitMust(dataRoot, 'rev-list', '--count', 'HEAD')
  const r = rig(['page', OUTSIDE, '--publish', pageFile({ pr: OUTSIDE })], { cwd: tmp })
  assert.equal(r.code, 0, r.out)
  assert.ok(writes('acme/rig-data').some(w => w.path === 'rig-pr-pages/acme/orders/55/index.html'))
  assert.match(r.out, /Reading page, at `aaaaaaa`: https:\/\/wandering-otter-1a2b3c\.pages\.github\.io\/rig-pr-pages\/acme\/orders\/55\//)
  assert.match(r.out, /post it yourself|nothing was posted/i)
  const pr = github().repos['acme/orders'].prs[0]
  assert.equal(pr.body, 'Theirs.', 'never written to')
  assert.equal(gitMust(dataRoot, 'rev-list', '--count', 'HEAD'), commits, 'nothing committed')
  assert.deepEqual(readJson(path.join(dataRoot, 'work', 'big-pr', 'work.json')), before)
})

test('a PR whose org no data root holds is refused, and nothing is written', () => {
  const state = github()
  state.repos['stranger/thing'] = { visibility: 'private', prs: [{ number: 3, branch: 'x', base: 'main', url: 'https://github.com/stranger/thing/pull/3', state: 'OPEN', head: HEAD, additions: 9, deletions: 0, changedFiles: 1 }] }
  setGithub(state)
  const url = 'https://github.com/stranger/thing/pull/3'
  const was = writes('acme/rig-data').length
  const r = rig(['page', url, '--publish', pageFile({ pr: url })], { cwd: tmp })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no data root here holds stranger/)
  assert.equal(writes('acme/rig-data').length, was)
})

test('a URL GitHub has no PR for, or no PR at all, is refused', () => {
  assert.equal(rig(['page', 'https://github.com/acme/orders/pull/9999'], { cwd: tmp }).code, 1)
  assert.match(rig(['page', 'https://gitlab.example.invalid/acme/orders/pull/5'], { cwd: tmp }).out, /not attached|not a GitHub pull request|no work/i)
})

test('--publish by URL refuses a page of another PR', () => {
  const r = rig(['page', OUTSIDE, '--publish', pageFile({ pr: 'https://github.com/acme/orders/pull/56' })], { cwd: tmp })
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /describes https:\/\/github\.com\/acme\/orders\/pull\/56/)
})

// ------------------------------------------------- what the adversarial review found

test('--publish refuses a page whose head is not a commit of the PR\'s repo, on either route, and writes nothing', () => {
  const branch = workWithPr('other-code')
  const foreign = 'c'.repeat(40)
  const state = github()
  state.repos['acme/billing'].commitsAbsent = [foreign]
  state.repos['acme/orders'].commitsAbsent = [foreign]
  setGithub(state)
  const was = writes('acme/rig-data').length
  const r = rig(['page', 'billing', '--work', 'other-code', '--publish', pageFile({ pr: prOf(branch).url, head: foreign })])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /ccccccc, which is not a commit of acme\/billing.*nothing published/i)
  assert.equal(rig(['page', OUTSIDE, '--publish', pageFile({ pr: OUTSIDE, head: foreign })]).code, 1)
  assert.equal(writes('acme/rig-data').length, was)
  assert.equal(record('other-code').repos[0].branches.find(b => b.branch === branch).page, undefined)
})

test('a head GitHub would not answer for is refused too, and never read as there', () => {
  const branch = 'feat/other-code'
  const state = github()
  state.repos['acme/billing'].commitLookupFails = 'gh: Bad gateway (HTTP 502)'
  setGithub(state)
  try {
    const r = rig(['page', 'billing', '--work', 'other-code', '--publish', pageFile({ pr: prOf(branch).url })])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /GitHub would not say.*502/)
  } finally {
    const clear = github()
    delete clear.repos['acme/billing'].commitLookupFails
    setGithub(clear)
  }
})

test('by URL, an address that names a more private data root says the link may name it', () => {
  const url = 'https://github.com/acme/refunds/pull/77'
  const state = github()
  state.repos['acme/refunds'].visibility = 'public'
  setGithub(state)
  setPages('acme/rig-data', { ...SITE, public: true, url: 'https://acme.github.io/rig-data/' })
  try {
    const r = rig(['page', url, '--publish', pageFile({ pr: url })])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /may not carry that link, since its host may name the data root/)
    assert.doesNotMatch(r.out, /the link is yours to post/)
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('a republish a stage PR may no longer carry takes the old link out of its body, and prints the line', () => {
  const id = 'staged-widened'
  const stage = stagedWork(id)
  const pr = prOf(stage).url
  assert.equal(rig(['page', '--work', id, '--publish', pageFile({ pr })]).code, 0)
  assert.match(prOf(stage).body, /rig:reading-page/)
  setPages('acme/rig-data', { ...SITE, url: 'https://docs.acme.example.invalid/' })
  try {
    withVisibility('acme/billing', 'public', () => {
      const r = rig(['page', '--work', id, '--publish', pageFile({ pr })])
      assert.equal(r.code, 0, r.out)
      assert.equal(prOf(stage).body, 'What a person wrote.', 'the region goes, and the text stays')
      assert.match(r.out, /may not carry that link.*docs\.acme\.example\.invalid/)
    })
  } finally {
    setPages('acme/rig-data', SITE)
  }
})

test('an edit made to a stage PR while the page uploads survives the link, its title included', () => {
  const id = 'staged-edited'
  const stage = stagedWork(id)
  const state = github()
  state.afterPutPage = { spec: 'acme/billing', number: prOf(stage).number, change: { body: 'Edited meanwhile.', title: 'Retitled meanwhile' } }
  setGithub(state)
  assert.equal(rig(['page', '--work', id, '--publish', pageFile({ pr: prOf(stage).url })]).code, 0)
  assert.match(prOf(stage).body, /Edited meanwhile\.$/)
  assert.equal(prOf(stage).title, 'Retitled meanwhile')
})

test('a page belongs to its PR\'s number: a new PR on the branch gets no old link, and is offered its own', () => {
  const branch = workWithPr('reopened')
  assert.equal(rig(['page', 'billing', '--work', 'reopened', '--publish', pageFile({ pr: prOf(branch).url })]).code, 0)
  assert.equal(record('reopened').repos[0].branches.find(b => b.branch === branch).page.number, prOf(branch).number)
  const state = github()
  const prs = state.repos['acme/billing'].prs
  const old = prs.find(p => p.branch === branch)
  old.state = 'CLOSED'
  const number = Math.max(...prs.map(p => p.number)) + 1
  prs.push({ ...old, number, url: `https://github.com/acme/billing/pull/${number}`, state: 'OPEN', body: 'x', title: 'reopened' })
  setGithub(state)

  const said = rig(['next', '--work', 'reopened']).out
  assert.match(said, /this PR is 1,240 lines across 31 files/, 'offered its own')
  rig(['pr', '--refresh', '--work', 'reopened'])
  const fresh = github().repos['acme/billing'].prs.find(p => p.number === number)
  assert.doesNotMatch(fresh.body, /Reading page/)
  assert.equal(JSON.parse(rig(['page', '--work', 'reopened', '--json']).out)[0].page, null)
})

test('by URL, a PR not open is said, and a head the PR has moved past is said at the publish', () => {
  const url = 'https://github.com/acme/refunds/pull/77'
  const state = github()
  Object.assign(state.repos['acme/refunds'].prs[0], { state: 'MERGED', head: NEWER })
  setGithub(state)
  assert.match(rig(['page', url]).out, /acme\/refunds#77 is merged/)
  assert.equal(JSON.parse(rig(['page', url, '--json']).out)[0].pr.state, 'MERGED')
  const r = rig(['page', url, '--publish', pageFile({ pr: url, head: HEAD })])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /is merged/)
  assert.match(r.out, /head has moved past its reading page \(page at aaaaaaa, PR at bbbbbbb\)/)
})

test('--publish naming a directory is refused in plain words', () => {
  const r = rig(['page', OUTSIDE, '--publish', tmp])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /is not a file/)
  assert.doesNotMatch(r.out, /EISDIR/)
})

test('a URL\'s typed casing goes no further than the lookup: the path uses GitHub\'s names', () => {
  const typed = 'https://github.com/ACME/Orders/pull/55'
  const r = rig(['page', typed, '--publish', pageFile({ pr: OUTSIDE })])
  assert.equal(r.code, 0, r.out)
  assert.equal(writes('acme/rig-data').at(-1).path, 'rig-pr-pages/acme/orders/55/index.html')
  assert.equal(JSON.parse(rig(['page', typed, '--json']).out)[0].spec, 'acme/orders')
})

test('a write the site refuses says so and records nothing', () => {
  const branch = workWithPr('put-refused')
  const state = github()
  state.repos['acme/rig-data'].pagePutFails = 'gh: Resource not accessible (HTTP 403)'
  setGithub(state)
  try {
    const r = rig(['page', 'billing', '--work', 'put-refused', '--publish', pageFile({ pr: prOf(branch).url })])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /could not publish to acme\/rig-data \(gh: Resource not accessible \(HTTP 403\)\) — nothing recorded/)
    assert.equal(record('put-refused').repos[0].branches.find(b => b.branch === branch).page, undefined)
  } finally {
    const clear = github()
    delete clear.repos['acme/rig-data'].pagePutFails
    setGithub(clear)
  }
})

test('a link GitHub refuses says so and prints the line, and the page stays recorded', () => {
  const id = 'staged-refused'
  const stage = stagedWork(id)
  const state = github()
  state.repos['acme/billing'].editPrFails = 'gh: Resource not accessible (HTTP 403)'
  setGithub(state)
  try {
    const r = rig(['page', '--work', id, '--publish', pageFile({ pr: prOf(stage).url })])
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /could not write the link into PR #\d+ \(gh: Resource not accessible \(HTTP 403\)\) — Reading page, at `aaaaaaa`:/)
    assert.equal(prOf(stage).body, 'What a person wrote.')
    assert.ok(record(id).repos[0].branches.find(b => b.branch === stage).page)
  } finally {
    const clear = github()
    delete clear.repos['acme/billing'].editPrFails
    setGithub(clear)
  }
})

// ------------------------------------------------- the record

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
  assert.match(rig(['status', '--work', 'big-pr']).out, /page +at bbbbbbb https:\/\/wandering-otter-1a2b3c\.pages\.github\.io/)
  const listed = JSON.parse(rig(['list', '--json']).out)
  const list = Array.isArray(listed) ? listed : listed.works
  const big = list.find(w => w.id === 'big-pr')
  assert.equal(big.repos[0].branches.find(b => b.branch === 'feat/big-pr').page.head, NEWER)
})

// ------------------------------------------------- a stack on side branches

// A work whose PRs are a stack on branches of their own, each checked out outside the work's
// worktrees: the work branch has no PR, the lowest layer is based on main and the next on it.
const SIDE = 'feat/side-layer-a'
const SIDE_ABOVE = 'feat/side-layer-b'
const sideUrl = n => `https://github.com/acme/billing/pull/${n}`
const sideRecord = id => record(id).repos[0].branches.find(b => b.branch === SIDE)
function sideStack (id) {
  assert.equal(rig(['new', id, '--title', id, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  m.seedPr({ branch: SIDE, base: 'main', number: 901, url: sideUrl(901), state: 'OPEN', title: 'Layer a', body: 'What a person wrote.', head: HEAD, additions: 7000, deletions: 553, changedFiles: 69 })
  m.seedPr({ branch: SIDE_ABOVE, base: SIDE, number: 902, url: sideUrl(902), state: 'OPEN', title: 'Layer b', body: 'Layer b.', head: HEAD, additions: 900, deletions: 2, changedFiles: 3 })
}

test('`rig page <url> --adopt` makes a side branch\'s PR the work\'s: recorded on its branch, offered by `rig next`, listed by `rig page`', () => {
  sideStack('side')
  assert.doesNotMatch(rig(['next', '--work', 'side']).out, /reading page/, 'rig cannot find it for itself')
  const r = rig(['page', sideUrl(901), '--adopt', '--work', 'side'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /PR #901 on feat\/side-layer-a is now side's/)
  assert.ok(sideRecord('side').adoptedAt)
  assert.match(gitMust(dataRoot, 'log', '-1', '--format=%s'), /side/, 'mutating, like --publish')
  assert.match(rig(['next', '--work', 'side']).out, /billing \(feat\/side-layer-a\): this PR is 7,553 lines across 69 files[\s\S]*rig-pr-page skill/)
  const facts = JSON.parse(rig(['page', '--work', 'side', '--json']).out)
  const fact = facts.find(f => f.pr?.branch === SIDE)
  assert.equal(fact.adopted, true)
  assert.equal(fact.stage, false)
  assert.equal(fact.due, true)
  assert.equal(fact.pr.url, sideUrl(901))
  assert.match(fact.source, /work[\\/]side[\\/]pages[\\/]billing-901\.md$/)
  assert.equal(facts.find(f => f.pr?.branch === SIDE_ABOVE), undefined, 'a layer adopted alone leaves the rest outside')
  const listed = JSON.parse(rig(['list', '--json']).out)
  const side = (Array.isArray(listed) ? listed : listed.works).find(w => w.id === 'side')
  assert.equal(side.repos[0].branches.find(b => b.branch === SIDE).adoptedAt, sideRecord('side').adoptedAt)
})

test('adopting again changes nothing, and the work\'s own PR is already its own', () => {
  const before = fs.readFileSync(path.join(dataRoot, 'work', 'side', 'work.json'), 'utf8')
  const r = rig(['page', sideUrl(901), '--adopt', '--work', 'side'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /already side's/)
  assert.equal(fs.readFileSync(path.join(dataRoot, 'work', 'side', 'work.json'), 'utf8'), before)

  const big = fs.readFileSync(path.join(dataRoot, 'work', 'big-pr', 'work.json'), 'utf8')
  const own = rig(['page', prOf('feat/big-pr').url, '--adopt', '--work', 'big-pr'])
  assert.equal(own.code, 0, own.out)
  assert.match(own.out, /already big-pr's/)
  assert.equal(fs.readFileSync(path.join(dataRoot, 'work', 'big-pr', 'work.json'), 'utf8'), big)
})

test('adopting refuses a PR of a repo not attached, one not open and one from a fork, and records nothing', () => {
  seedOutside()
  m.seedPr({ branch: 'feat/side-old', base: 'main', number: 903, url: sideUrl(903), state: 'MERGED', head: HEAD, additions: 1, deletions: 0, changedFiles: 1 })
  m.seedPr({ branch: 'someone:feat/theirs', base: 'main', number: 904, url: sideUrl(904), state: 'OPEN', head: HEAD, additions: 1, deletions: 0, changedFiles: 1 })
  const before = fs.readFileSync(path.join(dataRoot, 'work', 'side', 'work.json'), 'utf8')
  const refused = (url, why) => {
    const r = rig(['page', url, '--adopt', '--work', 'side'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, why)
  }
  refused(OUTSIDE, /acme\/orders is not attached to side/)
  refused(sideUrl(903), /is merged/)
  refused(sideUrl(904), /from a fork/)
  refused(sideUrl(9999), /GitHub has no pull request/)
  assert.equal(fs.readFileSync(path.join(dataRoot, 'work', 'side', 'work.json'), 'utf8'), before)
})

test('an adopted PR\'s page publishes from the page itself, is recorded on its branch, and is linked in a region of its body', () => {
  const r = rig(['page', '--work', 'side', '--publish', pageFile({ pr: sideUrl(901) })])
  assert.equal(r.code, 0, r.out)
  assert.ok(writes('acme/rig-data').some(w => w.path === 'rig-pr-pages/acme/billing/901/index.html'))
  assert.equal(sideRecord('side').page.head, HEAD)
  assert.equal(sideRecord('side').page.number, 901)
  const { body } = prOf(SIDE)
  assert.match(body, /^<!-- rig:reading-page -->\nReading page, at `aaaaaaa`: https:\/\/wandering-otter-1a2b3c\.pages\.github\.io\/rig-pr-pages\/acme\/billing\/901\/\n<!-- \/rig:reading-page -->/)
  assert.match(body, /What a person wrote\.$/)
  assert.doesNotMatch(rig(['next', '--work', 'side']).out, /reading page/, 'nothing more to offer')
})

test('standing in the work, its adopted PR by URL is the work\'s: the publish is recorded and linked', () => {
  const r = rig(['page', sideUrl(901), '--work', 'side', '--publish', pageFile({ pr: sideUrl(901), head: NEWER })])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /recorded nowhere/)
  assert.equal(sideRecord('side').page.head, NEWER)
  const { body } = prOf(SIDE)
  assert.equal(body.split('<!-- rig:reading-page -->').length, 2, 'one region')
  assert.match(body, /Reading page, at `bbbbbbb`/)
  const [fact] = JSON.parse(rig(['page', sideUrl(901), '--work', 'side', '--json']).out)
  assert.equal(fact.adopted, true)
  assert.equal(fact.outside, undefined)
  assert.equal(fact.page.head, NEWER)
})

test('an adopted PR whose head moved past its page is said by `rig next` and `rig page`', () => {
  setPr(SIDE, { head: HEAD })
  assert.match(rig(['next', '--work', 'side']).out, /billing \(feat\/side-layer-a\): the PR's head has moved past its reading page \(page at bbbbbbb, PR at aaaaaaa\)/)
  const [fact] = JSON.parse(rig(['page', sideUrl(901), '--work', 'side', '--json']).out)
  assert.equal(fact.stale, true)
})

test('a PR of an attached repo the work has not adopted stays outside it: recorded nowhere, written to nothing', () => {
  const before = fs.readFileSync(path.join(dataRoot, 'work', 'side', 'work.json'), 'utf8')
  const [fact] = JSON.parse(rig(['page', sideUrl(902), '--work', 'side', '--json']).out)
  assert.equal(fact.outside, true)
  const r = rig(['page', sideUrl(902), '--work', 'side', '--publish', pageFile({ pr: sideUrl(902) })])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /recorded nowhere/)
  assert.equal(prOf(SIDE_ABOVE).body, 'Layer b.')
  assert.equal(fs.readFileSync(path.join(dataRoot, 'work', 'side', 'work.json'), 'utf8'), before)
})

test('`--disown` gives an adopted PR back: no longer offered or listed, its page left where it is', () => {
  const r = rig(['page', sideUrl(901), '--disown', '--work', 'side'])
  assert.equal(r.code, 0, r.out)
  assert.equal(sideRecord('side').adoptedAt, undefined)
  assert.equal(sideRecord('side').page.head, NEWER, 'the page stays where it is')
  assert.doesNotMatch(rig(['next', '--work', 'side']).out, /feat\/side-layer-a/)
  assert.equal(JSON.parse(rig(['page', '--work', 'side', '--json']).out).find(f => f.pr?.branch === SIDE), undefined)
  const again = rig(['page', sideUrl(901), '--disown', '--work', 'side'])
  assert.equal(again.code, 1, again.out)
  assert.match(again.out, /side has not adopted/)
})
