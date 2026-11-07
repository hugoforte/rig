#!/usr/bin/env node
// Clicks through a built reading page in headless Chrome, whatever the page is about: every tab,
// an entity from each, a followed link, back, forward, close, a deep link, search, a phone's width,
// and that nothing reaches the network. Exits 0 when all of it holds, 1 when something does not,
// and 2 when there is no Chrome to ask, or it will not run, which says nothing about the page.
//
//   node check.mjs <dist.html> [--shots <dir>]
//
// Standard library only. It speaks the DevTools protocol over `--remote-debugging-pipe` rather than
// a WebSocket, because rig runs on Node versions with no global WebSocket, and a pipe needs no port
// either. `CHROME` names the browser where it is somewhere unusual.
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export function findChrome (env = process.env) {
  if (env.CHROME) return env.CHROME
  const known = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ...['ProgramFiles', 'ProgramFiles(x86)', 'LocalAppData'].filter(k => env[k]).map(k => path.join(env[k], 'Google', 'Chrome', 'Application', 'chrome.exe')),
  ].find(p => fs.existsSync(p))
  if (known) return known
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const r = spawnSync(name, ['--version'], { stdio: 'ignore' })
    if (r.status === 0) return name
  }
  return null
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

// Chrome would not run, or stopped running, so the check has nothing to say about the page.
class BrowserUnavailable extends Error {}

