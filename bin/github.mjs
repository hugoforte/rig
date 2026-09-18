// GitHub, behind one interface. Every `gh` invocation rig makes lives here, with its
// output parsing, so callers never build argv or read gh output themselves. Two
// adapters satisfy the interface: `githubViaGh` shells out to `gh` (DESIGN.md §2: rig
// authenticates to nothing but git), and `githubInMemory` holds canned repos,
// PRs and issues for tests. rig picks the adapter; see `github()` in rig.mjs.
//
// The interface, and what each call may do:
//   auth()                              'ok' | 'unauthenticated' | 'missing'; never throws
//   repo(org, name)                     { name, language } with GitHub's canonical name, or null
//   prForBranch(org, name, branch)      { number, state, url, openedAt, mergedAt } newest PR, or null
//   prFirstCommitAt(org, name, number)  ISO date of the PR's earliest commit, or null
//   createIssue(repo, title, body)      the new issue's number
//   commentIssue(repo, number, body)
//   closeIssue(repo, number)
//   repoExists(spec)                    spec is owner/name
//   clone(spec, target)
//   createRepo(spec, { source, description })   private, pushed from `source`
// Every call but auth() throws GithubError when gh cannot be spawned at all. When gh runs
// but exits non-zero, the lookups (repo, prForBranch, prFirstCommitAt, repoExists) answer
// null or false — "not found" and "gh could not answer" look the same to them — and every
// other call throws GithubError carrying gh's stderr.
//
// createIssue, commentIssue and closeIssue are the tracker operations: what rig does to
// a ticket. bin/jira.mjs presents the same operations for Jira under its own names.
import { spawnSync } from 'node:child_process'
import { TrackerError } from './errors.mjs'
import { jsonCliHelpers, cliRunner } from './cli.mjs'

export class GithubError extends TrackerError {}
const { fail, firstLine, parseJson } = jsonCliHelpers(GithubError)

const spawnGh = args => spawnSync('gh', args, { encoding: 'utf8' })

export function githubViaGh ({ exec = spawnGh } = {}) {
  const { run: gh, must } = cliRunner('gh', exec, fail)

  return {
    auth () {
      const r = exec(['auth', 'status'])
      if (r.error) return 'missing'
      return r.status === 0 ? 'ok' : 'unauthenticated'
    },
    repo (org, name) {
      const r = gh(['api', `repos/${org}/${name}`, '--jq', '{name,language}'])
      if (r.code !== 0 || !r.out) return null
      const { name: canonical, language } = parseJson(r.out, 'gh api')
      return { name: canonical, language: language || '' }
    },
    prForBranch (org, name, branch) {
      const r = gh(['pr', 'list', '--repo', `${org}/${name}`, '--head', branch,
        '--state', 'all', '--json', 'number,state,url,createdAt,mergedAt', '--limit', '1'])
      if (r.code !== 0 || !r.out) return null
      const prs = parseJson(r.out, 'gh pr list')
      if (!Array.isArray(prs)) fail(`gh pr list returned something that is not a list: ${firstLine(r.out)}`)
      const [pr] = prs
      return pr ? { number: pr.number, state: pr.state, url: pr.url, openedAt: pr.createdAt || null, mergedAt: pr.mergedAt || null } : null
    },
    // The PR, not the branch, because a merged PR's branch is usually deleted — this is
    // the only place the first commit of finished work can still be read.
    prFirstCommitAt (org, name, number) {
      const r = gh(['pr', 'view', String(number), '--repo', `${org}/${name}`,
        '--json', 'commits', '--jq', '[.commits[].authoredDate] | min'])
      if (r.code !== 0) return null
      const out = firstLine(r.out)
      return out && out !== 'null' ? out : null
    },
    createIssue (repo, title, body) {
      const out = must(['issue', 'create', '--repo', repo, '--title', title, '--body', body])
      const n = /\/issues\/(\d+)\s*$/.exec(out)?.[1]
      if (!n) fail(`could not read the issue number from gh output:\n${out}`)
      return Number(n)
    },
    commentIssue (repo, number, body) {
      must(['issue', 'comment', String(number), '--repo', repo, '--body', body])
    },
    closeIssue (repo, number) {
      must(['issue', 'close', String(number), '--repo', repo])
    },
    repoExists (spec) {
      return gh(['repo', 'view', spec, '--json', 'name']).code === 0
    },
    clone (spec, target) {
      must(['repo', 'clone', spec, target])
    },
    createRepo (spec, { source, description }) {
      must(['repo', 'create', spec, '--private', '--source', source, '--push', '--description', description])
    },
  }
}

