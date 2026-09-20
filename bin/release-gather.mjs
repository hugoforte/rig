// Gathering for a release: which commits a push contains, and which pull requests each of them
// came from.
//
// This exists as a module rather than as shell in `.github/workflows/release.yml` for one
// reason, and it is the reason that matters: **nothing tests a workflow.** Every defect found
// while building this release path lived in that YAML — a `first // null` that kept one
// arbitrary pull request per commit, a payload shape that drifted from what the decisions read,
// and release notes whose headings collided. All of them were caught by running the commands by
// hand, which is a test nobody runs twice.
//
// The split is `bin/checkouts.mjs` and `bin/freshness.mjs`'s: this reaches for git and GitHub
// and decides nothing, `bin/release.mjs` decides and reaches for nothing. ADR 0003 and 0004 say
// the workflows gather and do not decide; what they did not say is that the gathering has to be
// reachable from a test, and this is that.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { githubViaGh, githubInMemory } from './github.mjs'

// `git rev-list a..b` in the order a release reads: oldest first, so the notes read as the order
// things happened in rather than as the order git walks. With no previous tag the range is the
// whole history, which is what a first release is.
export function commitsInRange ({ previous, head = 'HEAD', git = spawnGit }) {
  const r = git(['rev-list', '--reverse', previous ? `${previous}..${head}` : head])
  if (r.status !== 0) throw new Error(`git rev-list failed: ${(r.stderr || '').trim() || 'no detail from git'}`)
  return String(r.stdout || '').split('\n').map(s => s.trim()).filter(Boolean)
}

// One entry per commit, each carrying every pull request GitHub associates with it. A commit
// GitHub names none for keeps an empty list rather than being dropped: `bin/release.mjs` refuses
// on it, and a set that quietly lost a member is how a feature ships in a patch release.
export function gather ({ repo, previous, head = 'HEAD', github, git = spawnGit }) {
  const [org, name] = String(repo).split('/')
  if (!org || !name) throw new Error(`\`${repo}\` is not an owner/name repository`)
  return commitsInRange({ previous, head, git }).map(sha => ({
    sha,
    pulls: github.pullsForCommit(org, name, sha) ?? [],
  }))
}

const spawnGit = args => spawnSync('git', args, { encoding: 'utf8' })

// ------------------------------------------------------------------ the workflow's seam

function main (argv) {
  const f = Object.fromEntries(
    argv.flatMap((a, i) => (a.startsWith('--') ? [[a.slice(2), argv[i + 1]?.startsWith('--') ? '' : argv[i + 1] ?? '']] : [])),
  )
  if (!f.repo) {
    console.error('usage: node bin/release-gather.mjs --repo owner/name [--previous v1.0.0] [--head HEAD]')
    return 2
  }
  // Resolved the way `rig.mjs` resolves it — `RIG_FAKE_GITHUB` names a JSON file and swaps the
  // in-memory adapter in — so a test fakes this exactly the way it fakes every other GitHub
  // call, instead of needing a `gh` on PATH. Read here rather than shared with `rig.mjs`'s
  // `adapterResolver`, which also carries the write-back half that nothing in a release wants.
  const fake = process.env.RIG_FAKE_GITHUB
  const github = fake
    ? githubInMemory(fs.existsSync(fake) ? JSON.parse(fs.readFileSync(fake, 'utf8')) : {})
    : githubViaGh()
  const payload = gather({ repo: f.repo, previous: f.previous || null, head: f.head || 'HEAD', github })
  console.log(JSON.stringify(payload, null, 2))
  return 0
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)))
}
