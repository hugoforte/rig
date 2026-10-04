// A work's own session transcripts: the conversations that did the work, which the lesson review
// reads (hugoforte/rig#291). rig knows no agent host. Where a host keeps its sessions is the
// machine's to say, as patterns in `rig.local.json`'s `transcripts`, and this reads them.
//
// A pattern names one workspace's sessions: `{slug}` stands for the workspace's path with every
// character but a letter or digit made a dash, `~` for the home folder, and a `*` in the last
// part matches file names. Claude Code's is `~/.claude/projects/{slug}/*.jsonl`. A work's
// workspaces are its folder and its worktrees, so only its own sessions are ever found.
//
// A pattern with no `{slug}` would find every work's sessions alike, which is reading private
// conversations from unrelated work, so it finds nothing and is answered as `unscoped`.
import fs from 'node:fs'
import path from 'node:path'

export const slugOf = workspace => workspace.replace(/[^A-Za-z0-9]/g, '-')

const fileMatcher = glob => new RegExp(`^${glob.split('*').map(s => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i')

// `{ found, unscoped }`: each transcript as `{ path, modifiedAt }`, oldest first, and the
// patterns refused for naming no workspace.
export function transcriptsFor ({ patterns = [], workspaces = [], home }) {
  const unscoped = patterns.filter(p => !p.includes('{slug}'))
  const found = new Map()
  for (const pattern of patterns.filter(p => p.includes('{slug}'))) {
    for (const workspace of workspaces) {
      const expanded = pattern.replace(/^~(?=[\\/]|$)/, home).replaceAll('{slug}', slugOf(workspace))
      const dir = path.dirname(expanded)
      const matches = fileMatcher(path.basename(expanded))
      let names
      try { names = fs.readdirSync(dir) } catch { continue }
      for (const name of names.filter(n => matches.test(n))) {
        const file = path.join(dir, name)
        const stat = fs.statSync(file, { throwIfNoEntry: false })
        if (stat?.isFile()) found.set(file, { path: file, modifiedAt: stat.mtime.toISOString() })
      }
    }
  }
  return { found: [...found.values()].sort((a, b) => a.modifiedAt.localeCompare(b.modifiedAt)), unscoped }
}
