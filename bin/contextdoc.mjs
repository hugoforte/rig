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
// Markdown that is code — a fenced block, an inline span — and an HTML comment are read as
// neither heading nor placeholder: a doc may well show `_TODO_` while talking about one.
//
// Pure, like `bin/phase.mjs`: the caller reads the files.

// The template's placeholders: its `_TODO_` and the brief's `_TODO: …_`, the next-step stub, a
// field rig did not fill, and the empty row of a table to fill in. Anchored, so `MY_TODO_LIST`
// is a name and not a placeholder.
const PLACEHOLDERS = [/(?<![\w])_TODO(?:_|[:\s][^_\n]*_)(?![\w])/, /(?<![\w])_next step_(?![\w])/, /\{\{[A-Z]+\}\}/, /^\|(\s*\|)+\s*$/]

// The doc's lines with code and comments blanked out, so a line number still points at the
// line, and what is left is only what the doc says in its own voice.
function prose (text) {
  const out = []
  let fence = null
  let comment = false
  for (const raw of text.split(/\r?\n/)) {
    const marker = /^\s*(`{3,}|~{3,})/.exec(raw)
    if (fence) {
      if (marker && marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null
      out.push('')
      continue
    }
    if (marker) { fence = marker[1]; out.push(''); continue }
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
// heading or the end. Found on `prose`, so a `## ` in a fence or a comment neither starts a
// section nor ends one — a section shaped like a PR body is mostly fenced diagrams. Sliced by
// line rather than by one clever expression: the clever one, `(?=^## |\Z)`, read `\Z` as a
// literal `Z` in JavaScript, so a last section matched nothing and any section containing a
// capital Z was cut there. Empty when the doc has no such section.
export function sectionOf (text, name) {
  const lines = (text || '').split(/\r?\n/)
  const headings = headingsOf(prose(text || ''))
  const at = headings.findIndex(h => h.heading.startsWith(`## ${name}`))
  if (at < 0) return ''
  const end = headings[at + 1]?.line ?? lines.length + 1
  return lines.slice(headings[at].line, end - 1).join('\n')
}

// A section's own headings one level up, as it is lifted out from under its `## ` heading into a
// PR body: its `### Summary` is the body's `## Summary`. A `#` in a fence is code, and stays.
export function promoteHeadings (text) {
  const said = prose(text)
  return text.split(/\r?\n/).map((l, i) => (/^#{3,6} /.test(said[i]) ? l.slice(1) : l)).join('\n')
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
