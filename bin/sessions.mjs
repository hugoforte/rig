// A machine's agent sessions, and which of them belong to a work (hugoforte/rig#291, #322): the
// conversations that did the work, which the lesson review reads and a close looks at before it
// takes a worktree away.
//
// Where a host keeps its sessions is the machine's to say, as `sessions` in `rig.local.json`: a
// list of `{ glob, reader }`. A glob names files from `~` or a drive, a `*` matching names within
// one folder level. A reader is what knows the host's files, and rig ships one per host it can
// read, under `readers/`; nothing in `bin/` knows a host (decision 19).
//
// A session belongs to a work by what it records, not by the folder its file was kept in: it ran
// in the work folder or below it, it ran on one of the work's branches, or it names the work
// folder. Sessions mostly start in the tool's checkout or a repo's own, not in the work folder,
// and a host such as Codex files them by date, so where a file lives says nothing about whose it
// is. So every session on the machine is read to place it, and only the work's are given back.
import fs from 'node:fs'
import path from 'node:path'

import * as claudeCode from '../readers/claude-code.mjs'
import * as codex from '../readers/codex.mjs'

export const READERS = { 'claude-code': claudeCode, codex }

export const SESSIONS_EXAMPLE = '[{ "glob": "~/.claude/projects/*/*.jsonl", "reader": "claude-code" }]'

// Why a `sessions` value cannot be read, or null when it can. A value that is not a list of
// sources is a mistake to name, never the same as having none.
export function sourcesProblem (value, file) {
  if (value === undefined || value === null) return null
  const shape = `\`sessions\` in ${file} must be a list of { "glob", "reader" }, such as ${SESSIONS_EXAMPLE}`
  if (!Array.isArray(value)) return shape
  for (const s of value) {
    if (!s || typeof s !== 'object' || typeof s.glob !== 'string' || !s.glob.trim()) return shape
    if (!READERS[s.reader]) return `\`sessions\` in ${file}: "${s.glob}" names the reader "${s.reader}", and rig ships ${Object.keys(READERS).join(', ')}`
    if (!/^~([\\/]|$)/.test(s.glob) && !path.isAbsolute(s.glob)) return `\`sessions\` in ${file}: "${s.glob}" is relative — a glob names one place on this machine, from ~ or a drive`
  }
  return null
}

