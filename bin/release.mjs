// Releases: what bump a PR asks for, and what a push to `main` releases.
//
// The shape this automates: **the PR carries a bump, not a version** (ADR 0004). A required
// check asks one question about the pull request alone — does it name a bump? — and the push
// works the version out from the bumps of the pull requests it contains, then tags that commit
// and publishes the notes. The version is a fold over the whole set, so it is computed at the
// only place the set is known; a branch cannot see the other branches, and a check that asked
// it there went red every time somebody else merged.
//
// The adjacent design — a workflow that bumps and commits on `main` after the merge — needs a
// bypass actor cut into `main`'s ruleset and puts a second commit on `main` per PR, which every
// installation then measures itself behind (freshness, decisions 45-49). That rejection stands
// from ADR 0003. What changed is only where the number is worked out. `main` still gains tags
// and nothing else, and `package.json` no longer carries a version at all.
//
// Everything here is a decision about state someone else gathered — no git, no network — so the
// rules are testable without a checkout, a tag or a PR. The gathering is the workflow's job; the
// CLI at the bottom is the seam between the two, and `fs` appears there only to read stdin.

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { MAJOR } from './version.mjs'

// The bumps a PR may ask for. `major` is absent on purpose: it is `MIGRATIONS.length`
// (ADR 0002), derived so it cannot be forgotten, and a label that could raise it would hand
// back the one number nobody has to remember.
const BUMPS = ['minor', 'patch', 'none']

// What `rig new --type` writes into a branch name, which is why the prefix is a signal at
// all: it is already there, on every PR, without anyone adopting a convention for it. The
// prefixes that ask for nothing are listed rather than assumed: an unrecognised branch still
// fails, because defaulting it to `none` is how a feature branched `chore/add-retry` ships
// inside somebody else's patch release with nobody told (ADR 0004).
const PREFIX_BUMPS = {
  feat: 'minor',
  fix: 'patch',
  docs: 'none',
  chore: 'none',
  test: 'none',
  ci: 'none',
  refactor: 'none',
}

// Strongest first: a release containing a feature is a minor release, whatever else is in it.
const STRENGTH = ['minor', 'patch', 'none']

// The prefixes that ask for one particular bump, for the message that has to teach someone
// whose branch named none of them. Grouped rather than listed flat: seven prefixes in one
// string reads as seven equivalent choices, and two of them mean something quite different
// from the other five.
const prefixesAsking = bump => Object.entries(PREFIX_BUMPS)
  .filter(([, b]) => b === bump).map(([p]) => `\`${p}/\``).join(', ')

const LABEL = 'release:'

// The version a release tag names, or null for anything that is not one. Tags are the record
// of what was released, so only the exact `v1.2.3` shape counts — a pre-release or a moving
// tag read as a release would compute the next version from a version that never shipped.
export function versionFromTag (tag) {
  const m = /^v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? '').trim())
  return m ? m[1] : null
}

const parts = version => versionFromTag(version)?.split('.').map(Number) ?? null

// -1, 0 or 1 for two `x.y.z` strings, comparing numerically so 1.10.0 is above 1.9.0.
function compare (a, b) {
  const [x, y] = [parts(a), parts(b)]
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1
  return 0
}

