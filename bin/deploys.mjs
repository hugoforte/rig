// Which pushes run a repo's push-triggered workflows, read out of its `.github/workflows` files.
//
// A branch name can be a deploy. A repo whose workflow runs on push to `fix/**` and derives the
// environment from the branch puts every push of a `fix/` work branch on that environment, and
// the branch prefix is what `rig new --type` chose (hugoforte/rig#386). The workflow files are
// the repo's own word for it and sit in the worktree, so they are read there rather than from
// catalogue prose nothing can match against a branch.
//
// **What counts.** A workflow whose `on.push.branches` names branch filters: a push trigger
// narrowed to named branches is how a deploy or a release is written, while a test run on every
// push (`on: push`, `branches: ['**']`, `branches-ignore`) narrows nothing and is no news about
// one branch. Only the block form of `on:` is read, with `branches` a block list, a flow list or
// a single scalar; a flow mapping (`on: { push: … }`) is not, and reads as no filter,
// so rig says nothing rather than something wrong. Path filters are not read: a push they leave
// out is still a push the branch was cut to make.
//
// Pure, like `bin/release.mjs`: the caller reads the files, and nothing here touches fs or git.

// A line with its comment taken off, a `#` that starts the line or follows a space and is not
// inside quotes.
function uncomment (line) {
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) { if (c === quote) quote = null; continue }
    if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) return line.slice(0, i).trimEnd()
  }
  return line.trimEnd()
}

const indentOf = line => line.length - line.trimStart().length
const unquote = s => s.trim().replace(/^(["'])(.*)\1$/, '$2')

// The lines below `at` indented past it, up to the next line that is not, blank lines dropped.
function childrenOf (lines, at) {
  const own = indentOf(lines[at])
  const out = []
  for (let i = at + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    if (indentOf(lines[i]) <= own) break
    out.push(i)
  }
  return out
}

// The child of `at` with this key, as { line, rest }, among the children at the shallowest indent.
function keyUnder (lines, at, key) {
  const kids = childrenOf(lines, at)
  if (!kids.length) return null
  const depth = Math.min(...kids.map(i => indentOf(lines[i])))
  const pattern = new RegExp(`^\\s*(?:${key}|"${key}"|'${key}')\\s*:(.*)$`)
  for (const i of kids) {
    if (indentOf(lines[i]) !== depth) continue
    const m = pattern.exec(lines[i])
    if (m) return { line: i, rest: m[1].trim() }
  }
  return null
}

// The branch filters a workflow's push trigger names, in order, or null when it names none: no
// push trigger, one on every branch, one on tags alone, or a form this does not read.
export function pushBranches (text) {
  const lines = String(text ?? '').split(/\r?\n/).map(uncomment)
  const on = lines.findIndex(l => /^(?:on|"on"|'on')\s*:/.test(l))
  if (on < 0 || lines[on].replace(/^[^:]*:/, '').trim()) return null
  const push = keyUnder(lines, on, 'push')
  if (!push || push.rest) return null
  const branches = keyUnder(lines, push.line, 'branches')
  if (!branches) return null
  let filters
  if (branches.rest.startsWith('[')) {
    // A flow list may run on over the lines below until it closes.
    let flow = branches.rest
    for (let i = branches.line + 1; !flow.includes(']') && i < lines.length; i++) flow += ` ${lines[i].trim()}`
    filters = flow.replace(/^\[/, '').replace(/\].*$/, '').split(',').map(unquote).filter(Boolean)
  } else if (branches.rest) {
    filters = [unquote(branches.rest)]
  } else {
    // Items sit below the key, or at its own indent, which YAML allows for a list.
    const depth = indentOf(lines[branches.line])
    filters = []
    for (let i = branches.line + 1; i < lines.length; i++) {
      if (!lines[i].trim()) continue
      const item = /^\s*-\s+(.*)$/.exec(lines[i])
      if (!item || indentOf(lines[i]) < depth) break
      filters.push(unquote(item[1]))
    }
  }
  filters = filters.filter(Boolean)
  if (!filters.length || filters.includes('**')) return null
  return filters
}

// One filter as a regular expression, the way GitHub reads it: `*` stops at a slash, `**` does
// not, `?` and `+` apply to the character before them, `[…]` is a class, and the rest is literal.
function filterRegex (filter) {
  let re = ''
  for (let i = 0; i < filter.length; i++) {
    const c = filter[i]
    if (c === '*') {
      if (filter[i + 1] === '*') { re += '.*'; i++ } else re += '[^/]*'
    } else if (c === '?' || c === '+') re += c
    else if (c === '[') {
      const end = filter.indexOf(']', i)
      if (end < 0) { re += '\\['; continue }
      re += filter.slice(i, end + 1)
      i = end
    } else re += c.replace(/[.\\^$|(){}]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

// Whether a push to `branch` passes these filters. The last filter that matches decides, so a
// `!` filter takes a branch back out and a later positive one puts it back, as GitHub has it.
export function branchMatches (filters, branch) {
  let matched = false
  for (const f of filters) {
    const negated = f.startsWith('!')
    if (filterRegex(negated ? f.slice(1) : f).test(branch)) matched = !negated
  }
  return matched
}

// The workflows, of [{ file, text }], that a push to `branch` runs, each with the first filter
// naming it: [{ file, pattern }].
export function pushTriggers (workflows, branch) {
  const out = []
  for (const { file, text } of workflows) {
    const filters = pushBranches(text)
    if (!filters || !branchMatches(filters, branch)) continue
    out.push({ file, pattern: filters.find(f => !f.startsWith('!') && filterRegex(f).test(branch)) })
  }
  return out
}

// The prefixes, of those offered and in their order, that would put the same branch where no
// workflow runs on a push. Only a branch cut on one of them has one to swap: a `release/1.2.0`
// named by hand was named for what it deploys.
export function quieterPrefixes (workflows, branch, prefixes) {
  const slash = branch.indexOf('/')
  const own = branch.slice(0, slash)
  if (slash < 0 || !prefixes.includes(own)) return []
  const rest = branch.slice(slash + 1)
  return prefixes.filter(p => p !== own && !pushTriggers(workflows, `${p}/${rest}`).length)
}

// What a push of the branch runs, and at most two prefixes that would run nothing, as the one
// clause `rig attach`, `rig status` and `rig doctor` all say.
export function pushTriggersLabel (hits, quieter) {
  const runs = `a push runs ${hits.map(h => `${h.file} (${h.pattern})`).join(', ')}`
  const offer = quieter.slice(0, 2)
  return offer.length ? `${runs} — \`--type ${offer.join('` or `')}\` would not` : runs
}
