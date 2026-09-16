// Shared plumbing for a tracker module backed by a JSON-emitting CLI (`gh`, `twg`), so
// bin/github.mjs and bin/jira.mjs don't each hand-roll the same helpers around their own
// error class and drift apart on a fix to one of them.

// `fail`/`firstLine`/`parseJson` bound to one error class.
export function jsonCliHelpers (ErrorClass) {
  const fail = msg => { throw new ErrorClass(msg) }
  const firstLine = s => (s || '').trim().split('\n')[0]
  const parseJson = (text, what) => {
    try { return JSON.parse(text) } catch (e) { fail(`${what} returned unreadable JSON (${e.message}): ${firstLine(text)}`) }
  }
  return { fail, firstLine, parseJson }
}

// `run`/`must` for one binary. `exec(args)` is spawnSync-shaped and injected so tests
// can can the CLI. A binary that cannot be spawned at all fails through `fail`, once, for
// every caller; `must` reports the whole of stderr, since a streamed subprocess (`gh repo
// clone` relaying git) puts its cause on a later line, not the first.
export function cliRunner (binary, exec, fail) {
  const run = args => {
    const r = exec(args)
    if (r.error) fail(`${binary} not found on PATH (${r.error.message})`)
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
  }
  const must = args => {
    const r = run(args)
    if (r.code !== 0) fail(`${binary} ${args.slice(0, 2).join(' ')}: ${r.err || r.out}`)
    return r.out
  }
  return { run, must }
}
