// A reading page's decisions: when a PR is big enough for one, where it may be published, whether
// a PR may carry its link, and what is said about it. Pure, like `bin/next.mjs`: no fs, no git, no
// gh. `rig page`, `rig pr` and `rig next` gather the facts, and `skills/rig-pr-page` writes the page.

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

// Why the data root's site will not do, or null when it will. A site GitHub says is exactly
// `public: false` reaches the data root's readers, so below public it must reach no further than
// the code: no data root wider than the repo, and one owner, since two private repos under different
// owners have unrelated readers whatever their level says. A private data root may hold a public
// repo's page, since its readers are fewer than the code's. A public site is `pageSite`'s to warn
// about. Either way it must serve the root of a `gh-pages` branch, the one branch rig can write
// without moving what the data root's checkout works on, or serving every record on it.
function siteProblem (spec, visibility, root) {
  if (root.none) return 'the data root has no remote, so it has no site to publish to'
  if (root.elsewhere) return 'the data root is not on GitHub, so nothing says who can read it'
  if (!root.visibility) return 'GitHub would not say how visible the data root is'
  if (root.site === undefined) return 'GitHub would not say whether the data root has a Pages site'
  if (root.site === null) return `the data root (${root.spec}) has no Pages site: turn it on in its Pages settings, deploying from the root of a gh-pages branch; on a personal account that site is public, and a private one takes GitHub Enterprise Cloud`
  if (root.site.public === false && visibility !== 'public') {
    if (wider(root.visibility, visibility)) return `the data root is ${root.visibility}, wider than the ${visibility} code`
    if (root.spec.split('/')[0].toLowerCase() !== spec.split('/')[0].toLowerCase()) return `the data root belongs to another owner, whose readers are not the repo's`
  }
  const { branch, path, build } = root.site
  if (branch !== 'gh-pages' || path !== '/' || build !== 'legacy') {
    const from = `${branch}${path === '/' ? '' : path}${build === 'workflow' ? ' by a workflow' : ''}`
    return `the data root's Pages site is served from ${from}, and rig writes only to a gh-pages branch: in its Pages settings, deploy from the root of a gh-pages branch`
  }
  return null
}

// Where a page for this repo may be published: the data root's site, or `{ why }`, one plain line
// saying why nowhere. Only an exact `public: false` is a private site. Anything else is public, which
// public code may be, with a warning, and other code only on the person's explicit word, since a
// published page cannot be taken back from the internet: `needsPublicFlag`.
//
//   root   the data root: `{ none }` with no remote, `{ elsewhere }` off GitHub, or
//          `{ spec, visibility, site }`, where `site` is null for none and undefined where
//          GitHub would not say
export function pageSite ({ spec, visibility, root }) {
  if (!REACH.includes(visibility)) return { why: `GitHub would not say how visible ${spec} is` }
  const problem = siteProblem(spec, visibility, root)
  if (problem) return { why: problem }
  const site = { spec: root.spec, branch: root.site.branch, url: root.site.url, public: root.site.public !== false, needsPublicFlag: false }
  if (!site.public) return site
  site.publicReason = root.site.public === true ? `the data root's Pages site is on the open internet` : `the data root's Pages site does not say it is private, so it counts as public`
  site.needsPublicFlag = visibility !== 'public'
  site.warning = site.needsPublicFlag
    ? `this page would be public: ${site.publicReason}, and ${spec} is ${visibility}. A published page cannot be taken back, so publishing it takes --public and the person's word for this page`
    : `this page will be public: ${site.publicReason}`
  return site
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

// May this PR carry a page's link? A private site's host is random and its path names only the
// repo the PR is in, so that link names nothing. Any other host may name the data root, so it goes
// by the context doc's rule: `link` is `mayLink`'s answer, and null there means no.
export const pageLinkable = (url, link) => /^https:\/\/[a-z0-9-]+\.pages\.github\.io(\/|$)/i.test(url) || link === true

const REGION = /<!-- rig:reading-page -->[\s\S]*?<!-- \/rig:reading-page -->/

// A body rig does not own, a stage PR's, with the page's line in a marked region at its top: the
// region replaced in place if it is there, and everything around it left as written.
export function pageRegion (body, page) {
  const region = `<!-- rig:reading-page -->\n${pageLine(page)}\n<!-- /rig:reading-page -->`
  const text = body ?? ''
  if (REGION.test(text)) return text.replace(REGION, () => region)
  return text ? `${region}\n\n${text}` : region
}

// The org, repo and number of a GitHub pull request's URL, or null for anything else.
export function prFromUrl (text) {
  const m = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)(?:[/?#]\S*)?$/.exec(text)
  return m ? { org: m[1], repo: m[2], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}` } : null
}

const count = (n, word) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`
const threshold = ({ lines, files }) => [lines !== null && count(lines, 'line'), files !== null && count(files, 'file')].filter(Boolean).join(' or ')

// "1,240 lines across 31 files", for whatever says how big a PR is.
export const sizeWords = ({ lines, files }) => `${count(lines, 'line')} across ${count(files, 'file')}`

export const pageMoved = ({ page, prHead }) => !!(page && prHead && page.head !== prHead)

// What to say of one PR's page, shared by `rig next`, `rig pr` and `rig page`, or null for nothing
// worth saying. `repo` is whatever names the PR to the reader. `why` is `pageSite`'s, and is only
// asked for where a page is due and none exists. `upcoming` is a pushed branch with no PR yet,
// measured by git, whose page has to follow the PR because its number is the page's address.
export function pageSaying (fact) {
  const { repo, size, due, page, prHead, why, upcoming, warning } = fact
  const warned = warning ? ` — ${warning}` : ''
  if (pageMoved(fact)) {
    return { says: `${repo}: the PR's head has moved past its reading page (page at ${page.head.slice(0, 7)}, PR at ${prHead.slice(0, 7)}) — the rig-pr-page skill rebuilds it`, command: 'rig page' }
  }
  if (page || !due) return null
  if (why) return { says: `${repo}: no reading page — ${why}`, command: null }
  if (upcoming) return { says: `${repo}: about ${sizeWords(size)}, over the size for a reading page (${threshold(fact.threshold)}) — a page is addressed by its PR, so open that, then the rig-pr-page skill writes one before you ask for a review${warned}`, command: 'rig pr' }
  return { says: `${repo}: this PR is ${sizeWords(size)}, over the size for a reading page (${threshold(fact.threshold)}) — the rig-pr-page skill writes one${warned}`, command: 'rig page' }
}

// May a page's source sit in the data root? Only where the data root is no wider than the code,
// since it holds what the page holds. An answer nobody gave is no.
export function pageSourceAllowed (visibility, rootVisibility) {
  if (!REACH.includes(visibility) || !REACH.includes(rootVisibility)) return false
  return !wider(rootVisibility, visibility)
}