// The bump a PR asks for, with the reason it reads that way, or a null bump and the reason
// nobody can tell. The label wins over the prefix: the prefix is rig's default, not a decree,
// and a docs-only PR on a `feat/` branch has to be able to say so.
export function bumpFor ({ branch, labels = [] }) {
  const asked = [...new Set(labels.filter(l => String(l).startsWith(LABEL)))]
  if (asked.length > 1) {
    return { bump: null, reason: `this PR carries ${asked.join(', ')} — two answers to one question; leave the one you mean` }
  }
  if (asked.length === 1) {
    const bump = asked[0].slice(LABEL.length)
    if (BUMPS.includes(bump)) return { bump, reason: `the \`${asked[0]}\` label` }
    return { bump: null, reason: `\`${asked[0]}\` is not a bump this repo has: the major is derived from the migrations (ADR 0002), so the labels are ${BUMPS.map(b => `\`${LABEL}${b}\``).join(', ')}` }
  }
  const prefix = String(branch ?? '').split('/')[0]
  const bump = PREFIX_BUMPS[prefix]
  if (bump) return { bump, reason: `the branch prefix \`${prefix}/\`` }
  return {
    bump: null,
    reason: `\`${branch}\` names no bump: branch from ${prefixesAsking('minor')} for a minor or ${prefixesAsking('patch')} for a patch — what \`rig new --type\` writes — or from ${prefixesAsking('none')} to ask for nothing, or label the PR ${BUMPS.map(b => `\`${LABEL}${b}\``).join(', ')}`,
  }
}

// The version a PR lands as, or null when the latest tag is ahead of the major this code
// derives. That state is not a bump to compute over: the major only ever grows, so a higher
// tag was cut from something this branch does not contain, and a next version over the top of
// it would publish a downgrade under a higher number.
export function expectedVersion ({ latestTag, bump, major = MAJOR }) {
  const latest = versionFromTag(latestTag)
  if (!latest) return `${major}.0.0`
  const [tagMajor, minor, patch] = parts(latest)
  if (tagMajor > major) return null
  // A migration moved the major, so the version follows it whatever the PR asked for — the
  // record format changing *is* the release.
  if (major > tagMajor) return `${major}.0.0`
  if (bump === 'minor') return `${major}.${minor + 1}.0`
  if (bump === 'patch') return `${major}.${minor}.${patch + 1}`
  return latest
}

// The PR gate, and the whole of it: does this pull request name a bump? A question about this
// PR alone, so no other merge can change the answer — which is what stops a required check
// being a queue (ADR 0004). What the PR *lands as* is not asked here, because that is a
// question about the whole set and the set is not knowable from a branch.
export function checkBump ({ branch, labels = [] }) {
  const { bump, reason } = bumpFor({ branch, labels })
  if (!bump) return { ok: false, bump: null, message: reason }
  return { ok: true, bump, message: `this PR asks for ${bump} (${reason})` }
}

// The bump a whole release asks for: the strongest any of its pull requests asked for, or a
// refusal naming what could not be read. `commits` is one entry per commit in the range, each
// carrying every pull request GitHub associates with it — usually one, empty when it knows of
// none, and more than one for a commit that reached `main` through two of them. All of them
// count: taking one and discarding the rest is how the release ends up sized by whichever the
// API happened to list first.
//
// The refusals are the point. A commit with no pull request, or a pull request whose bump does
// not parse, would otherwise fold away to a *smaller* bump than the truth and ship a feature
// inside a patch release with nobody told — the same silent wrong answer, in a new place. ADR
// 0003 made this call once already, failing rather than skipping so a release note could not be
// dropped in silence; nothing is tagged before the set is known, so re-running is safe.
export function bumpOfRelease (commits = [], { base = null } = {}) {
  const orphans = commits.filter(c => !c?.pulls?.length).map(c => String(c?.sha ?? '?').slice(0, 7))
  if (orphans.length) {
    return { ok: false, bump: null, message: `${orphans.length} commit(s) in this range resolve to no pull request (${orphans.join(', ')}) — the set this release is computed from could not be read, so no version is safe to publish; re-run once GitHub answers for them` }
  }
  const unreadable = []
  let strongest = 'none'
  for (const pull of pullsOf(commits, { base })) {
    const { bump, reason } = bumpFor({ branch: pull.headRefName, labels: pull.labels ?? [] })
    if (!bump) { unreadable.push(`#${pull.number}: ${reason}`); continue }
    if (STRENGTH.indexOf(bump) < STRENGTH.indexOf(strongest)) strongest = bump
  }
  if (unreadable.length) {
    return { ok: false, bump: null, message: `pull request(s) in this release name no bump, so the release cannot be sized:\n  ${unreadable.join('\n  ')}` }
  }
  return { ok: true, bump: strongest, message: `this release asks for ${strongest}` }
}

// Every pull request that landed **on the branch being released**, once each.
//
// Two deduplications and one filter, and the filter is the one worth explaining. A pull request
// reaches this more than once whenever a merge method keeps several commits for it, and a commit
// reaches it under two numbers when it belongs to two — that second case is the ordinary shape of
// a staged work, where each commit is in its stage's pull request *and* in the work branch's.
//
// Both are real pull requests and only one of them landed here. A stage merged into the work
// branch; the work branch merged into `main`. Taking both would describe one change twice over —
// three stage descriptions and the work branch's own — in a release that contains it once. So a
// release is made of the pull requests whose base is the branch it is a release of, which is
// also exactly what "this release contains these pull requests" means.
//
// `base` is optional: with no base named, every pull request counts, which is what a caller with
// no opinion should get rather than an empty release.
export const pullsOf = (commits, { base = null } = {}) => [
  ...new Map((commits ?? [])
    .flatMap(c => c?.pulls ?? [])
    .filter(Boolean)
    .filter(p => !base || p.baseRefName === base)
    .map(p => [p.number, p])).values(),
]

