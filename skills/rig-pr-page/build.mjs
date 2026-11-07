#!/usr/bin/env node
// Builds one pull request's reading page: a source file an agent wrote, plus what git says of the
// diff, into a single self-contained HTML file from `template.html`.
//
// It fails on anything that would make the page lie: a dead link, a citation out of range or whose
// text has moved, a duplicate id, a connection to nothing. Rebuilding at a new head therefore names
// exactly what has to be rewritten. Standard library only, as all of rig is.
//
//   node build.mjs <source.md> --out <file.html> --pr <url> --head <sha> --base <branch>
//        --branch <work branch> --repo-dir <worktree>
//
// `rig page <repo> --json` holds every one of those values but the file names. SKILL.md sets out
// the source format.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export class PageBuildError extends Error {
  constructor (problems) {
    super(`${problems.length} problem${problems.length === 1 ? '' : 's'} building the page:\n${problems.join('\n')}`)
    this.problems = problems
  }
}

// The kinds an agent writes, and the tab each lives on. `file` and `sec` come from the diff.
const WRITTEN = { part: 'map', flow: 'flows', decision: 'decisions', test: 'tests', risk: 'risks', open: 'open', word: 'words' }
const TABS = [['start', 'Start'], ['map', 'Map'], ['flows', 'Behaviour'], ['decisions', 'Decisions'], ['tests', 'Tests'], ['risks', 'Risks'], ['open', 'Open items'], ['words', 'Words'], ['files', 'Files']]
const META = /^(sub|group|status|uses|files|aka|pill):\s*(.*)$/
const STATUSES = ['new', 'changed', 'removed', 'unchanged']

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const attr = s => esc(s).replace(/"/g, '&quot;')
const list = s => (s || '').split(',').map(x => x.trim()).filter(Boolean)
const fenceAt = line => /^\s*(```|~~~)/.test(line)
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`

// `git`, in the repo the PR is from, with enough room for a whole file's output.
function gitIn (repoDir) {
  return (...args) => {
    const r = spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
    return r.status === 0 ? r.stdout : null
  }
}

// `{ repo, number }` from a PR's URL.
function prParts (url) {
  const m = /^(https:\/\/[^/]+\/[^/]+\/[^/]+)\/pull\/(\d+)$/.exec(url || '')
  if (!m) throw new PageBuildError([`--pr must be a pull request's URL, and it is "${url}"`])
  return { repo: m[1], number: Number(m[2]) }
}

// What the diff holds: one `{ path, change, added, removed }` a file, and how big it all is.
function changedFiles (git, base, head) {
  const numstat = git('diff', '--numstat', '--no-renames', '-z', base, head)
  const status = git('diff', '--name-status', '--no-renames', '-z', base, head)
  if (numstat === null || status === null) throw new PageBuildError([`git could not diff ${base} with ${head}`])
  const changes = new Map()
  const names = status.split('\0')
  for (let i = 0; i + 1 < names.length; i += 2) changes.set(names[i + 1], names[i])
  const files = numstat.split('\0').filter(Boolean).map(row => {
    const [added, removed, ...name] = row.split('\t')
    const file = name.join('\t')
    const code = changes.get(file)
    return {
      path: file,
      change: code === 'A' ? 'added' : code === 'D' ? 'removed' : 'modified',
      added: added === '-' ? 0 : Number(added),
      removed: removed === '-' ? 0 : Number(removed),
      binary: added === '-',
    }
  })
  return { files, size: { lines: files.reduce((n, f) => n + f.added + f.removed, 0), files: files.length } }
}

// The source: `title:` and `start:` in its frontmatter, the summary, then `# kind/id: Title`
// entities, each with `key: value` lines straight under its heading.
function parseSource (text, problems) {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const front = {}
  let i = 0
  if (lines[0] === '---') {
    for (i = 1; i < lines.length && lines[i] !== '---'; i++) {
      const m = /^([a-z]+):\s*(.*)$/.exec(lines[i])
      if (m) front[m[1]] = m[2]
    }
    i++
  }
  const summary = []
  const entities = []
  let cur = null
  let fence = false
  for (; i < lines.length; i++) {
    const line = lines[i]
    if (fenceAt(line)) fence = !fence
    if (!fence && /^# /.test(line)) {
      const m = /^# ([a-z]+)\/(.+?): (.+)$/.exec(line)
      if (!m) { problems.push(`"${line}" is no entity: a heading is \`# kind/id: Title\``); cur = null; continue }
      cur = { kind: m[1], id: `${m[1]}/${m[2]}`, title: m[3].trim(), meta: {}, md: [] }
      entities.push(cur)
      while (META.test(lines[i + 1] ?? '')) {
        const kv = META.exec(lines[++i])
        cur.meta[kv[1]] = kv[2].trim()
      }
      continue
    }
    if (cur) cur.md.push(line)
    else summary.push(line)
  }
  if (!front.title) problems.push('the source has no `title:` in its frontmatter')
  return { title: front.title || 'A pull request', start: list(front.start), summary, entities }
}

const slugOf = title => title.replace(/[`*_]/g, '').trim().toLowerCase().replace(/[^\p{L}\p{N}\- ]/gu, '').replace(/ /g, '-')
const blobUrl = (repo, sha, file, line) => `${repo}/blob/${sha}/${file.split('/').map(encodeURIComponent).join('/')}?plain=1${line ? `#L${line}` : ''}`

// A changed markdown file's sections, as entities a reviewer can open and link to.
function docSections (file, text) {
  const sections = []
  const seen = new Map()
  let cur = null
  let fence = false
  text.replace(/\r\n/g, '\n').split('\n').forEach((line, index) => {
    if (fenceAt(line)) fence = !fence
    const m = fence ? null : /^(#{1,3}) (.+)$/.exec(line)
    if (m) {
      const base = slugOf(m[2]) || 'section'
      const n = seen.get(base) || 0
      seen.set(base, n + 1)
      cur = { level: m[1].length, title: m[2].replace(/[`*]/g, '').trim(), slug: n ? `${base}-${n}` : base, line: index + 1, md: [] }
      sections.push(cur)
    } else {
      if (!cur && line.trim()) {
        cur = { level: 1, title: path.posix.basename(file), slug: 'top', line: index + 1, md: [] }
        sections.push(cur)
      }
      if (cur) cur.md.push(line)
    }
  })
  return sections
}

