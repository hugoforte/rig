// The shipped reading page's machinery: `skills/rig-pr-page/build.mjs` over an invented PR, and,
// on a machine with Chrome, `check.mjs` clicking through what it built. No test here publishes.
import { test, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildPage, PageBuildError } from '../skills/rig-pr-page/build.mjs'
import { findChrome } from '../skills/rig-pr-page/check.mjs'
import { PAGE_SOURCE, PR_URL, prRepo, DOCS_ONLY } from './pr-page-fixture.mjs'
import { pageMetas } from '../bin/prpage.mjs'

const CHECK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'skills', 'rig-pr-page', 'check.mjs')
const SOURCE = fs.readFileSync(PAGE_SOURCE, 'utf8')

let fixture
before(() => { fixture = prRepo() })
after(() => fixture.clean())

const build = (source = SOURCE, over = {}) => buildPage({ source, pr: PR_URL, head: fixture.headSha, base: 'main', branch: 'feat/retries', repoDir: fixture.repo, builtAt: '2026-11-07', ...over })
const dataOf = html => JSON.parse(/<script id="data" type="application\/json">(.*?)<\/script>/s.exec(html)[1])
const built = () => dataOf(build().html)

const problemsOf = source => {
  try {
    build(source)
  } catch (e) {
    assert.ok(e instanceof PageBuildError, e.stack)
    return e.problems.join('\n')
  }
  assert.fail('the build should have failed')
}
const withEntity = text => `${SOURCE}\n# open/added: Added by the test\n\n${text}\n`

test('the page says which PR and head it describes, in the metas `rig page --publish` reads', () => {
  const metas = pageMetas(build().html)
  assert.equal(metas.pr, PR_URL)
  assert.equal(metas.head, fixture.headSha)
})

test('the page asks nothing of the network: one file, a closed content policy, no index', () => {
  const { html } = build()
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'/)
  assert.match(html, /name="robots" content="noindex"/)
  assert.doesNotMatch(html, /<script[^>]+src=|<link[^>]+href=/)
})

test('a code PR\'s parts, their connections and their status reach the page', () => {
  const { ent } = built()
  assert.equal(ent['part/queue'].status, 'changed')
  assert.equal(ent['part/journal'].status, 'new')
  assert.equal(ent['part/timer'].status, 'removed')
  assert.deepEqual(ent['part/queue'].uses, ['part/journal', 'part/clock'])
  assert.deepEqual(ent['part/journal'].usedBy, ['part/queue'], 'a connection reads both ways')
  assert.match(ent['flow/restart'].html, /class="callout before"/)
  assert.match(ent['flow/restart'].html, /class="callout after"/)
  assert.match(ent['flow/restart'].html, /class="step"/)
})

test('everything lists what mentions it', () => {
  const { back } = built()
  assert.ok(back['part/journal'].includes('flow/restart'))
  assert.ok(back['part/queue'].includes('part/gauge'))
  assert.ok(back['risk/alert-storm'].includes('flow/outage'))
  assert.ok(back['file/tidewatch/queue.py'].includes('part/queue'), 'a part\'s files name it, and the file names the part')
  assert.ok(back['file/tests/test_queue.py'].includes('test/restart'), 'a citation is a mention of the file it cites')
})

test('a term a part or word declares links its first mention in each entity, in text and in code', () => {
  const { ent } = built()
  // The word's own mention is plain; the flow's first mention of "journal" through `aka` links.
  assert.match(ent['decision/journal-first'].html, /data-e="part\/journal"/)
  assert.doesNotMatch(ent['word/backoff'].html, /data-e="word\/backoff"/, 'nothing links itself')
})

