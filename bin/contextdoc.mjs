// A work's context doc against the template it was made from (hugoforte/rig#295): the problems
// a reader would otherwise find by going looking for a section that is not there. Reported and
// never refused (decision 66): `rig save` prints them, `rig doctor` lists them.
//
// The required headings are the template's own, read from `templates/context.md`, so the
// template stays the one statement of the shape — and renaming one of its headings is a change
// to every open doc, which `test/contextdoc.test.mjs` pins so that it is made on purpose.
// `templates/context-sections.md` is optional by design, so nothing in it is ever required.
// Placeholders are what the template leaves to be filled, and are expected until the design
// gate: before it, the doc is being written.
//
// It also slices one section out of a doc (`sectionOf`) and raises a section's headings as it is
// lifted into a PR body (`promoteHeadings`), which `rig pr` and `rig next` read.
//
// Markdown that is code — a fenced block, an inline span — and an HTML comment are read as
// neither heading nor placeholder: a doc may well show `_TODO_` while talking about one.
//
// Pure, like `bin/phase.mjs`: the caller reads the files.

// The template's placeholders: its `_TODO_` and the brief's `_TODO: …_`, the next-step stub, a
// field rig did not fill, and the empty row of a table to fill in. Anchored, so `MY_TODO_LIST`
// is a name and not a placeholder.
const PLACEHOLDERS = [/(?<![\w])_TODO(?:_|[:\s][^_\n]*_)(?![\w])/, /(?<![\w])_next step_(?![\w])/, /\{\{[A-Z]+\}\}/, /^\|(\s*\|)+\s*$/]

// A line that opens a code fence, as CommonMark has it: three or more backticks or tildes, at most
// three spaces in, and no backtick in a backtick fence's info string — so a line that is only an
// inline span wrapped in triple backticks opens nothing. A fence closes on a line of the same
// character, at least as long, with nothing after it.
const fenceOpener = line => /^ {0,3}(`{3,}(?=[^`]*$)|~{3,})/.exec(line)?.[1] ?? null
const closesFence = (line, fence) => new RegExp(String.raw`^ {0,3}` + fence[0] + `{${fence.length},}` + String.raw`\s*$`).test(line)

// Which lines sit in a fenced code block, its fences included. A fence that never closes runs to
// the end of the doc as markdown renders it, and read that way it would carry every section after
// it into whatever lifts one — into a public PR body — so an unclosed fence is read as no fence:
// each `## ` after it ends a section, as it did before fences were read at all.
function fenced (lines) {
  const inside = lines.map(() => false)
  let fence = null
  lines.forEach((line, i) => {
    if (fence) {
      inside[i] = true
      if (closesFence(line, fence)) fence = null
      return
    }
    fence = fenceOpener(line)
    inside[i] = !!fence
  })
  return fence ? lines.map(() => false) : inside
}

// The doc's lines with code and comments blanked out, so a line number still points at the
// line, and what is left is only what the doc says in its own voice.
function prose (text) {
  const out = []
  let fence = null
  let comment = false
  for (const raw of text.split(/\r?\n/)) {
    if (fence) {
      if (closesFence(raw, fence)) fence = null
      out.push('')
      continue
    }
    fence = fenceOpener(raw)
    if (fence) { out.push(''); continue }
    let line = ''
    let rest = raw
    while (rest) {
      if (comment) {
        const end = rest.indexOf('-->')
        if (end < 0) { rest = ''; break }
        comment = false
        rest = rest.slice(end + 3)
        continue
      }
      const start = rest.indexOf('<!--')
      if (start < 0) { line += rest; break }
      line += rest.slice(0, start)
      comment = true
      rest = rest.slice(start + 4)
    }
    out.push(line.replace(/(`+)[^`]*?\1/g, ''))
  }
  return out
}