// Rendering. One render context a piece of text: which entity it belongs to, which doc it is from
// (a repo's doc holds only its own text, so its `{{…}}` and `[[…]]` are not this format's), the
// terms already linked, and what it mentions, which is what backlinks are made from.
function renderer ({ ent, problems, repo, head, baseSha, blobLines, secIds, warnings }) {
  const terms = new Map()
  for (const [id, e] of Object.entries(ent)) {
    for (const term of [...(e.kind === 'word' ? [e.title] : []), ...list(e.meta?.aka)]) if (!terms.has(term)) terms.set(term, id)
  }
  const termRe = terms.size
    ? new RegExp(`(?<![\\w-])(${[...terms.keys()].sort((a, b) => b.length - a.length).map(t => esc(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'g')
    : null
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

  const link = (id, label, ctx, cls = 'w') => {
    if (id === ctx.eid) return label
    ctx.mentions.add(id)
    return `<a class="${cls}" href="#${attr(encodeURIComponent(id))}" data-e="${attr(id)}">${label}</a>`
  }
  const ext = (url, label, cls = '') => `<a class="ext${cls ? ` ${cls}` : ''}" target="_blank" rel="noopener noreferrer" href="${attr(url)}">${label}</a>`

  // The first mention of a declared term in this entity, in escaped text.
  const linkTerms = (escaped, ctx) => {
    if (!termRe || ctx.nolink) return escaped
    return escaped.replace(termRe, (match) => {
      const id = terms.get(unesc(match))
      if (!id || id === ctx.eid || ctx.seen.has(id)) return match
      ctx.seen.add(id)
      return link(id, match, ctx)
    })
  }

  const citation = (spec, ctx) => {
    const m = /^(base:)?(.+?):(\d+)(?:\s*~\s*(.+))?$/.exec(spec.trim())
    if (!m) { problems.push(`citation {{${spec}}} in ${ctx.eid} is not path:line ~ text`); return esc(spec) }
    const [, atBase, file, lineText, expected] = m
    const label = `<code>${esc(file)}:${lineText}</code>`
    if (!expected) { problems.push(`citation {{${spec}}} in ${ctx.eid} needs the text it expects on that line: {{${file}:${lineText} ~ …}}`); return label }
    const sha = atBase ? baseSha : head
    const lines = blobLines(sha, file)
    if (!lines) { problems.push(`citation in ${ctx.eid}: ${file} is not in ${sha.slice(0, 8)}`); return label }
    const line = Number(lineText)
    if (line < 1 || line > lines.length) { problems.push(`citation in ${ctx.eid}: ${file}:${line} is out of range; ${file} has ${lines.length} lines at ${sha.slice(0, 8)}`); return label }
    if (!lines[line - 1].includes(expected)) { problems.push(`citation in ${ctx.eid}: ${file}:${line} should hold "${expected}", and it says "${lines[line - 1].trim()}"`); return label }
    // A citation of a changed file is a mention of it, so the file lists what cites it.
    if (ent[`file/${file}`]) ctx.mentions.add(`file/${file}`)
    return ext(blobUrl(repo, sha, file, line), label, 'cite')
  }

  // A link in a repo's doc: to a section on this page where there is one, to GitHub otherwise. A
  // scheme that is not plain web or mail stays as text.
  const docLink = (url, label, ctx) => {
    if (/^(https?:|mailto:)/i.test(url)) return ext(url, label)
    if (/^[a-z][a-z0-9+.-]*:/i.test(url) || !ctx.doc) return label
    const [target, anchor] = url.split('#')
    const file = target ? path.posix.normalize(path.posix.join(path.posix.dirname(ctx.doc), target)) : ctx.doc
    if (file.startsWith('..')) return label
    if (secIds.has(file)) {
      const id = anchor ? `sec/${file}#${anchor}` : `file/${file}`
      if (ent[id]) return link(id, label, ctx)
      warnings.push(`${ctx.eid} links ${url}, which is no section of ${file}`)
    }
    return ext(blobUrl(repo, head, file), label)
  }

  const INLINE = /`(?<code>[^`]+)`|\[\[(?<wiki>[^\]|]+)(?:\|(?<wikil>[^\]]+))?\]\]|\{\{(?<cite>[^}]+)\}\}|\[(?<lt>[^\]]+)\]\((?<lu>[^)\s]+)\)|\*\*(?<b>.+?)\*\*|(?<![\w*])\*(?!\s)(?<i>[^*]+?)(?<!\s)\*(?![\w*])|(?<![\w_])_(?!\s)(?<u>[^_]+?)(?<!\s)_(?![\w_])/g

  const inline = (text, ctx) => {
    let out = ''
    let at = 0
    for (const m of text.matchAll(INLINE)) {
      const g = m.groups
      // A repo's doc is only text: its braces and double brackets stay as they are written.
      if (ctx.doc && (g.wiki !== undefined || g.cite !== undefined)) continue
      out += linkTerms(esc(text.slice(at, m.index)), ctx)
      at = m.index + m[0].length
      if (g.code !== undefined) {
        const id = !ctx.nolink && terms.get(g.code)
        const code = `<code>${esc(g.code)}</code>`
        if (id && id !== ctx.eid && !ctx.seen.has(id)) { ctx.seen.add(id); out += link(id, code, ctx) } else out += code
      } else if (g.wiki !== undefined) {
        const id = g.wiki.trim()
        if (!ent[id]) { problems.push(`dead link ${id} in ${ctx.eid}`); out += esc(g.wikil || id); continue }
        ctx.seen.add(id)
        out += link(id, esc(g.wikil || ent[id].title), ctx)
      } else if (g.cite !== undefined) {
        out += citation(g.cite, ctx)
      } else if (g.lt !== undefined) {
        const was = ctx.nolink
        ctx.nolink = true
        const label = inline(g.lt, ctx)
        ctx.nolink = was
        out += docLink(g.lu, label, ctx)
      } else if (g.b !== undefined) {
        out += `<strong>${inline(g.b, ctx)}</strong>`
      } else {
        out += `<em>${inline(g.i ?? g.u, ctx)}</em>`
      }
    }
    return out + linkTerms(esc(text.slice(at)), ctx)
  }

  const cells = line => {
    const out = []
    let cur = ''
    let code = false
    for (const ch of line.trim().replace(/^\|/, '').replace(/\|$/, '')) {
      if (ch === '`') code = !code
      if (ch === '|' && !code) { out.push(cur.trim()); cur = '' } else cur += ch
    }
    out.push(cur.trim())
    return out
  }

  const ITEM = /^(\s*)([-*]|\d+\.)\s+(.*)$/
  const startsBlock = line => !line.trim() || ITEM.test(line) || fenceAt(line) || /^\s*\|/.test(line) || /^@(step|before|after|note)\b/.test(line) || /^#{1,6} /.test(line) || /^>/.test(line)

  const blocks = (lines, ctx) => {
    const out = []
    let i = 0
    let step = 0
    while (i < lines.length) {
      const line = lines[i]
      if (!line.trim() || /^\s*<!--.*-->\s*$/.test(line) || /^(-{3,}|\*{3,})$/.test(line.trim())) { i++; continue }
      const callout = /^@(before|after|note)\s+(.*)$/.exec(line)
      if (callout) {
        const buf = [callout[2]]
        i++
        while (i < lines.length && lines[i].trim() && !startsBlock(lines[i])) buf.push(lines[i++].trim())
        out.push(`<div class="callout ${callout[1]}"><b class="l">${callout[1] === 'note' ? 'Note' : callout[1] === 'before' ? 'Before' : 'After'}</b><p>${inline(buf.join(' '), ctx)}</p></div>`)
        continue
      }
      if (line.startsWith('@step ')) {
        step++
        out.push(`<h4 class="step"><span>${step}</span>${inline(line.slice(6), ctx)}</h4>`)
        i++
        continue
      }
      const heading = /^#{1,6} (.+)$/.exec(line)
      if (heading) { out.push(`<h3>${inline(heading[1], ctx)}</h3>`); i++; continue }
      if (fenceAt(line)) {
        const buf = []
        i++
        while (i < lines.length && !fenceAt(lines[i])) buf.push(lines[i++])
        i++
        out.push(`<pre>${esc(buf.join('\n'))}</pre>`)
        continue
      }
      if (/^\s*\|/.test(line)) {
        const rows = []
        while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(cells(lines[i++]))
        const [head_, ...body] = rows
        const data = body.filter(r => !r.every(c => /^:?-+:?$/.test(c)))
        out.push(`<div class="tw"><table><tr>${head_.map(c => `<th>${inline(c, ctx)}</th>`).join('')}</tr>${data.map(r => `<tr>${r.map(c => `<td>${inline(c, ctx)}</td>`).join('')}</tr>`).join('')}</table></div>`)
        continue
      }
      if (/^>/.test(line)) {
        const buf = []
        while (i < lines.length && /^>/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''))
        out.push(`<blockquote>${blocks(buf, ctx)}</blockquote>`)
        continue
      }
      const item = ITEM.exec(line)
      if (item) {
        const depth = item[1].length
        const tag = /\d/.test(item[2][0]) ? 'ol' : 'ul'
        const items = []
        while (i < lines.length) {
          const it = ITEM.exec(lines[i])
          if (!it || it[1].length !== depth) {
            // A blank line between two items of this list does not end it.
            const next = !lines[i].trim() && ITEM.exec(lines[i + 1] ?? '')
            if (next && next[1].length === depth) { i++; continue }
            break
          }
          const sub = [it[3]]
          i++
          while (i < lines.length && lines[i].trim() && (lines[i].length - lines[i].trimStart().length) > depth) sub.push(lines[i++].slice(depth + 2))
          items.push(`<li>${blocks(sub, ctx)}</li>`)
        }
        out.push(`<${tag}>${items.join('')}</${tag}>`)
        continue
      }
      const buf = []
      while (i < lines.length && !startsBlock(lines[i])) buf.push(lines[i++].trim())
      if (buf.length) out.push(`<p>${inline(buf.join(' '), ctx)}</p>`)
      else i++
    }
    return out.join('')
  }

  return { blocks, link, ext }
}

