// Releases: what version a PR lands as, and whether a merge to `main` is a release.
//
// The shape this automates: **the PR carries its own version.** A required check fails until
// `package.json` says what the PR will land as, and the merge only tags that commit and
// publishes the notes. The adjacent design — a workflow that bumps and commits on `main`
// after the merge — needs a bypass actor cut into `main`'s ruleset and puts a second commit
// on `main` per PR, which every installation then measures itself behind (freshness,
// decisions 45-49). Here `main` gains tags and nothing else, and `package.json` is truthful
// at every commit on it.
//
// Everything here is a decision about state someone else gathered — no git, no fs, no
// network — so the rules are testable without a checkout, a tag or a PR. The gathering is
// the workflow's job; the CLI at the bottom is the seam between the two.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { MAJOR } from './version.mjs'

// The bumps a PR may ask for. `major` is absent on purpose: it is `MIGRATIONS.length`
// (ADR 0002), derived so it cannot be forgotten, and a label that could raise it would hand
// back the one number nobody has to remember.
const BUMPS = ['minor', 'patch', 'none']

// What `rig new --type` writes into a branch name, which is why the prefix is a signal at
// all: it is already there, on every PR, without anyone adopting a convention for it.
const PREFIX_BUMPS = { feat: 'minor', fix: 'patch' }

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
    reason: `\`${branch}\` names no bump: branch from ${Object.keys(PREFIX_BUMPS).map(p => `\`${p}/\``).join(' or ')} — what \`rig new --type\` writes — or label the PR ${BUMPS.map(b => `\`${LABEL}${b}\``).join(', ')}`,
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

// The PR gate: does `package.json` say what this PR will land as? One verdict, one message,
// whichever of the three ways it can fail happened.
export function checkVersion ({ pkgVersion, latestTag, branch, labels = [], major = MAJOR }) {
  const { bump, reason } = bumpFor({ branch, labels })
  if (!bump) return { ok: false, bump: null, expected: null, message: reason }

  const expected = expectedVersion({ latestTag, bump, major })
  if (!expected) {
    return { ok: false, bump, expected: null, message: `the latest release ${latestTag} is a major above the ${major} these migrations derive — it was cut from something this branch does not contain, so there is no next version to compute` }
  }
  if (pkgVersion === expected) return { ok: true, bump, expected, message: `this PR lands as ${expected} (${bump}, ${reason})` }
  return {
    ok: false,
    bump,
    expected,
    message: `package.json says ${pkgVersion}, but this PR lands as ${expected} (${bump}, ${reason}) — set "version": "${expected}"`,
  }
}

// The merge gate: is this commit on `main` a release, and of what? A held version is a
// `release:none` merge and releases nothing. A version *below* the latest tag fails instead
// of skipping: that is two PRs having computed the same next version, and skipping would drop
// the second one's notes silently.
export function releaseVerdict ({ pkgVersion, latestTag }) {
  const version = versionFromTag(pkgVersion)
  if (!version) return { ok: false, release: false, tag: null, previousTag: null, message: `package.json says ${pkgVersion}, which is not a version to release` }

  const previous = versionFromTag(latestTag)
  const tag = `v${version}`
  const previousTag = previous ? latestTag : null
  if (!previous) return { ok: true, release: true, tag, previousTag, message: `the first release: ${tag}` }

  const order = compare(version, previous)
  if (order > 0) return { ok: true, release: true, tag, previousTag, message: `releasing ${tag}, the first since ${latestTag}` }
  if (order === 0) return { ok: true, release: false, tag: null, previousTag, message: `package.json is still at ${version}, already released as ${latestTag} — nothing to release` }
  return {
    ok: false,
    release: false,
    tag: null,
    previousTag,
    message: `package.json says ${version}, behind the latest release ${latestTag} — this merge computed its version before ${latestTag} was cut, so its changes would ship with no release of their own; bump package.json above ${previous}`,
  }
}

// ------------------------------------------------------------------------- the notes
//
// The body of a release is the descriptions of the pull requests that made it: already
// written, already reviewed, and already saying why. Assembling them beats writing a
// changelog entry by hand for the same reason the bump is computed rather than remembered.

// What an agent signs at the end of a PR description. It belongs to the PR, not the release.
const ATTRIBUTION = /^[ \t]*(🤖 Generated with \[Claude Code\].*|Co-authored-by:.*)$/gmi

const descriptionOf = body => String(body ?? '').replace(/\r/g, '').replace(ATTRIBUTION, '').trim()

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

// How to name this checkout: the release, the distance past it, or — with no release in its
// history at all — the commit, which is all rig could say before there were releases.
export function releaseMark ({ describe, head }) {
  const at = parseDescribe(describe)
  const sha = head ? String(head).slice(0, 7) : null
  if (!at) return sha
  if (at.distance === 0) return at.tag
  return sha ? `${at.distance} past ${at.tag}, ${sha}` : `${at.distance} past ${at.tag}`
}

// ------------------------------------------------------------------ the workflow's seam
//
// `check` is the PR's required status check, `verdict` is what the merge workflow reads to
// decide whether to tag, and `notes` turns the pull requests it gathered into a release
// body. All three take the gathered state as flags or stdin and read `package.json`
// themselves, so a workflow step is one line and every rule above stays pure.

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const flags = argv => Object.fromEntries(
  argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1]?.startsWith('--') ? '' : argv[i + 1] ?? '']] : [])),
)

function main (argv) {
  const [command, ...rest] = argv
  const f = flags(rest)
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
  const labels = (f.labels || '').split(',').map(s => s.trim()).filter(Boolean)

  if (command === 'check') {
    const v = checkVersion({ pkgVersion, latestTag: f.tag || null, branch: f.branch, labels })
    console.log(v.message)
    return v.ok ? 0 : 1
  }
  if (command === 'verdict') {
    const v = releaseVerdict({ pkgVersion, latestTag: f.tag || null })
    console.error(v.message)
    console.log(JSON.stringify({ release: v.release, tag: v.tag, previousTag: v.previousTag, version: pkgVersion }))
    return v.ok ? 0 : 1
  }
  if (command === 'notes') {
    // The pull requests arrive on stdin as the JSON array the workflow assembled, because a
    // release's worth of descriptions is far past what a command line holds.
    const pulls = JSON.parse(fs.readFileSync(0, 'utf8') || '[]')
    console.log(releaseNotes({ tag: f.tag, previousTag: f.previous || null, repo: f.repo, pulls }))
    return 0
  }
  console.error('usage: node bin/release.mjs check --tag v1.0.0 --branch feat/x --labels a,b\n       node bin/release.mjs verdict --tag v1.0.0\n       node bin/release.mjs notes --tag v1.1.0 --previous v1.0.0 --repo owner/name < pulls.json')
  return 2
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
