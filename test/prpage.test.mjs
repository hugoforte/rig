// A reading page's decisions, over fixtures: when one is due, where it may go, and what is said.
// Pure like `bin/next.mjs`, so the table that keeps a page from being read by more people than the
// code is one object literal per row.
import test from 'node:test'
import assert from 'node:assert/strict'

import { PAGE_DEFAULTS, pageThreshold, pageSize, pageDue, pageSite, pageAddress, pageMetas, pageLine, pageSaying, pageSourceAllowed } from '../bin/prpage.mjs'

// ------------------------------------------------- how big is big

test('a page is due at 500 lines or 20 files by default, whichever comes first', () => {
  const threshold = pageThreshold({})
  assert.deepEqual(PAGE_DEFAULTS, { lines: 500, files: 20 })
  assert.equal(pageDue({ lines: 499, files: 19 }, threshold), false)
  assert.equal(pageDue({ lines: 500, files: 1 }, threshold), true)
  assert.equal(pageDue({ lines: 3, files: 20 }, threshold), true)
})

test('a PR\'s size is its additions and deletions and its changed files, and unknown when GitHub gave none', () => {
  assert.deepEqual(pageSize({ additions: 400, deletions: 150, changedFiles: 9 }), { lines: 550, files: 9 })
  assert.equal(pageSize({ number: 3 }), null)
  assert.equal(pageSize(null), null)
  assert.equal(pageDue(null, pageThreshold({})), false)
})

test('the threshold is per measure: the repo over the org over the default', () => {
  const t = pageThreshold({ org: { lines: 800, files: 40 }, repo: { files: '10' } })
  assert.deepEqual([t.lines, t.files], [800, 10])
  assert.deepEqual(t.problems, [])
})

test('`off` drops a measure, and both off is never due', () => {
  const lines = pageThreshold({ repo: { lines: 'off' } })
  assert.equal(pageDue({ lines: 100000, files: 1 }, lines), false)
  assert.equal(pageDue({ lines: 1, files: 20 }, lines), true)
  assert.equal(pageDue({ lines: 100000, files: 1000 }, pageThreshold({ org: { lines: 'off', files: 'off' } })), false)
})

test('a value that is no threshold is named and passed over: a typo must not stop `rig pr`', () => {
  const t = pageThreshold({ org: { lines: 800 }, repo: { lines: 'lots', files: -3 } })
  assert.deepEqual([t.lines, t.files], [800, 20], 'the next level answers')
  assert.equal(t.problems.length, 2)
  assert.match(t.problems[0], /"lots"/)
})

// ------------------------------------------------- where it may go

const SITE = { url: 'https://example.invalid/site/', public: false, branch: 'gh-pages', path: '/', build: 'legacy' }
const PUBLIC_SITE = { ...SITE, public: true }
const root = over => ({ spec: 'acme/rig-data', visibility: 'private', site: null, ...over })
const place = over => pageSite({ spec: 'acme/billing', visibility: 'private', own: null, root: root(), ...over })

const refused = (name, over, why) => test(`no page: ${name}`, () => {
  const r = place(over)
  assert.equal(r.host, undefined, `expected no site, got ${JSON.stringify(r)}`)
  assert.match(r.why, why)
  assert.ok(!r.why.includes('\n'), 'one plain line')
})
const hosted = (name, over, host) => test(`${host} site: ${name}`, () => {
  const r = place(over)
  assert.equal(r.host, host, r.why)
  assert.equal(r.spec, host === 'repo' ? (over.spec || 'acme/billing') : (over.root?.spec || 'acme/rig-data'))
  assert.equal(r.branch, 'gh-pages')
})

hosted('a private repo and a private data root with one owner, on an access-controlled site', { root: root({ site: SITE }) }, 'root')
hosted('a private repo\'s own access-controlled site, whatever the data root is', { own: SITE, root: { none: true } }, 'repo')
hosted('the repo\'s own comes first: its readers are the code\'s exactly', { own: SITE, root: root({ site: SITE }) }, 'repo')
hosted('a public repo\'s own public site', { visibility: 'public', own: PUBLIC_SITE, root: root() }, 'repo')
hosted('a public repo and a public data root, whoever owns it', { visibility: 'public', root: root({ spec: 'other/rig-data', visibility: 'public', site: PUBLIC_SITE }) }, 'root')
hosted('an internal repo and an internal data root', { visibility: 'internal', root: root({ visibility: 'internal', site: SITE }) }, 'root')
hosted('a private repo whose own site is public falls through to the data root', { own: PUBLIC_SITE, root: root({ site: SITE }) }, 'root')