// The one page. Throws PageBuildError with every problem it found, so one rebuild names them all.
export function buildPage ({ source, pr, head, base, branch, repoDir, builtAt = new Date().toISOString().slice(0, 10) }) {
  const { repo, number } = prParts(pr)
  const git = gitIn(repoDir)
  const headSha = git('rev-parse', '--verify', '--quiet', `${head}^{commit}`)?.trim()
  if (!headSha) throw new PageBuildError([`git has no commit ${head} in ${repoDir}: fetch it, or build where it is checked out`])
  const baseRef = [`origin/${base}`, base].find(ref => git('rev-parse', '--verify', '--quiet', `${ref}^{commit}`))
  if (!baseRef) throw new PageBuildError([`git has no ${base} or origin/${base} in ${repoDir}: fetch it`])
  const baseSha = git('merge-base', baseRef, headSha)?.trim()
  if (!baseSha) throw new PageBuildError([`${baseRef} and ${headSha.slice(0, 8)} share no commit`])

  const problems = []
  const warnings = []
  const parsed = parseSource(source, problems)
  const { files, size } = changedFiles(git, baseSha, headSha)

  const blobs = new Map()
  const blobLines = (sha, file) => {
    const key = `${sha}:${file}`
    if (!blobs.has(key)) {
      const text = git('show', key)
      blobs.set(key, text === null ? null : text.replace(/\r\n/g, '\n').split('\n'))
    }
    return blobs.get(key)
  }

  // Every entity first, since any of them may link any other.
  const ent = {}
  const add = (id, e) => {
    if (ent[id]) problems.push(`duplicate ${id}`)
    ent[id] = e
  }
  const changed = new Set(files.map(f => f.path))
  const secIds = new Set()
  for (const f of files) {
    add(`file/${f.path}`, {
      kind: 'file',
      title: f.path,
      tag: f.binary ? `${f.change}, binary` : `${f.change}, +${f.added} −${f.removed}`,
      change: f.change,
      added: f.added,
      removed: f.removed,
      src: blobUrl(repo, f.change === 'removed' ? baseSha : headSha, f.path),
      srcl: f.change === 'removed' ? `${f.path} as it was` : f.path,
      md: [],
    })
    if (f.change === 'removed' || !/\.(md|markdown)$/i.test(f.path)) continue
    const text = blobLines(headSha, f.path)
    if (!text) continue
    secIds.add(f.path)
    const sections = docSections(f.path, text.join('\n')).map(s => {
      const id = `sec/${f.path}#${s.slug}`
      add(id, { kind: 'sec', title: s.title, tag: f.path, level: s.level, file: `file/${f.path}`, doc: f.path, md: s.md, src: blobUrl(repo, headSha, f.path, s.line), srcl: `${f.path}:${s.line}` })
      return id
    })
    ent[`file/${f.path}`].sections = sections
  }
  for (const e of parsed.entities) {
    if (e.kind === 'file') {
      const generated = ent[e.id]
      if (!generated) { problems.push(`${e.id} has a note, and the PR did not change that file`); continue }
      generated.md = [...e.md]
      generated.meta = e.meta
      continue
    }
    if (!WRITTEN[e.kind]) { problems.push(`unknown kind "${e.kind}" in ${e.id}: a page has ${Object.keys(WRITTEN).join(', ')}, and file/ for a note on a changed file`); continue }
    if (e.meta.status && !STATUSES.includes(e.meta.status)) problems.push(`${e.id} has status "${e.meta.status}": it is one of ${STATUSES.join(', ')}`)
    add(e.id, { kind: e.kind, title: e.title, sub: e.meta.sub, pill: e.meta.pill, group: e.meta.group, status: e.meta.status, meta: e.meta, md: e.md })
  }

  const fileIsThere = name => changed.has(name) || !!blobLines(headSha, name)
  const { blocks, link, ext } = renderer({ ent, problems, repo, head: headSha, baseSha, blobLines, secIds, warnings })

  const back = {}
  const rendered = (eid, doc, lines) => {
    const ctx = { eid, doc, seen: new Set(), mentions: new Set(), nolink: false }
    return { html: blocks(lines, ctx), ctx }
  }
  const noteBack = (eid, ctx) => {
    for (const target of ctx.mentions) (back[target] = back[target] || []).push(eid)
  }

  for (const [id, e] of Object.entries(ent)) {
    const { html, ctx } = rendered(id, e.doc || null, e.md)
    e.html = html
    if (e.kind === 'part') {
      e.uses = list(e.meta.uses).map(u => (u.startsWith('part/') ? u : `part/${u}`))
      for (const u of e.uses) if (!ent[u]) problems.push(`${id} uses ${u}, which is not on the page`)
      const named = list(e.meta.files)
      for (const name of named) if (!fileIsThere(name)) problems.push(`${id} names ${name}, which is neither changed by the PR nor at its head`)
      if (named.length) {
        const refs = named.map(name => (changed.has(name) ? link(`file/${name}`, esc(name), ctx, 'ref') : ext(blobUrl(repo, headSha, name), esc(name), 'ref')))
        e.html += `<h3>Files</h3><div class="refs">${refs.join('')}</div>`
      }
    }
    noteBack(id, ctx)
    delete e.md
    delete e.meta
    delete e.doc
  }
  for (const [id, e] of Object.entries(ent)) {
    if (e.kind === 'part') e.usedBy = Object.keys(ent).filter(other => ent[other].kind === 'part' && ent[other].uses.includes(id))
  }

  // What has not been discussed is said on the page and to the author, rather than left to look
  // as though someone had read it.
  for (const f of files) {
    const id = `file/${f.path}`
    const discussed = (back[id] || []).some(by => !['file', 'sec'].includes(ent[by].kind)) || ent[id].html || ent[id].sections?.length
    if (!discussed) {
      ent[id].pill = 'not discussed'
      warnings.push(`nothing on the page mentions ${f.path}`)
    }
  }

  const summaryCtx = { eid: 'start', doc: null, seen: new Set(), mentions: new Set(), nolink: false }
  const summary = blocks(parsed.summary, summaryCtx)
  for (const target of summaryCtx.mentions) if (!ent[target]) problems.push(`dead link ${target} in the summary`)
  for (const id of parsed.start) if (!ent[id]) problems.push(`dead link ${id} in \`start:\``)

  if (problems.length) throw new PageBuildError([...new Set(problems)].sort())

  const count = tab => (tab === 'files' ? files.length : Object.values(ent).filter(e => WRITTEN[e.kind] === tab).length)
  const tabs = TABS.filter(([id]) => id === 'start' || count(id) > 0).map(([id, label]) => ({ id, label, count: id === 'start' ? 0 : count(id) }))
  const data = {
    title: parsed.title,
    pr,
    number,
    repo,
    head: headSha,
    base: baseSha,
    baseName: base,
    branch,
    builtAt,
    compare: `${repo}/compare/${headSha}...${branch.split('/').map(encodeURIComponent).join('/')}`,
    size,
    summary,
    start: parsed.start,
    tabs,
    ent,
    back,
  }
  // Parsed from the element's text, never run, so only a closing tag could end it early.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  const fill = { TITLE: esc(`${parsed.title} · PR #${number}`), PR: attr(pr), HEAD: headSha }
  let html = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8')
  for (const [key, value] of Object.entries(fill)) html = html.replaceAll(`{{${key}}}`, () => value)
  // Last and once, since the data may hold anything, the marker's own spelling included.
  html = html.replace('{{DATA}}', () => json)
  return { html, data, warnings }
}

