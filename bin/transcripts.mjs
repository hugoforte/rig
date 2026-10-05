// A work's own session transcripts: the conversations that did the work, which the lesson review
// reads (hugoforte/rig#291). rig knows no agent host. Where a host keeps its sessions is the
// machine's to say, as patterns in `rig.local.json`'s `transcripts`, and this reads them.
//
// A pattern names one workspace's sessions: a folder that is exactly `{slug}` stands for the
// workspace's path with every character but a letter or digit made a dash, `~` for the home
// folder, and a `*` matches names in any part after the `{slug}` folder. Claude Code's are
// `~/.claude/projects/{slug}/*.jsonl` and, for its subagents, `~/.claude/projects/{slug}/*/subagents/*.jsonl`.
// A work's workspaces are its folder and its worktrees, so only its own sessions are found.
//
// A pattern is refused, found nothing with and named, when it could reach past the workspace's
// own folder: with no `{slug}` folder it would find every work's sessions alike, a `*` before
// that folder matches other workspaces' folders, and a `..` climbs out of it. Those are private
// conversations from unrelated work.
//
// A slug is lossy, as the host's own layout is: `D:\w\a\b` and `D:\w\a-b` share one. Which of
// two works a session in such a folder belongs to only the transcript can say, which is the
// host's format and so the reader's job, not this module's.
import fs from 'node:fs'
import path from 'node:path'

export const slugOf = workspace => workspace.replace(/[^A-Za-z0-9]/g, '-')

const parts = pattern => pattern.split(/[\\/]/)
const matcher = glob => new RegExp(`^${glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')

// Why a pattern cannot be trusted to stay in one workspace's folder, or null when it can.
export function refusal (pattern) {
  const segments = parts(pattern)
  const slug = segments.indexOf('{slug}')
  if (segments[0] !== '~' && !path.isAbsolute(pattern)) return 'it is relative — a pattern names one place on this machine, from ~ or a drive'
  if (slug < 0 || slug === segments.length - 1) return 'it names no workspace — it would read every work\'s sessions; put {slug} as a folder where the workspace goes'
  if (segments.includes('..')) return 'it climbs out of the workspace\'s folder with ..'
  if (segments.slice(0, slug).some(s => s.includes('*'))) return 'a * before the {slug} folder matches other workspaces\' folders'
  return null
}

// Every file under `dir` that the remaining glob `segments` match, one folder level a segment.
function walk (dir, segments) {
  const [head, ...rest] = segments
  if (!head.includes('*')) return rest.length ? walk(path.join(dir, head), rest) : [path.join(dir, head)]
  let names
  try { names = fs.readdirSync(dir) } catch { return [] }
  const matches = matcher(head)
  return names.filter(n => matches.test(n)).flatMap(n => (rest.length ? walk(path.join(dir, n), rest) : [path.join(dir, n)]))
}

// `{ found, refused }`: each transcript as `{ path, workspace, modifiedAt }`, oldest first, and
// each refused pattern as `{ pattern, why }`.
export function transcriptsFor ({ patterns = [], workspaces = [], home }) {
  const refused = patterns.map(pattern => ({ pattern, why: refusal(pattern) })).filter(r => r.why)
  const found = new Map()
  for (const pattern of patterns.filter(p => !refusal(p))) {
    const segments = parts(pattern)
    const slug = segments.indexOf('{slug}')
    const fixed = segments.slice(0, slug).join(path.sep).replace(/^~(?=[\\/]|$)/, home ?? '~')
    for (const workspace of workspaces) {
      for (const file of walk(path.join(fixed || path.sep, slugOf(workspace)), segments.slice(slug + 1))) {
        const stat = fs.statSync(file, { throwIfNoEntry: false })
        if (stat?.isFile()) found.set(file, { path: file, workspace, modifiedAt: stat.mtime.toISOString() })
      }
    }
  }
  return { found: [...found.values()].sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt)), refused }
}