// One browser and one page, over the pipe: fd 3 to Chrome, fd 4 from it, NUL between messages.
async function openBrowser (chrome, onProblem) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pr-page-chrome-'))
  const browser = spawn(chrome, ['--headless=new', '--remote-debugging-pipe', '--disable-gpu', '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profile}`, 'about:blank'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] })
  let seq = 0
  let sessionId = null
  let buffer = ''
  const waiting = new Map()
  let gone = null
  let closing = false
  const giveUp = reason => {
    if (gone || closing) return
    gone = new BrowserUnavailable(reason)
    for (const settle of waiting.values()) settle({ gone })
    waiting.clear()
    fs.rmSync(profile, { recursive: true, force: true })
  }
  browser.on('error', e => giveUp(`could not start ${chrome}: ${e.message}`))
  browser.on('exit', (code, signal) => giveUp(`${chrome} exited before the check finished (${signal ?? `code ${code}`})`))
  // Writing to a browser that has died raises EPIPE here; its 'exit' is what reports it.
  browser.stdio[3].on('error', () => {})
  browser.stdio[4].setEncoding('utf8')
  browser.stdio[4].on('data', chunk => {
    buffer += chunk
    let at
    while ((at = buffer.indexOf('\0')) >= 0) {
      const message = JSON.parse(buffer.slice(0, at))
      buffer = buffer.slice(at + 1)
      if (message.id && waiting.has(message.id)) {
        waiting.get(message.id)(message)
        waiting.delete(message.id)
      }
      if (message.method === 'Runtime.exceptionThrown') onProblem(`exception: ${message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text}`)
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') onProblem(`console: ${JSON.stringify(message.params.args.map(a => a.value ?? a.description))}`)
      if (message.method === 'Network.requestWillBeSent' && /^https?:/.test(message.params.request.url)) onProblem(`it asked the network for ${message.params.request.url}`)
    }
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    if (gone) return reject(gone)
    const id = ++seq
    waiting.set(id, m => (m.gone ? reject(m.gone) : m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)))
    browser.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`)
  })
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' })
  ;({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }))
  await send('Runtime.enable')
  await send('Page.enable')
  await send('Network.enable')
  return {
    send,
    close: () => {
      closing = true
      browser.kill()
      // Chrome can still hold the profile for a moment after the kill.
      setTimeout(() => { try { fs.rmSync(profile, { recursive: true, force: true }) } catch { /* the OS's temp dir clears it */ } }, 300).unref()
    },
  }
}

export async function checkPage (file, { chrome = findChrome(), shots = null } = {}) {
  const url = pathToFileURL(path.resolve(file)).href
  const results = []
  const problems = []
  const expect = (name, ok, got) => {
    results.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok ? '' : ` -> ${JSON.stringify(got)}`}`)
    if (!ok) problems.push(name)
  }
  const { send, close } = await openBrowser(chrome, p => problems.push(p))
  const ev = async expression => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
    if (r.exceptionDetails) throw new Error(`${expression}: ${JSON.stringify(r.exceptionDetails)}`)
    return r.result.value
  }
  const shot = async name => {
    if (!shots) return
    const r = await send('Page.captureScreenshot', { format: 'png' })
    fs.mkdirSync(shots, { recursive: true })
    fs.writeFileSync(path.join(shots, `${name}.png`), Buffer.from(r.data, 'base64'))
  }
  const size = (width, height, mobile = false) => send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
  const click = selector => ev(`document.querySelector(${JSON.stringify(selector)}).click()`)
  const state = () => ev(`({hash: location.hash, tab: document.querySelector('#nav a.on')?.dataset.tab, open: document.body.classList.contains('open'), title: document.querySelector('#pbody h2')?.textContent, on: [...document.querySelectorAll('.tabp.on')].map(p => p.dataset.p).join()})`)
  const go = async hash => { await ev(`location.hash=${JSON.stringify(hash)}`); await sleep(120) }

  try {
    await size(1500, 950)
    await send('Page.navigate', { url })
    await sleep(600)
    await shot('wide-start')

    const page = await ev('JSON.parse(document.getElementById("data").textContent)')
    const ids = Object.keys(page.ent)
    expect('it has something to read', ids.length > 0, ids.length)

    const dead = await ev(`(function () { const D = JSON.parse(document.getElementById('data').textContent); const bad = []; for (const [k, e] of Object.entries(D.ent)) { const d = document.createElement('div'); d.innerHTML = e.html; d.querySelectorAll('[data-e]').forEach(n => { if (!D.ent[n.dataset.e]) bad.push(k + '->' + n.dataset.e) }) } document.querySelectorAll('[data-e]').forEach(n => { if (!D.ent[n.dataset.e]) bad.push('page->' + n.dataset.e) }); return bad })()`)
    expect('no link on the page leads nowhere', dead.length === 0, dead.slice(0, 10))

    const wrong = await ev(`(function () { const D = JSON.parse(document.getElementById('data').textContent); const bad = []; for (const e of Object.values(D.ent)) { const d = document.createElement('div'); d.innerHTML = e.html; d.querySelectorAll('a.cite').forEach(a => { if (!a.href.includes('/blob/' + D.head + '/') && !a.href.includes('/blob/' + D.base + '/')) bad.push(a.href); if (!/#L\\d+$/.test(a.href)) bad.push(a.href) }) } return bad })()`)
    expect('every citation opens a line at the head or the base', wrong.length === 0, wrong.slice(0, 5))

    const snapshot = await ev(`document.getElementById('snapshot').textContent`)
    expect('the page says which commit it is a snapshot of', snapshot.includes(page.head.slice(0, 7)), snapshot)
    expect('and links what has changed since', await ev(`[...document.querySelectorAll('#snapshot a')].some(a => a.href.includes('/compare/' + ${JSON.stringify(page.head)}))`), snapshot)

    const external = await ev(`document.querySelectorAll('script[src],link[href],img[src^="http"],iframe').length`)
    expect('nothing on the page loads from elsewhere', external === 0, external)

    for (const { id: tab } of page.tabs) {
      await click(`#nav a[data-tab="${tab}"]`)
      await sleep(100)
      const s = await state()
      expect(`${tab} tab opens`, s.tab === tab && s.on === tab && !s.open, s)
      await shot(`wide-${tab}`)
      if (tab === 'start') continue
      const opener = `.tabp.on [data-e]`
      await click(opener)
      await sleep(120)
      const opened = await state()
      expect(`an entry on ${tab} opens the pane and keeps the tab`, opened.open && opened.tab === tab && !!opened.title, opened)
      await click('#pclose')
      await sleep(100)
    }

    // Following links both ways, from the entity with the most mentions, so that there is a trail.
    const from = ids.filter(id => page.ent[id].html.includes('data-e="')).sort((a, b) => page.ent[b].html.split('data-e="').length - page.ent[a].html.split('data-e="').length)[0]
    expect('some entity links another', !!from, null)
    if (from) {
      await go(encodeURIComponent(from))
      const first = await state()
      expect('a direct link opens with its home tab', first.open && first.title === page.ent[from].title, first)
      await shot('wide-open')
      const target = await ev(`document.querySelector('#pbody [data-e]').dataset.e`)
      await click('#pbody [data-e]')
      await sleep(150)
      let s = await state()
      expect('a link followed opens what it names', s.title === page.ent[target].title, s)
      expect('and that lists what mentions it', await ev(`[...document.querySelectorAll('#pbody h3')].some(h => /Mentioned by/.test(h.textContent))`), s)
      expect('and the mention is the one followed', await ev(`[...document.querySelectorAll('#pbody .ref')].some(a => a.dataset.e === ${JSON.stringify(from)})`), s)
      expect('the trail has both', await ev(`document.querySelectorAll('#trail a').length`) >= 2, await ev(`document.getElementById('trail').textContent`))
      await click('#pback')
      await sleep(250)
      s = await state()
      expect('back returns to where it came from', s.title === page.ent[from].title, s)
      await click('#pfwd')
      await sleep(250)
      s = await state()
      expect('forward returns again', s.title === page.ent[target].title, s)
      await ev('history.back()')
      await sleep(250)
      s = await state()
      expect('the browser\'s own back works too', s.title === page.ent[from].title, s)
      const tabWas = s.tab
      await click('#pclose')
      await sleep(150)
      s = await state()
      expect('close keeps the tab', !s.open && s.tab === tabWas, s)
    }

    const parts = ids.filter(id => page.ent[id].kind === 'part' && page.ent[id].uses?.length)
    if (parts.length) {
      await go(`map~${encodeURIComponent(parts[0])}`)
      expect('a part marks what it uses', await ev(`document.querySelectorAll('.chip.near').length`) >= 1, null)
      await shot('wide-map-open')
      await click('#pclose')
      await sleep(100)
    }

    const word = page.ent[ids[0]].title.split(/\s+/)[0]
    await ev(`(function () { const q = document.getElementById('q'); q.value = ${JSON.stringify(word)}; q.dispatchEvent(new Event('input')) })()`)
    await sleep(120)
    expect(`search finds "${word}"`, await ev(`document.querySelectorAll('#results a').length`) >= 1, null)
    await shot('wide-search')

    // Text with an escaped character, found by search, reads as the character.
    const escaped = ids.find(id => /&(lt|gt|amp);/.test(page.ent[id].html))
    if (escaped) {
      const found = await ev(`(function () { const d = document.createElement('div'); d.innerHTML = ${JSON.stringify(page.ent[escaped].html)}; const t = d.textContent; const at = t.search(/[<>&]/); return t.slice(Math.max(0, at - 8), at + 4) })()`)
      await ev(`(function () { const q = document.getElementById('q'); q.value = ${JSON.stringify(found)}; q.dispatchEvent(new Event('input')) })()`)
      await sleep(120)
      const text = await ev(`document.getElementById('results').textContent`)
      expect('search shows an escaped character once', text.includes(found) && !/&(lt|gt|amp);/.test(text), text.slice(0, 200))
    }
    await ev(`(function () { const q = document.getElementById('q'); q.value = ''; q.dispatchEvent(new Event('input')) })()`)

    // Addresses a reader can type: none is an entity, and none may break the page.
    for (const hash of ['constructor', 'toString', '100%', '%E0%A4%A']) {
      await send('Page.navigate', { url: `${url}#${hash}` })
      await sleep(250)
      const at = await state()
      expect(`#${hash} shows the front page`, at.tab === 'start' && !at.open, at)
    }

    await size(390, 844, true)
    await send('Page.navigate', { url: `${url}#${page.tabs.at(-1).id}` })
    await sleep(500)
    await shot('phone-tab')
    expect('no sideways scroll on a phone', await ev('document.documentElement.scrollWidth <= innerWidth'), await ev('document.documentElement.scrollWidth'))
    await click('.tabp.on [data-e]')
    await sleep(150)
    await shot('phone-open')
    const onPhone = await state()
    expect('the pane opens on a phone', onPhone.open, onPhone)
    expect('and the snapshot bar stays in view', await ev(`document.getElementById('snapshot').getBoundingClientRect().bottom <= document.getElementById('pane').getBoundingClientRect().top + 1`), null)
  } finally {
    close()
  }
  return { results, problems }
}