function main (argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i]
    else positional.push(argv[i])
  }
  const [sourceFile] = positional
  const missing = ['out', 'pr', 'head', 'base', 'branch', 'repo-dir'].filter(k => !flags[k])
  if (!sourceFile || missing.length) {
    process.stderr.write(`usage: build.mjs <source.md> --out <file.html> --pr <url> --head <sha> --base <branch> --branch <work branch> --repo-dir <worktree>${missing.length ? `\nmissing: ${missing.map(m => `--${m}`).join(', ')}` : ''}\n`)
    return 2
  }
  try {
    const { html, data, warnings } = buildPage({ source: fs.readFileSync(sourceFile, 'utf8'), pr: flags.pr, head: flags.head, base: flags.base, branch: flags.branch, repoDir: flags['repo-dir'] })
    fs.writeFileSync(flags.out, html)
    for (const w of warnings) process.stdout.write(`note: ${w}\n`)
    const kinds = {}
    for (const e of Object.values(data.ent)) kinds[e.kind] = (kinds[e.kind] || 0) + 1
    process.stdout.write(`${flags.out}: ${Math.round(html.length / 1024)} KB, ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(', ')}; ${plural(Object.values(data.back).reduce((n, b) => n + b.length, 0), 'backlink')}, at ${data.head.slice(0, 8)}\n`)
    return 0
  } catch (e) {
    if (!(e instanceof PageBuildError)) throw e
    process.stderr.write(`${e.message}\n`)
    return 1
  }
}

const isMain = process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) process.exitCode = main(process.argv.slice(2))