// The merge gate: is this push to `main` a release, and of what? The version is worked out
// here, from the bumps of the pull requests the push contains, because here is the only place
// the set is known (ADR 0004).
export function releaseVerdict ({ commits = [], latestTag, base = null, major = MAJOR }) {
  const asked = bumpOfRelease(commits, { base })
  if (!asked.ok) return { ok: false, release: false, tag: null, previousTag: null, version: null, message: asked.message }

  const version = expectedVersion({ latestTag, bump: asked.bump, major })
  if (!version) {
    return { ok: false, release: false, tag: null, previousTag: null, version: null, message: `the latest release ${latestTag} is a major above the ${major} these migrations derive — it was cut from something this commit does not contain, so there is no next version to compute` }
  }

  const previous = versionFromTag(latestTag)
  const tag = `v${version}`
  const previousTag = previous ? latestTag : null
  if (!previous) return { ok: true, release: true, tag, previousTag, version, message: `the first release: ${tag}` }
  // `expectedVersion` never goes backwards, so the only way to land on the latest tag is a
  // release every pull request in it asked nothing of.
  if (compare(version, previous) === 0) return { ok: true, release: false, tag: null, previousTag, version, message: `every pull request since ${latestTag} asked for none — nothing to release` }
  return { ok: true, release: true, tag, previousTag, version, message: `releasing ${tag}, the first since ${latestTag} (${asked.bump})` }
}

// ------------------------------------------------------------------------- the notes
//
// The body of a release is the descriptions of the pull requests that made it: already
// written, already reviewed, and already saying why. Assembling them beats writing a
// changelog entry by hand for the same reason the bump is computed rather than remembered.

// What an agent signs at the end of a PR description. It belongs to the PR, not the release.
const ATTRIBUTION = /^[ \t]*(🤖 Generated with \[Claude Code\].*|Co-authored-by:.*)$/gmi

// A pull request description writes its own headings at `##`, and so does the title this wraps
// it in — which left the notes flat, with `## Why` indistinguishable from the pull request it
// belonged to. Every heading in a body moves down one level so the titles stay above them.
// Fenced code is skipped: `#` at the start of a line inside a fence is a shell comment, and
// deepening it would edit somebody's example.
function demoteHeadings (body) {
  let fenced = false
  return body.split('\n').map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line }
    return fenced ? line : line.replace(/^(#{1,5}) /, '#$1 ')
  }).join('\n')
}

const descriptionOf = body => demoteHeadings(String(body ?? '').replace(/\r/g, '').replace(ATTRIBUTION, '')).trim()

export function releaseNotes ({ tag, previousTag, repo, pulls = [] }) {
  // Oldest first: a release reads as the order things happened in, not the order an API
  // handed them back.
  const sections = [...pulls].sort((a, b) => a.number - b.number)
    .map(p => `## ${p.title} ([#${p.number}](${p.url}))\n\n${descriptionOf(p.body)}`.trim())
  const body = sections.length
    ? sections.join('\n\n')
    : 'No pull request carried the commits in this release.'
  const changelog = previousTag
    ? `https://github.com/${repo}/compare/${previousTag}...${tag}`
    : `https://github.com/${repo}/commits/${tag}`
  return `${body}\n\n**Full changelog**: ${changelog}\n`
}

// -------------------------------------------------------------- what a checkout is on
//
// `git describe --long` against the release tags, so a checkout can be named by the release
// it stands on rather than by a sha nobody can place. `--long` is the point: it reports the
// distance even when the tag is exact, so one call answers both halves.

export function parseDescribe (out) {
  const m = /^(v\d+\.\d+\.\d+)-(\d+)-g[0-9a-f]+$/.exec(String(out ?? '').trim())
  return m ? { tag: m[1], distance: Number(m[2]) } : null
}

