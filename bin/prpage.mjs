// A reading page's decisions: when a PR is big enough for one, where it may be published, and
// what is said about it. Pure, like `bin/next.mjs`: no fs, no git, no gh. `rig page`, `rig pr` and
// `rig next` gather the facts, and `skills/rig-pr-page` writes the page itself.

// Reached by about the top fifth of a repo's PRs, measured on rig's own last hundred. A page costs
// an agent's time rather than a reviewer's and is only ever offered, so a little over-offering is
// cheap. `pr_page_lines` and `pr_page_files` in a catalogue entry, or `prPage.<org>` in rig.json,
// say otherwise.
export const PAGE_DEFAULTS = { lines: 500, files: 20 }

const REACH = ['private', 'internal', 'public']
const wider = (a, b) => REACH.indexOf(a) > REACH.indexOf(b)

// One measure's limit, per measure the repo over the org over the default: a number, or null where
// it is `off`. A value that is neither is named and passed over, because a typo in a threshold is
// no reason to stop a command that is only reporting.
export function pageThreshold ({ repo = {}, org = {} } = {}) {
  const problems = []
  const limit = measure => {
    for (const [level, values] of [['repo', repo], ['org', org]]) {
      const v = values?.[measure]
      if (v === undefined || v === null || v === '') continue
      if (v === 'off') return null
      if (/^[1-9]\d*$/.test(String(v))) return Number(v)
      problems.push(`the ${level}'s reading-page ${measure} threshold "${v}" is neither a positive whole number nor off, so it is passed over`)
    }
    return PAGE_DEFAULTS[measure]
  }
  return { lines: limit('lines'), files: limit('files'), problems }
}

// What GitHub says the PR's diff is, or null where it gave no numbers.
export function pageSize (pr) {
  if (!pr || !Number.isInteger(pr.changedFiles)) return null
  return { lines: (pr.additions || 0) + (pr.deletions || 0), files: pr.changedFiles }
}

export function pageDue (size, { lines, files }) {
  if (!size) return false
  return (lines !== null && size.lines >= lines) || (files !== null && size.files >= files)
}

// A site is usable when rig can write to it through the contents API without touching anything
// else: one branch set aside for it, served from its root.
const usable = site => site.branch === 'gh-pages' && site.path === '/' && site.build === 'legacy'
// A site only reaches fewer people than the internet when GitHub says exactly that: Pages from a
// private repo is public outside Enterprise Cloud, so the repo's visibility alone proves nothing.
const isPublic = site => site.public !== false

// Why the repo's own site will not do, or null when it will. A restricted site's readers are the
// repo's own, the one case that needs no comparison.
function ownProblem (visibility, site) {
  if (site === undefined) return 'GitHub would not say whether it has a Pages site'
  if (site === null) return 'it has no Pages site'
  if (isPublic(site) && visibility !== 'public') return `its own Pages site is public and the repo is ${visibility}`
  if (!usable(site)) return 'its own Pages site does not publish from the root of a gh-pages branch'
  return null
}

// Why the data root's site will not do, or null when it will. It must reach exactly the repo's
// level: wider and the page outreaches the code; narrower and the link names a private repo in a
// more visible PR, which is what `mayLink` holds for the context doc. Below public, one owner too,
// since two private repos under different owners have unrelated readers whatever their level says.
function rootProblem (spec, visibility, root) {
  if (root.none) return 'the data root has no remote'
  if (root.elsewhere) return 'the data root is not on GitHub, so nothing says who can read it'
  if (!root.visibility) return 'GitHub would not say how visible the data root is'
  if (wider(root.visibility, visibility)) return `the data root is ${root.visibility}, wider than the ${visibility} code`
  if (wider(visibility, root.visibility)) return `the repo is more visible than the data root (${root.visibility}), so a link would name it`
  if (root.site === undefined) return 'GitHub would not say whether the data root has a Pages site'
  if (root.site === null) return 'the data root has no Pages site'
  if (isPublic(root.site) && visibility !== 'public') return `the data root's Pages site is public and the code is ${visibility}`
  if (visibility !== 'public' && root.spec.split('/')[0].toLowerCase() !== spec.split('/')[0].toLowerCase()) return `the data root belongs to another owner, whose readers are not the repo's`
  if (!usable(root.site)) return `the data root's Pages site does not publish from the root of a gh-pages branch`
  return null
}