const headingsOf = lines => lines.map((l, i) => ({ heading: l.trim(), line: i + 1 })).filter(h => /^## /.test(h.heading))

// The body of the doc's `## <name>` section: the lines after its heading, up to the next `## `
// heading or the end. A `## ` in a fence neither starts a section nor ends one — a section shaped
// like a PR body is mostly fenced diagrams. Comments are not read here: `prose` hides everything
// after a `<!--` it cannot see the end of, and a section that ran on past its next heading would
// carry the doc's private sections into a public body. The name is matched as whole words in any
// case, so a `## Pull requests` list of links is not the Pull request section. Sliced by line
// rather than by one clever expression: the clever one, `(?=^## |\Z)`, read `\Z` as a literal `Z`
// in JavaScript, so a last section matched nothing and any section containing a capital Z was cut
// there. Empty when the doc has no such section.
export function sectionOf (text, name) {
  const lines = (text || '').split(/\r?\n/)
  const code = fenced(lines)
  const headings = lines.map((l, i) => (!code[i] && /^ {0,3}## /.test(l) ? i : -1)).filter(i => i >= 0)
  const named = new RegExp(String.raw`^ {0,3}## +` + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + String.raw`(?![\p{L}\p{N}])`, 'iu')
  const at = headings.findIndex(i => named.test(lines[i]))
  if (at < 0) return ''
  return lines.slice(headings[at] + 1, headings[at + 1] ?? lines.length).join('\n')
}

// A section's own headings one level up, as it is lifted out from under its `## ` heading into a
// PR body: its `### Summary` is the body's `## Summary`. A `#` in a fence is code, and stays.
export function promoteHeadings (text) {
  const lines = text.split(/\r?\n/)
  const code = fenced(lines)
  return lines.map((l, i) => (!code[i] && /^#{3,6} /.test(l) ? l.slice(1) : l)).join('\n')
}

// The headings in the doc's order that are not in the longest run the template's order allows:
// the ones that moved, so one heading moved is one problem and not one for each it jumped.
function moved (found, required) {
  const rank = found.map(h => required.indexOf(h))
  const best = rank.map(() => 1)
  const from = rank.map(() => -1)
  rank.forEach((r, i) => {
    for (let j = 0; j < i; j++) if (rank[j] < r && best[j] + 1 > best[i]) { best[i] = best[j] + 1; from[i] = j }
  })
  const kept = new Set()
  for (let i = best.indexOf(Math.max(...best)); i >= 0; i = from[i]) kept.add(i)
  return found.filter((_, i) => !kept.has(i))
}

// `[{ line, problem, kind }]` in the order they appear in the doc, `kind` being `heading` or
// `placeholder`. `designed` is whether the design gate has passed.
export function contextDocProblems (text, { template, designed = false }) {
  const lines = prose(text)
  const last = text.trimEnd().split(/\r?\n/).length
  const out = []
  const present = headingsOf(lines)
  const required = headingsOf(prose(template)).map(h => h.heading)
  const at = heading => present.find(p => p.heading === heading)
  required.forEach((heading, i) => {
    if (at(heading)) return
    // Where it would go: the next required heading the doc has, else its last line.
    const next = required.slice(i + 1).map(at).find(Boolean)
    out.push({ line: next ? next.line : last, kind: 'heading', problem: `no "${heading}" heading — every context doc keeps the headings templates/context.md scaffolds` })
  })
  const found = present.map(p => p.heading).filter(h => required.includes(h))
  for (const heading of moved(found, required)) {
    const i = required.indexOf(heading)
    const next = required.slice(i + 1).find(at)
    const prev = required.slice(0, i).reverse().find(at)
    out.push({ line: at(heading).line, kind: 'heading', problem: `"${heading}" is out of the template's order — there it comes ${next ? `before "${next}"` : `after "${prev}"`}` })
  }
  if (designed) {
    lines.forEach((l, i) => {
      for (const p of PLACEHOLDERS) {
        const m = p.exec(l)
        if (m) out.push({ line: i + 1, kind: 'placeholder', problem: `still the template's placeholder "${m[0].trim()}" — the design is agreed, so say what goes here or take it out` })
      }
    })
  }
  return out.sort((a, b) => a.line - b.line)
}