async function main (argv) {
  const shotsAt = argv.indexOf('--shots')
  const shots = shotsAt >= 0 ? argv[shotsAt + 1] : null
  const file = argv.find((a, i) => !a.startsWith('--') && (shotsAt < 0 || i !== shotsAt + 1))
  if (!file) {
    process.stderr.write('usage: check.mjs <dist.html> [--shots <dir>]\n')
    return 2
  }
  const chrome = findChrome()
  if (!chrome) {
    process.stderr.write('no Chrome found: set CHROME to the browser, or say the page was not clicked through\n')
    return 2
  }
  let checked
  try {
    checked = await checkPage(file, { chrome, shots })
  } catch (e) {
    if (!(e instanceof BrowserUnavailable)) throw e
    process.stderr.write(`${e.message}: set CHROME to a working browser, or say the page was not clicked through\n`)
    return 2
  }
  const { results, problems } = checked
  process.stdout.write(`${results.join('\n')}\n`)
  const failed = results.filter(r => r.startsWith('FAIL')).length
  process.stdout.write(problems.length ? `\n${problems.length} problem${problems.length === 1 ? '' : 's'}:\n${problems.join('\n')}\n` : `\nall good: ${results.length - failed} checks\n`)
  return problems.length ? 1 : 0
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = await main(process.argv.slice(2))