// Where a page for this repo may be published: `{ host, spec, branch, url }`, or `{ why }`, one
// plain line saying why nowhere. The repo's own site first, since its readers are the code's
// exactly, which no comparison of two repos can promise.
//
//   own    the repo's site: null for none, undefined where GitHub would not say
//   root   the data root: `{ none }` with no remote, `{ elsewhere }` off GitHub, or
//          `{ spec, visibility, site }` with `site` as `own`
export function pageSite ({ spec, visibility, own, root }) {
  if (!REACH.includes(visibility)) return { why: `GitHub would not say how visible ${spec} is` }
  const mine = ownProblem(visibility, own)
  if (!mine) return { host: 'repo', spec, branch: own.branch, url: own.url }
  const theirs = rootProblem(spec, visibility, root)
  if (!theirs) return { host: 'root', spec: root.spec, branch: root.site.branch, url: root.site.url }
  return { why: `${spec} is ${visibility}: ${mine}, and ${theirs}` }
}

// Where a page sits on its site: one folder of its own, so a publish touches nothing else, and an
// address the PR's number makes stable across rebuilds.
export function pageAddress (site, org, repo, number) {
  const folder = `rig-pr-pages/${org}/${repo}/${number}`
  return { path: `${folder}/index.html`, url: `${site.url.replace(/\/+$/, '')}/${folder}/` }
}

// What a built page says it describes: `rig:pr` and `rig:head`, read so that the record of a page
// cannot disagree with the page.
export function pageMetas (html) {
  const meta = name => new RegExp(`<meta name="rig:${name}" content="([^"]*)">`).exec(html)?.[1] ?? null
  const head = meta('head')
  return { pr: meta('pr'), head: head && /^[0-9a-f]{40}$/.test(head) ? head : null }
}

export const pageLine = page => `Reading page, at \`${page.head.slice(0, 7)}\`: ${page.url}`

const count = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
const threshold = ({ lines, files }) => [lines !== null && count(lines, 'line'), files !== null && count(files, 'file')].filter(Boolean).join(' or ')

// "1,240 lines across 31 files", for whatever says how big a PR is.
export const sizeWords = ({ lines, files }) => `${count(lines, 'line')} across ${count(files, 'file')}`

export const pageMoved = ({ page, prHead }) => !!(page && prHead && page.head !== prHead)

// What to say of one PR's page, shared by `rig next`, `rig pr` and `rig page`, or null for nothing
// worth saying. `why` is `pageSite`'s, and is only asked for where a page is due and none exists.
export function pageSaying (fact) {
  const { repo, size, due, page, prHead, why } = fact
  if (pageMoved(fact)) {
    return { says: `${repo}: the PR's head has moved past its reading page (page at ${page.head.slice(0, 7)}, PR at ${prHead.slice(0, 7)}) — the rig-pr-page skill rebuilds it`, command: 'rig page' }
  }
  if (page || !due) return null
  if (why) return { says: `${repo}: no reading page — ${why}`, command: null }
  return { says: `${repo}: this PR is ${sizeWords(size)}, over the size for a reading page (${threshold(fact.threshold)}) — the rig-pr-page skill writes one`, command: 'rig page' }
}

// May a page's source sit in the data root? Only where the data root is no wider than the code,
// since it holds what the page holds. An answer nobody gave is no.
export function pageSourceAllowed (visibility, rootVisibility) {
  if (!REACH.includes(visibility) || !REACH.includes(rootVisibility)) return false
  return !wider(rootVisibility, visibility)
}
