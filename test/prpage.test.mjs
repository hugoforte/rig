// A reading page's decisions, over fixtures: when one is due, where it may go, and what is said.
// Pure like `bin/next.mjs`, so the table that keeps a page from being read by more people than the
// code is one object literal per row.
import test from 'node:test'
import assert from 'node:assert/strict'

import { PAGE_DEFAULTS, pageThreshold, pageSize, pageDue, pageSite, pageAddress, pageMetas, pageLine, pageSaying, pageSourceAllowed, pageLinkable, pageRegion, prFromUrl } from '../bin/prpage.mjs'

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

const SITE = { url: 'https://wandering-otter-1a2b3c.pages.github.io/', public: false, branch: 'gh-pages', path: '/', build: 'legacy' }
const PUBLIC_SITE = { ...SITE, public: true }
const root = over => ({ spec: 'acme/rig-data', visibility: 'private', site: SITE, ...over })
const place = over => pageSite({ spec: 'acme/billing', visibility: 'private', root: root(), ...over })

const refused = (name, over, why) => test(`no page: ${name}`, () => {
  const r = place(over)
  assert.equal(r.spec, undefined, `expected no site, got ${JSON.stringify(r)}`)
  assert.match(r.why, why)
  assert.ok(!r.why.includes('\n'), 'one plain line')
})
const hosted = (name, over) => test(`the data root's site: ${name}`, () => {
  const r = place(over)
  assert.equal(r.spec, over.root?.spec || 'acme/rig-data', r.why)
  assert.equal(r.branch, 'gh-pages')
  assert.equal(r.url, SITE.url)
})

hosted('a private repo and a private data root with one owner', {})
hosted('an internal repo and an internal data root', { visibility: 'internal', root: root({ visibility: 'internal' }) })
hosted('an internal repo and a private data root with one owner', { visibility: 'internal' })
hosted('a public repo and a private data root, whose readers are fewer than the code\'s', { visibility: 'public' })
hosted('a public repo and a private data root under another owner, since anyone can read the code', { visibility: 'public', root: root({ spec: 'other/rig-data' }) })

refused('a private data root under another owner has unrelated readers', { root: root({ spec: 'other/rig-data' }) }, /another owner/)
refused('an internal repo and a private data root under another owner', { visibility: 'internal', root: root({ spec: 'other/rig-data' }) }, /another owner/)
refused('a private repo and an internal data root: the page would outreach the code', { root: root({ visibility: 'internal' }) }, /wider than/)
refused('a data root with no remote', { root: { none: true } }, /data root has no remote/)
refused('a data root that is not on GitHub', { root: { elsewhere: true } }, /not on GitHub/)
refused('a data root with no site says what it would take', { root: root({ site: null }) }, /\(acme\/rig-data\) has no Pages site: turn it on in its Pages settings, deploying from the root of a gh-pages branch; on a personal account that site is public, and a private one takes GitHub Enterprise Cloud/)
refused('a data root whose visibility GitHub would not say', { root: root({ visibility: null }) }, /would not say how visible the data root is/)
refused('a data root whose site GitHub would not say', { root: root({ site: undefined }) }, /would not say whether the data root has a Pages site/)
refused('a repo whose visibility GitHub would not say, or that is not on GitHub', { visibility: null }, /would not say how visible acme\/billing is/)
refused('a site built by a workflow says what to change', { root: root({ site: { ...SITE, build: 'workflow', branch: 'main' } }) }, /served from main by a workflow.*Pages settings.*root of a gh-pages branch/)
refused('a site served from the data root\'s own main says what to change', { root: root({ site: { ...SITE, branch: 'main' } }) }, /served from main.*Pages settings.*root of a gh-pages branch/)
refused('a site served from a folder of the branch says what to change', { root: root({ site: { ...SITE, path: '/docs' } }) }, /gh-pages\/docs.*root of a gh-pages branch/)

// The rows decision 223 rests on.
const THE_PUBLIC_LINE = 'this page will be public: the data root\'s Pages site is on the open internet'

test('public code on a public site goes up, saying in one line that the page is public', () => {
  for (const rootOver of [{ site: PUBLIC_SITE }, { visibility: 'public', site: PUBLIC_SITE }, { spec: 'other/rig-data', site: PUBLIC_SITE }]) {
    const r = place({ visibility: 'public', root: root(rootOver) })
    assert.equal(r.spec, rootOver.spec || 'acme/rig-data', r.why)
    assert.equal(r.needsPublicFlag, false)
    assert.equal(r.warning, THE_PUBLIC_LINE)
  }
})

test('non-public code on a public site needs the flag, and says a page cannot be taken back', () => {
  for (const visibility of ['private', 'internal']) {
    const r = place({ visibility, root: root({ site: PUBLIC_SITE }) })
    assert.equal(r.why, undefined)
    assert.equal(r.needsPublicFlag, true)
    assert.equal(r.warning, `this page would be public: the data root's Pages site is on the open internet, and acme/billing is ${visibility}. A published page cannot be taken back, so publishing it takes --public and the person's word for this page`)
  }
})

test('non-public code on a public site is not stopped by the private site\'s owner and width rules', () => {
  assert.equal(place({ root: root({ spec: 'other/rig-data', visibility: 'public', site: PUBLIC_SITE }) }).needsPublicFlag, true)
})