// What `package.json` carries in the tree, and never in a published artifact: the version is
// worked out at the release (ADR 0004), and injected into the package at publish. The suffix
// is semantic-release's documented placeholder, kept for its stated reason — it "makes it
// clear to contributors that the version is not kept up to date".
export const PLACEHOLDER_VERSION = '0.0.0-development'

// A version that names a release, as against the placeholder or junk. Deliberately strict:
// a plain `major.minor.patch` and nothing else, because rig publishes no prereleases (there
// is one stable channel and the clone is the other) and a value this cannot read is one to
// say nothing about rather than to print.
const releaseVersion = v => (/^\d+\.\d+\.\d+$/.test(String(v ?? '')) ? `v${v}` : null)

// How to name this installation, in the order the answers can be trusted:
//
//   1. what `git describe` says — the release, or the distance past it;
//   2. `package.json`'s version, for an installation that has no `.git` to ask. This is the
//      published-package case, and the only thing it can say about itself;
//   3. the commit, which is all rig could say before there were releases.
//
// **git comes first, and that is the load-bearing part of the order.** A development checkout
// carries the placeholder *and* real history, so reading `package.json` ahead of git would
// report a release the tree is not standing on — and once a release injects a real version,
// would report it on every commit after it too.
//
// This is the one read of `package.json` in rig, and it is a *display* fact. `FORMAT_STAMP`
// still reads nothing: ADR 0004 moved the record-format stamp off this file precisely so the
// placeholder could not become an unparseable stamp and refuse every mutating command, and
// nothing here reaches that path.
export function releaseMark ({ describe, head, packageVersion }) {
  const at = parseDescribe(describe)
  const sha = head ? String(head).slice(0, 7) : null
  if (!at) return sha ?? releaseVersion(packageVersion)
  if (at.distance === 0) return at.tag
  return sha ? `${at.distance} past ${at.tag}, ${sha}` : `${at.distance} past ${at.tag}`
}

// ------------------------------------------------------------------ the workflow's seam
//
// `check` is the PR's required status check, `verdict` is what the merge workflow reads to
// decide whether to tag and of what, and `notes` turns the pull requests it gathered into a
// release body. All three take the gathered state as flags or on stdin, so a workflow step is
// one line and every rule above stays pure. None of them reads `package.json`: it no longer
// carries a version (ADR 0004).
//
// `verdict` and `notes` read the same stdin shape, one entry per commit in the range:
//
//   [{ "sha": "abc1234", "pulls": [{ "number": 7, "title": "…", "url": "…", "body": "…",
//                                    "headRefName": "feat/x", "labels": ["release:none"] }] }]
//
// `pulls` is empty for a commit GitHub could not name a pull request for, which `verdict`
// refuses on rather than folding away. It holds more than one for a commit that belongs to
// more than one, and every entry counts.

const flags = argv => Object.fromEntries(
  argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1]?.startsWith('--') ? '' : argv[i + 1] ?? '']] : [])),
)

// A release's worth of descriptions is far past what a command line holds, so the set arrives
// on stdin.
const commitsFromStdin = () => JSON.parse(fs.readFileSync(0, 'utf8') || '[]')

function main (argv) {
  const [command, ...rest] = argv
  const f = flags(rest)

  if (command === 'check') {
    const labels = (f.labels || '').split(',').map(s => s.trim()).filter(Boolean)
    const v = checkBump({ branch: f.branch, labels })
    console.log(v.message)
    return v.ok ? 0 : 1
  }
  if (command === 'verdict') {
    const v = releaseVerdict({ commits: commitsFromStdin(), latestTag: f.tag || null, base: f.base || null })
    console.error(v.message)
    console.log(JSON.stringify({ release: v.release, tag: v.tag, previousTag: v.previousTag, version: v.version }))
    return v.ok ? 0 : 1
  }
  if (command === 'notes') {
    console.log(releaseNotes({ tag: f.tag, previousTag: f.previous || null, repo: f.repo, pulls: pullsOf(commitsFromStdin(), { base: f.base || null }) }))
    return 0
  }
  console.error('usage: node bin/release.mjs check --branch feat/x --labels a,b\n       node bin/release.mjs verdict --tag v1.0.0 --base main < commits.json\n       node bin/release.mjs notes --tag v1.1.0 --previous v1.0.0 --repo owner/name --base main < commits.json')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
