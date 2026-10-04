// A work's context doc against the template it was made from (hugoforte/rig#295): the problems
// a reader would otherwise find by going looking for a section that is not there. Reported and
// never refused (decision 66): `rig save` prints them, `rig doctor` lists them.
//
// The required headings are the template's own, read from `templates/context.md`, so the
// template stays the one statement of the shape. `templates/context-sections.md` is optional
// by design, so nothing in it is ever required. Placeholders are what the template leaves to be
// filled, and are expected until the design gate: before it, the doc is being written.
//
// Pure, like `bin/phase.mjs`: the caller reads the files.

// The template's placeholders: its `_TODO_` and the brief's `_TODO: …_`, the next-step stub, a
// field rig did not fill, and the empty row of a table to fill in.
const PLACEHOLDERS = [/_TODO[^_\n]*_/, /_next step_/, /\{\{[A-Z]+\}\}/, /^\|(\s*\|)+\s*$/]

const headingsOf = text => text.split('\n').map((l, i) => ({ heading: l.trim(), line: i + 1 })).filter(h => /^## /.test(h.heading))

// `[{ line, problem }]`, in the order they appear in the doc. `designed` is whether the design
// gate has passed.
export function contextDocProblems (text, { template, designed = false }) {
  const lines = text.split('\n')
  const out = []
  const present = headingsOf(text)
  const required = headingsOf(template).map(h => h.heading)
  const at = heading => present.find(p => p.heading === heading)
  required.forEach((heading, i) => {
    if (at(heading)) return
    // Where it would go: the next required heading the doc has, else the end.
    const next = required.slice(i + 1).map(at).find(Boolean)
    out.push({ line: next ? next.line : lines.length, problem: `no "${heading}" heading — every context doc keeps the four templates/context.md scaffolds` })
  })
  // A heading the doc puts after one the template has later: said where it stands.
  const found = required.filter(at)
  found.forEach((heading, i) => {
    const later = found.slice(i + 1).find(l => at(l).line < at(heading).line)
    if (later) out.push({ line: at(heading).line, problem: `"${heading}" comes after "${later}" — the template has it before` })
  })
  if (designed) {
    let inComment = false
    lines.forEach((l, i) => {
      // A comment is the template's note to the writer, and may well name a placeholder.
      const opens = l.includes('<!--')
      if (opens) inComment = true
      const commented = inComment
      if (l.includes('-->')) inComment = false
      if (commented) return
      for (const p of PLACEHOLDERS) {
        const m = p.exec(l)
        if (m) out.push({ line: i + 1, problem: `still the template's placeholder "${m[0].trim()}" — the design is agreed, so say what goes here or take it out` })
      }
    })
  }
  return out.sort((a, b) => a.line - b.line)
}