test('a site that does not say exactly public: false counts as public, and says so', () => {
  for (const site of [{ ...SITE, public: undefined }, { ...SITE, public: 'false' }, { ...SITE, public: null }]) {
    const code = place({ visibility: 'public', root: root({ site }) })
    assert.equal(code.needsPublicFlag, false)
    assert.match(code.warning, /^this page will be public: the data root's Pages site does not say it is private, so it counts as public$/)
    assert.equal(place({ root: root({ site }) }).needsPublicFlag, true)
  }
})

test('a private site carries no warning and needs no flag', () => {
  for (const visibility of ['private', 'internal', 'public']) {
    const r = place({ visibility })
    assert.equal(r.warning, undefined)
    assert.equal(r.needsPublicFlag, false)
  }
})

test('a public site served from main is still refused: rig writes only to gh-pages', () => {
  assert.match(place({ visibility: 'public', root: root({ site: { ...PUBLIC_SITE, branch: 'main' } }) }).why, /gh-pages/)
})

test('the offer of a page on a public site carries the warning', () => {
  const says = warning => pageSaying({ repo: 'billing', size: { lines: 900, files: 3 }, threshold: { lines: 500, files: 20 }, due: true, page: null, prHead: null, warning }).says
  assert.ok(says(THE_PUBLIC_LINE).endsWith(` — ${THE_PUBLIC_LINE}`), says(THE_PUBLIC_LINE))
})

test('a public repo\'s page may sit on a private data root, however different the owner', () => {
  assert.equal(place({ visibility: 'public', root: root({ spec: 'other/rig-data' }) }).spec, 'other/rig-data')
})

test('a page reaches no further than its code: one owner below public, and no wider data root', () => {
  assert.equal(place({ root: root({ spec: 'other/rig-data' }) }).spec, undefined)
  assert.equal(place({ root: root({ visibility: 'internal' }) }).spec, undefined)
})

test('a site served from main is refused, with what to change', () => {
  assert.match(place({ root: root({ site: { ...SITE, branch: 'main' } }) }).why, /gh-pages/)
})

// ------------------------------------------------- the link

test('a private site\'s random host names no repo, so its link goes into any PR', () => {
  assert.equal(pageLinkable('https://wandering-otter-1a2b3c.pages.github.io/rig-pr-pages/acme/billing/12/', false), true)
  assert.equal(pageLinkable('https://wandering-otter-1a2b3c.pages.github.io/rig-pr-pages/acme/billing/12/', null), true)
})

test('any other address goes by the context doc\'s rule, since it may name the data root', () => {
  for (const url of ['https://docs.example.invalid/rig-pr-pages/acme/billing/12/', 'https://acme.github.io/rig-data/rig-pr-pages/acme/billing/12/', 'https://pages.github.io.example.invalid/x/']) {
    assert.equal(pageLinkable(url, true), true, url)
    assert.equal(pageLinkable(url, false), false, url)
    assert.equal(pageLinkable(url, null), false, url)
  }
})

test('a stage PR\'s link is a region at the top of its body, leaving the rest as written', () => {
  const page = { url: 'https://wandering-otter-1a2b3c.pages.github.io/p/', head: 'a'.repeat(40) }
  const once = pageRegion('What a person wrote.\n\nMore.', page)
  assert.match(once, /^<!-- rig:reading-page -->\nReading page, at `aaaaaaa`: https:\S+\n<!-- \/rig:reading-page -->\n\nWhat a person wrote\.\n\nMore\.$/)
  assert.equal(pageRegion(once, page), once, 'the same page changes nothing')
  const moved = pageRegion(`${once}\n\nAdded later.`, { ...page, head: 'b'.repeat(40) })
  assert.match(moved, /Reading page, at `bbbbbbb`/)
  assert.doesNotMatch(moved, /aaaaaaa/)
  assert.match(moved, /What a person wrote\.\n\nMore\.\n\nAdded later\.$/)
  assert.equal(moved.match(/<!-- rig:reading-page -->/g).length, 1, 'one opening marker')
  assert.match(pageRegion('', page), /^<!-- rig:reading-page -->/)
  assert.match(pageRegion(null, page), /^<!-- rig:reading-page -->/)
})

test('a PR by URL gives its org, repo and number, and anything else is refused', () => {
  assert.deepEqual(prFromUrl('https://github.com/acme/billing/pull/12'), { org: 'acme', repo: 'billing', number: 12, url: 'https://github.com/acme/billing/pull/12' })
  assert.deepEqual(prFromUrl('https://github.com/acme/billing/pull/12/files').number, 12)
  assert.equal(prFromUrl('https://gitlab.example.invalid/acme/billing/pull/12'), null)
  assert.equal(prFromUrl('billing'), null)
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

test('a branch with no PR yet is told what is coming, and that the page follows the PR', () => {
  const s = pageSaying(fact({ upcoming: true, prHead: null }))
  assert.match(s.says, /^billing: about 1,240 lines across 31 files, over the size for a reading page/)
  assert.match(s.says, /the rig-pr-page skill/)
  assert.equal(s.command, 'rig pr')
  assert.equal(pageSaying(fact({ upcoming: true, prHead: null, due: false })), null)
  assert.match(pageSaying(fact({ upcoming: true, prHead: null, why: 'no site' })).says, /no reading page — no site/)
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
