// Claude Code's sessions, read into rig's session format (hugoforte/rig#322). A reader is the one
// place that knows a host's files; `bin/` knows none (decision 19), and asks a reader by name.
//
// A session is a JSONL file, one entry a line. Every entry about a turn carries the session's
// id (`sessionId`), when it was written (`timestamp`), the folder the session ran in (`cwd`)
// and the branch checked out there (`gitBranch`). A subagent's session is a file of its own
// whose entries are marked `isSidechain` and carry the id of the session that spawned it.

// Every value of a top-level string field, in the order written. Read from the text rather than
// line by line through JSON.parse: a session runs to megabytes, and the finder reads every one
// on the machine. A field inside a string, such as a tool's output, is escaped there and never
// matches.
const values = (text, key) => [...text.matchAll(new RegExp(`"${key}":"((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map(m => JSON.parse(`"${m[1]}"`))
const distinct = list => [...new Set(list.filter(Boolean))]

// What the finder needs to place a session: where it ran, on which branches, and when.
export function meta (text) {
  const at = values(text, 'timestamp').sort()
  return {
    session: values(text, 'sessionId')[0] ?? null,
    subagent: /"isSidechain":true/.test(text),
    startedAt: at[0] ?? null,
    endedAt: at.at(-1) ?? null,
    cwds: distinct(values(text, 'cwd')),
    // A detached HEAD is no branch of anyone's.
    branches: distinct(values(text, 'gitBranch')).filter(b => b !== 'HEAD'),
  }
}
