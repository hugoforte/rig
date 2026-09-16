// Shared plumbing for a tracker module backed by a JSON-emitting CLI (`gh`, `twg`):
// pairs one error class with the `fail`/`firstLine`/`parseJson` trio bin/github.mjs and
// bin/jira.mjs both need, so a fix to one (say, how much of a bad response gets quoted)
// doesn't have to be remembered and repeated in the other.
export function jsonCliHelpers (ErrorClass) {
  const fail = msg => { throw new ErrorClass(msg) }
  const firstLine = s => (s || '').trim().split('\n')[0]
  const parseJson = (text, what) => {
    try { return JSON.parse(text) } catch (e) { fail(`${what} returned unreadable JSON (${e.message}): ${firstLine(text)}`) }
  }
  return { fail, firstLine, parseJson }
}