test('every changed file is on the page, with its numbers, whether or not anyone discussed it', () => {
  const { ent, tabs, size } = built()
  assert.equal(ent['file/tidewatch/journal.py'].change, 'added')
  assert.equal(ent['file/tidewatch/retry_timer.py'].change, 'removed')
  assert.equal(ent['file/stations/station-22.toml'].change, 'modified')
  assert.equal(ent['file/stations/station-22.toml'].added, 1)
  assert.ok(tabs.some(t => t.id === 'files'))
  assert.ok(size.files >= 28, `an invented PR over the file threshold: ${size.files}`)
})

test('a changed file nothing discusses is reported and marked, and does not fail the build', () => {
  const trimmed = SOURCE.replace('files: tidewatch/clock.py\n', '').replace('files: tidewatch/gauge.py\n', '')
    .replace(/\{\{tidewatch\/gauge\.py:8 ~ self\.queue\.enqueue\}\} /, '')
  const { html, warnings } = build(trimmed)
  assert.ok(warnings.some(w => /tidewatch\/gauge\.py/.test(w)), warnings.join('\n'))
  assert.equal(dataOf(html).ent['file/tidewatch/gauge.py'].pill, 'not discussed')
})

test('a note under a file\'s own heading joins the entity generated for it', () => {
  const { ent } = built()
  assert.match(ent['file/README.md'].html, /A line in the README only/)
})

test('a citation opens the exact line at the head, and a base citation at the base', () => {
  const { ent } = built()
  assert.ok(ent['part/queue'].html.includes(`https://github.com/example-harbour/tidewatch/blob/${fixture.headSha}/tidewatch/queue.py?plain=1#L12`))
  assert.ok(ent['part/queue'].html.includes(`https://github.com/example-harbour/tidewatch/blob/${fixture.baseSha}/tidewatch/queue.py?plain=1#L6`))
})

test('the page shows the head it is at and links what has changed since', () => {
  const data = built()
  assert.equal(data.head, fixture.headSha)
  assert.equal(data.compare, `https://github.com/example-harbour/tidewatch/compare/${fixture.headSha}...feat/retries`)
  assert.equal(data.builtAt, '2026-11-07')
})

// ------------------------------------------------- what fails the build

test('a dead link fails the build, naming it and where it is', () => {
  assert.match(problemsOf(withEntity('See [[part/nowhere]].')), /dead link part\/nowhere in open\/added/)
})

test('a citation whose text has moved fails the build, saying what the line says now', () => {
  assert.match(problemsOf(withEntity('{{tidewatch/queue.py:12 ~ def dequeue}}')), /tidewatch\/queue\.py:12 .*"def dequeue".*def enqueue/)
})

test('a citation out of range, in a file not there, or with no text to expect fails the build', () => {
  assert.match(problemsOf(withEntity('{{tidewatch/queue.py:900 ~ x}}')), /out of range/)
  assert.match(problemsOf(withEntity('{{tidewatch/gone.py:1 ~ x}}')), /tidewatch\/gone\.py/)
  assert.match(problemsOf(withEntity('{{tidewatch/queue.py:12}}')), /needs the text/)
})

test('a duplicate id, an unknown kind, or a heading that is no entity fails the build', () => {
  assert.match(problemsOf(`${SOURCE}\n# part/queue: Again\n`), /duplicate part\/queue/)
  assert.match(problemsOf(`${SOURCE}\n# thing/queue: A thing\n`), /unknown kind "thing"/)
  assert.match(problemsOf(`${SOURCE}\n# Just a heading\n`), /Just a heading/)
})

test('a part that uses nothing real, or names a file that is not there, fails the build', () => {
  assert.match(problemsOf(`${SOURCE}\n# part/x: X\nuses: nothing-real\n`), /part\/x uses part\/nothing-real/)
  assert.match(problemsOf(`${SOURCE}\n# part/y: Y\nfiles: not/here.py\n`), /part\/y names not\/here\.py/)
})

test('a note on a file the PR did not change fails the build', () => {
  assert.match(problemsOf(`${SOURCE}\n# file/not/here.py: A note\n`), /file\/not\/here\.py/)
})