refused('a private repo\'s public site, as Pages is outside Enterprise', { own: PUBLIC_SITE, root: root() }, /own Pages site is public/)
refused('a private data root whose site is public', { root: root({ site: PUBLIC_SITE }) }, /data root's Pages site is public/)
refused('a site that does not say it is restricted reads as public', { root: root({ site: { ...SITE, public: undefined } }) }, /data root's Pages site is public/)
refused('a private data root under another owner has unrelated readers', { root: root({ spec: 'other/rig-data', site: SITE }) }, /another owner/)
refused('a public repo and a private data root: the link would name it', { visibility: 'public', root: root({ site: SITE }) }, /more visible than the data root/)
refused('a private repo and a public data root: the page would outreach the code', { root: root({ visibility: 'public', site: PUBLIC_SITE }) }, /wider than/)
refused('an internal repo and a private data root: the link would name it', { visibility: 'internal', root: root({ site: SITE }) }, /more visible than the data root/)
refused('a data root with no remote', { root: { none: true } }, /data root has no remote/)
refused('a data root that is not on GitHub', { root: { elsewhere: true } }, /not on GitHub/)
refused('a data root with no site', { root: root() }, /data root has no Pages site/)
refused('a data root whose visibility GitHub would not say', { root: root({ visibility: null, site: SITE }) }, /would not say how visible the data root is/)
refused('a data root whose site GitHub would not say', { root: root({ site: undefined }) }, /would not say whether the data root has a Pages site/)
refused('a repo whose visibility GitHub would not say, or that is not on GitHub', { visibility: null, own: SITE, root: root({ site: SITE }) }, /would not say how visible acme\/billing is/)
refused('a repo whose own site GitHub would not say, and nowhere else', { own: undefined }, /would not say whether it has a Pages site/)
refused('a site built by a workflow, which a branch cannot publish to', { own: { ...SITE, build: 'workflow' }, root: { none: true } }, /gh-pages/)
refused('a site published from the default branch, which rig must not commit to', { own: { ...SITE, branch: 'main' }, root: { none: true } }, /gh-pages/)
refused('a site published from a folder of the branch', { own: { ...SITE, path: '/docs' }, root: { none: true } }, /gh-pages/)

// The two rows decision 223 rests on, and the two a comparison of visibilities alone gets wrong.
test('a private repo\'s site that is public is refused: Pages from a private repo is on the open internet outside Enterprise', () => {
  assert.equal(place({ own: PUBLIC_SITE, root: root({ site: PUBLIC_SITE }) }).host, undefined)
})

test('a public repo beside a private data root is refused the data root\'s site: its link would name the data root', () => {
  assert.equal(place({ visibility: 'public', root: root({ site: SITE }) }).host, undefined)
})

test('the reason names both places, so one line says what would change the answer', () => {
  const { why } = place({ visibility: 'public', root: root() })
  assert.match(why, /^acme\/billing .*it has no Pages site.*data root/)
})

// ------------------------------------------------- the address and the page's own word

test('a page lives under one folder of the site, addressed by the PR', () => {
  const { path, url } = pageAddress({ url: 'https://example.invalid/site/' }, 'acme', 'billing', 12)
  assert.equal(path, 'rig-pr-pages/acme/billing/12/index.html')
  assert.equal(url, 'https://example.invalid/site/rig-pr-pages/acme/billing/12/')
  assert.equal(pageAddress({ url: 'https://example.invalid/site' }, 'acme', 'billing', 12).url, url, 'with or without the trailing slash')
})

const HEAD = 'a'.repeat(40)
test('the page says which PR and head it describes, in its metas', () => {
  const html = `<head><meta name="rig:pr" content="https://github.com/acme/billing/pull/12"><meta name="rig:head" content="${HEAD}"></head>`
  assert.deepEqual(pageMetas(html), { pr: 'https://github.com/acme/billing/pull/12', head: HEAD })
  assert.deepEqual(pageMetas('<head></head>'), { pr: null, head: null })
  assert.equal(pageMetas('<meta name="rig:head" content="nothex">').head, null, 'a head is a full commit id')
})

test('the PR body\'s line names the page and the commit it describes', () => {
  assert.equal(pageLine({ url: 'https://example.invalid/p/', head: HEAD }), `Reading page, at \`${HEAD.slice(0, 7)}\`: https://example.invalid/p/`)
})

// ------------------------------------------------- what is said

const fact = over => ({ repo: 'billing', size: { lines: 1240, files: 31 }, threshold: { lines: 500, files: 20 }, due: true, page: null, prHead: HEAD, ...over })

test('a page that is due is offered, with the size and the skill that writes it', () => {
  const s = pageSaying(fact())
  assert.match(s.says, /^billing: this PR is 1,240 lines across 31 files/)
  assert.match(s.says, /500 lines or 20 files/)
  assert.match(s.says, /the rig-pr-page skill writes/)
  assert.equal(s.command, 'rig page')
})

test('a threshold with a measure off names only the other', () => {
  assert.match(pageSaying(fact({ threshold: { lines: null, files: 20 } })).says, /\(20 files\)/)
})

test('a page that is due with no safe place says why, on one plain line, and offers nothing', () => {
  const s = pageSaying(fact({ why: 'acme/billing is public: it has no Pages site' }))
  assert.equal(s.says, 'billing: no reading page — acme/billing is public: it has no Pages site')
  assert.equal(s.command, null)
})

test('a PR under the threshold, or one whose page is current, has nothing said', () => {
  assert.equal(pageSaying(fact({ due: false })), null)
  assert.equal(pageSaying(fact({ page: { head: HEAD, url: 'https://example.invalid/' } })), null)
})

test('a head moved past the page is said with both commits, however small the PR', () => {
  const s = pageSaying(fact({ due: false, prHead: 'b'.repeat(40), page: { head: HEAD, url: 'https://example.invalid/' } }))
  assert.match(s.says, /head has moved past its reading page \(page at aaaaaaa, PR at bbbbbbb\)/)
  assert.match(s.says, /rig-pr-page skill/)
})

test('a head nobody could read is no moved head', () => {
  assert.equal(pageSaying(fact({ prHead: null, page: { head: HEAD, url: 'https://example.invalid/' } })), null)
})

// ------------------------------------------------- where the source is kept

test('a page\'s source stays in the data root only where the data root is no wider than the code', () => {
  assert.equal(pageSourceAllowed('public', 'private'), true)
  assert.equal(pageSourceAllowed('private', 'private'), true)
  assert.equal(pageSourceAllowed('private', 'public'), false)
  assert.equal(pageSourceAllowed('private', 'elsewhere'), false)
  assert.equal(pageSourceAllowed(null, 'private'), false)
  assert.equal(pageSourceAllowed('private', null), false)
})