const matcher = glob => new RegExp(`^${glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')

// Every file under `dir` that the remaining glob `segments` match, one folder level a segment.
function walk (dir, segments) {
  const [head, ...rest] = segments
  if (!head.includes('*')) return rest.length ? walk(path.join(dir, head), rest) : [path.join(dir, head)]
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const matches = matcher(head)
  return names.filter(n => matches.test(n)).flatMap(n => (rest.length ? walk(path.join(dir, n), rest) : [path.join(dir, n)]))
}

// Every session file the sources name, as `{ path, reader, modifiedAt }`, oldest first: those
// last written before `since`, when it is given, are left unread, since nothing written before a
// moment can be about what happened after it.
export function sessionFiles ({ sources = [], home, since = null }) {
  const files = new Map()
  for (const { glob, reader } of sources) {
    const [first, ...rest] = glob.split(/[\\/]/)
    const root = first === '~' ? home : `${first}${path.sep}`
    for (const file of walk(root, rest.filter(Boolean))) {
      const stat = fs.statSync(file, { throwIfNoEntry: false })
      if (!stat?.isFile() || files.has(file)) continue
      if (since && stat.mtimeMs < Date.parse(since)) continue
      files.set(file, { path: file, reader, modifiedAt: stat.mtime.toISOString() })
    }
  }
  return [...files.values()].sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt))
}

// A path as one form to compare: forward slashes, lower case, no trailing slash. Windows paths
// are not case-sensitive, and a host may write either slash.
const plain = p => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

const escape = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// A folder as a session may write it: raw, inside JSON with its backslashes doubled, with forward
// slashes, or as Git Bash writes a drive (`/c/…`).
function forms (folder) {
  const raw = folder.replace(/[\\/]+$/, '')
  const forward = raw.replace(/\\/g, '/')
  const all = new Set([raw, raw.replace(/\\/g, '\\\\'), forward])
  const drive = /^([A-Za-z]):\//.exec(forward)
  if (drive) all.add(`/${drive[1].toLowerCase()}/${forward.slice(3)}`)
  return [...all].map(escape).join('|')
}

// Whether `text` names `folder`, written any of those ways. Named means followed by a separator, a
// full stop ending a sentence, or nothing a name goes on with, so `D:\w\refunds` is not named by
// `D:\w\refunds-old`.
export function mentions (text, folder) {
  return new RegExp(`(?:${forms(folder)})(?![\\w-]|\\.[\\w])`, 'i').test(text)
}

// Every folder name `text` names directly under `root`, in lower case: the works a session names,
// when `root` is the work root, in one pass over the text however many works there are.
export function namedUnder (text, root) {
  const re = new RegExp(`(?:${forms(root)})(?:\\\\\\\\|\\\\|/)([\\w-]+(?:\\.[\\w-]+)*)`, 'gi')
  return new Set([...text.matchAll(re)].map(m => m[1].toLowerCase()))
}

const lastPart = p => plain(p).split('/').at(-1)

// Why a session is the work's, or null when it is not. The work is its folder, under which every
// worktree is; its branches, the work branch and each stage's; and its repos' names. A branch
// places a session only where it ran in a checkout of one of those repos, since another repo, or
// a project of the user's own, may carry a branch of the same name. A folder is looked for only in
// what the session did (`meta.acted`), never in what its tools printed.
export function placed (meta, { folder, branches = [], repos = [] }) {
  const root = plain(folder)
  if (meta.cwds.some(cwd => plain(cwd) === root || plain(cwd).startsWith(`${root}/`))) return 'ran there'
  const names = repos.map(r => r.toLowerCase())
  if (meta.branches.some(b => branches.includes(b)) && meta.cwds.some(cwd => names.includes(lastPart(cwd)))) return 'on its branch'
  if (mentions(meta.acted ?? '', folder)) return 'names its folder'
  return null
}

// Every session file the sources name, with what its reader says about it, as
// `{ path, reader, modifiedAt, meta }`, oldest first. Read once, so a caller placing them in
// several folders reads each file once. A file that cannot be read is no session of anyone's, and
// is skipped.
export function readSessions ({ sources = [], home, since = null }) {
  const out = []
  for (const file of sessionFiles({ sources, home, since })) {
    let text
    try { text = fs.readFileSync(file.path, 'utf8') } catch { continue }
    out.push({ ...file, meta: READERS[file.reader].meta(text) })
  }
  return out
}

// The work's sessions among `sessions`, as `{ path, reader, modifiedAt, session, subagent, why }`.
export function sessionsFor (sessions, work) {
  return sessions.flatMap(s => {
    const why = placed(s.meta, work)
    return why ? [{ path: s.path, reader: s.reader, modifiedAt: s.modifiedAt, session: s.meta.session, subagent: s.meta.subagent, why }] : []
  })
}

// Every session on the machine that was at work between `since` and `until` (decision 210), as
// `{ path, reader, session, subagent, startedAt, endedAt, works }`, oldest first. `works` are the
// ids of the works it belongs to, placed as `placed` places one, from `works`
// (`{ id, branches, repos }`) under `workRoot`; none, for the sessions that belong to no work,
// which a periodic retro reads too. Nothing is stored: this is the user's own machine, read for
// the user.
export function sessionsBetween ({ sources = [], home, since, until = null, workRoot, works = [] }) {
  const root = plain(workRoot)
  const known = new Map(works.map(w => [w.id.toLowerCase(), w.id]))
  const out = []
  for (const { path: file, reader, modifiedAt, meta } of readSessions({ sources, home, since })) {
    const startedAt = meta.startedAt ?? modifiedAt
    const endedAt = meta.endedAt ?? modifiedAt
    if (endedAt < since || (until && startedAt >= until)) continue
    const ids = new Set()
    for (const cwd of meta.cwds) {
      const rest = plain(cwd).startsWith(`${root}/`) ? plain(cwd).slice(root.length + 1).split('/')[0] : null
      if (known.has(rest)) ids.add(known.get(rest))
    }
    for (const name of namedUnder(meta.acted ?? '', workRoot)) if (known.has(name)) ids.add(known.get(name))
    for (const w of works) if (!ids.has(w.id) && placed({ ...meta, acted: '' }, { folder: path.join(workRoot, w.id), branches: w.branches, repos: w.repos })) ids.add(w.id)
    out.push({ path: file, reader, session: meta.session, subagent: meta.subagent, startedAt, endedAt, works: [...ids].sort() })
  }
  return out.sort((a, b) => a.startedAt.localeCompare(b.startedAt))
}
