// GitHub, behind one interface. Every `gh` invocation rig makes lives here, with its
// output parsing, so callers never build argv or read gh output themselves. Two
// adapters satisfy the interface: `githubViaGh` shells out to `gh` (DESIGN.md decision
// 29: rig authenticates to nothing but git), and `githubInMemory` holds canned repos,
// PRs and issues for tests. rig picks the adapter; see `github()` in rig.mjs.
//
// The interface, and what each call may do:
//   auth()                              'ok' | 'unauthenticated' | 'missing'; never throws
//   repo(org, name)                     { name, language } with GitHub's canonical name, or null
//   prForBranch(org, name, branch)      { number, state, url } for the newest PR, or null
//   createIssue(repo, title, body)      the new issue's number
//   commentIssue(repo, number, body)
//   closeIssue(repo, number)
//   repoExists(spec)                    spec is owner/name
//   clone(spec, target)
//   createRepo(spec, { source, description })   private, pushed from `source`
// Every call but auth() throws GithubError when gh is missing. Lookups (repo, prForBranch,
// repoExists) answer null or false when gh fails; every other call throws GithubError.
//
// createIssue, commentIssue and closeIssue are the tracker operations: what rig does to
// a ticket. A tracker of another kind presents the same operations under its own names.
import { spawnSync } from 'node:child_process'

export class GithubError extends Error {}

const fail = msg => { throw new GithubError(msg) }
const firstLine = s => (s || '').trim().split('\n')[0]

const parseJson = (text, what) => {
  try { return JSON.parse(text) } catch (e) { fail(`${what} returned unreadable JSON (${e.message}): ${firstLine(text)}`) }
}

const spawnGh = args => spawnSync('gh', args, { encoding: 'utf8' })

export function githubViaGh ({ exec = spawnGh } = {}) {
  // Runs gh; missing gh is fatal here, once, for every caller.
  const gh = args => {
    const r = exec(args)
    if (r.error) fail(`gh not found on PATH (${r.error.message})`)
    return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() }
  }
  const must = args => {
    const r = gh(args)
    if (r.code !== 0) fail(`gh ${args.slice(0, 2).join(' ')}: ${firstLine(r.err || r.out)}`)
    return r.out
  }

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
        '--state', 'all', '--json', 'number,state,url', '--limit', '1'])
      if (r.code !== 0 || !r.out) return null
      const [pr] = parseJson(r.out, 'gh pr list')
      return pr ? { number: pr.number, state: pr.state, url: pr.url } : null
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
  const guard = () => { if (state.auth === 'missing') fail('gh not found on PATH (in-memory GitHub)') }
  const write = () => { guard(); if (state.auth === 'unauthenticated') fail('gh is not authenticated (in-memory GitHub)') }
  const answers = () => { guard(); return state.auth !== 'unauthenticated' }
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
      const pr = lookup(`${org}/${name}`)?.repo.prs?.find(p => p.branch === branch)
      return pr ? { number: pr.number, state: pr.state, url: pr.url } : null
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
      issue(spec, number).comments.push(body)
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
      const source = lookup(spec)?.repo.source || fail(`${spec}: no such repo (in-memory GitHub)`)
      const r = spawnSync('git', ['clone', '-q', source, target], { encoding: 'utf8' })
      if (r.status !== 0) fail(`clone of ${spec}: ${firstLine(r.stderr)}`)
    },
    createRepo (spec, { source }) {
      write()
      if (lookup(spec)) fail(`${spec}: already exists (in-memory GitHub)`)
      state.repos[spec] = { language: '', prs: [], issues: [], source }
    },
  }
}