test('a head git does not have fails the build, and says what to do', () => {
  assert.throws(() => build(SOURCE, { head: 'f'.repeat(40) }), /fetch/)
})

test('a start card that names nothing fails the build', () => {
  assert.match(problemsOf(SOURCE.replace('start: flow/restart', 'start: flow/nowhere')), /flow\/nowhere/)
})

// ------------------------------------------------- what the page must not do

test('text from a diff or a source cannot run: it is escaped, and only safe links survive', () => {
  const { html } = build(withEntity('<script>alert(1)</script> [x](javascript:alert(1)) [y](https://example.invalid/ok)\n\n`</script><img src=x>`'))
  const { ent } = dataOf(html)
  assert.match(ent['open/added'].html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/)
  assert.doesNotMatch(ent['open/added'].html, /href="javascript:/)
  assert.match(ent['open/added'].html, /href="https:\/\/example\.invalid\/ok"/)
  // Closing tags in the data cannot end the data block early.
  assert.equal(html.match(/<script/g).length, 2, 'the data block and the code, and no more')
})

test('a replacement pattern in the text survives the template', () => {
  assert.match(dataOf(build(withEntity('It costs $& and $1 and $` today.')).html).ent['open/added'].html, /\$&amp; and \$1 and \$` today/)
})

test('the title is escaped into the document', () => {
  const { html } = build(SOURCE.replace('title: Retries that survive a restart', 'title: Retries <b>that</b> survive'))
  assert.match(html, /<title>Retries &lt;b&gt;that&lt;\/b&gt; survive/)
})

// ------------------------------------------------- a pull request of documents

test('a docs-only PR gets its sections as linked entities, its own links resolved and its braces left alone', () => {
  const docs = prRepo(DOCS_ONLY)
  try {
    const { html } = buildPage({ source: '---\ntitle: The operations page\n---\n\nThe operations doc learns about the journal.\n\n# word/journal: Journal\naka: journal\n\nA flat file.\n', pr: PR_URL, head: docs.headSha, base: 'main', branch: 'feat/retries', repoDir: docs.repo, builtAt: '2026-11-07' })
    const data = dataOf(html)
    const restarting = data.ent['sec/docs/operations.md#restarting']
    assert.ok(restarting, Object.keys(data.ent).join(', '))
    assert.match(restarting.html, /data-e="sec\/docs\/operations\.md#the-journal"/, 'a link in the doc stays on the page')
    assert.ok(data.back['sec/docs/operations.md#the-journal'].includes('sec/docs/operations.md#restarting'), 'and lists what mentions it')
    assert.ok(restarting.src.endsWith('/docs/operations.md?plain=1#L5'), restarting.src)
    assert.match(data.ent['sec/docs/operations.md#the-journal'].html, /\{\{FIELD\}\}/, 'a template word in a doc is only text')
    assert.deepEqual(data.ent['file/docs/operations.md'].sections, ['sec/docs/operations.md#operations', 'sec/docs/operations.md#restarting', 'sec/docs/operations.md#the-journal'])
    assert.ok(!data.tabs.some(t => t.id === 'map'), 'a tab with nothing in it is not shown')
  } finally {
    docs.clean()
  }
})

// ------------------------------------------------- the click-through

// Only where Chrome is on the machine. Not on CI, whose images' sandboxes differ: the checker is
// a tool an author runs, and a red build over a browser's sandbox would say nothing about rig.
const chrome = process.env.CI ? null : findChrome()
test('the built page clicks through in headless Chrome', { skip: chrome ? false : 'no Chrome here, or on CI', timeout: 90000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pr-page-check-'))
  try {
    const file = path.join(dir, 'dist.html')
    fs.writeFileSync(file, build().html)
    const r = spawnSync(process.execPath, [CHECK, file], { encoding: 'utf8', timeout: 80000 })
    assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`)
    assert.match(r.stdout, /all good/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
  }
})