// Canned GitHub for tests. `state` is mutated in place so the harness can persist and
// inspect it: { auth, repos: { 'owner/name': { language, prs, issues, source } } }.
// `auth` mirrors the real adapter: 'missing' fails every call; 'unauthenticated' makes
// lookups answer null or false, as gh's non-zero exit does, and writes fail.
export function githubInMemory (state) {
  state.repos = state.repos || {}
  // Can gh answer at all (missing fails everything), and is it allowed to (writes need auth)?
  const answers = () => {
    if (state.auth === 'missing') fail('gh not found on PATH (in-memory GitHub)')
    return state.auth !== 'unauthenticated'
  }
  const write = () => { if (!answers()) fail('gh is not authenticated (in-memory GitHub)') }
  const lookup = spec => {
    const key = Object.keys(state.repos).find(k => k.toLowerCase() === spec.toLowerCase())
    return key ? { key, repo: state.repos[key] } : null
  }
  const issue = (spec, number) => {
    const found = lookup(spec)?.repo.issues?.find(i => i.number === Number(number))
    return found || fail(`${spec}#${number}: no such issue (in-memory GitHub)`)
  }

  return {
    auth: () => state.auth || 'ok',
    repo (org, name) {
      if (!answers()) return null
      const found = lookup(`${org}/${name}`)
      return found ? { name: found.key.split('/')[1], language: found.repo.language || '' } : null
    },
    prForBranch (org, name, branch) {
      if (!answers()) return null
      // The newest PR on the branch, as `gh pr list --limit 1` answers — a closed PR
      // re-opened as a new one must show the open one to the close safety check.
      const pr = (lookup(`${org}/${name}`)?.repo.prs || [])
        .filter(p => p.branch === branch).sort((a, b) => b.number - a.number)[0]
      return pr ? { number: pr.number, state: pr.state, url: pr.url, openedAt: pr.openedAt || null, mergedAt: pr.mergedAt || null } : null
    },
    prFirstCommitAt (org, name, number) {
      if (!answers()) return null
      const pr = (lookup(`${org}/${name}`)?.repo.prs || []).find(p => p.number === Number(number))
      const dates = (pr?.commits || []).slice().sort()
      return dates[0] || null
    },
    createIssue (spec, title, body) {
      write()
      const found = lookup(spec) || fail(`${spec}: no such repo (in-memory GitHub)`)
      found.repo.issues = found.repo.issues || []
      const number = Math.max(0, ...found.repo.issues.map(i => i.number)) + 1
      found.repo.issues.push({ number, title, body, state: 'OPEN', comments: [] })
      return number
    },
    commentIssue (spec, number, body) {
      write()
      const found = issue(spec, number)
      found.comments = found.comments || []   // a hand-seeded fixture may omit it
      found.comments.push(body)
    },
    closeIssue (spec, number) {
      write()
      issue(spec, number).state = 'CLOSED'
    },
    repoExists (spec) {
      return answers() && lookup(spec) !== null
    },
    clone (spec, target) {
      write()
      // The one on-disk effect: a clone is a checkout, so it clones from the recorded source.
      const found = lookup(spec) || fail(`${spec}: no such repo (in-memory GitHub)`)
      const source = found.repo.source || fail(`${spec}: exists but has no \`source\` to clone from (in-memory GitHub)`)
      const r = spawnSync('git', ['clone', '-q', source, target], { encoding: 'utf8' })
      if (r.error) fail(`git not found on PATH (${r.error.message})`)
      if (r.status !== 0) fail(`clone of ${spec}: ${(r.stderr || '').trim()}`)
    },
    createRepo (spec, { source }) {
      write()
      if (lookup(spec)) fail(`${spec}: already exists (in-memory GitHub)`)
      state.repos[spec] = { language: '', prs: [], issues: [], source }
    },
  }
}
