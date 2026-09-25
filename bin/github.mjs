// GitHub, behind one interface. Every `gh` invocation rig makes lives here, with its
// output parsing, so callers never build argv or read gh output themselves. Two
// adapters satisfy the interface: `githubViaGh` shells out to `gh` (DESIGN.md §2: rig
// authenticates to nothing but git), and `githubInMemory` holds canned repos,
// PRs and issues for tests. rig picks the adapter; see `github()` in rig.mjs.
//
// The interface, and what each call may do:
//   auth()                              'ok' | 'unauthenticated' | 'missing'; never throws
//   repo(org, name)                     { name, language } with GitHub's canonical name, or null
//   prForBranch(org, name, branch)      { number, state, base, url, openedAt, mergedAt } newest PR, or null
//   prTimeline(org, name, number)       { firstCommitAt, firstReviewAt, approvedAt }, or null
//   createPr(org, name, { branch, base, title, body })   { number, url } for the new PR
//   createIssue(repo, title, body)      the new issue's number
//   commentIssue(repo, number, body)
//   closeIssue(repo, number)
//   repoExists(spec)                    spec is owner/name
//   clone(spec, target)
//   createRepo(spec, { source, description })   private, pushed from `source`
// Every call but auth() throws GithubError when gh cannot be spawned at all. When gh runs
// but exits non-zero, the lookups (repo, prForBranch, prTimeline, repoExists) answer
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

// `min` of an empty list is null, which is what "never reviewed" should read as. A review
// still being written has no `submittedAt`, and must not count as the first look.
const PR_TIMELINE_JQ = [
  '{ firstCommitAt: ([.commits[].authoredDate] | min)',
  ', firstReviewAt: ([.reviews[] | select(.submittedAt != null) | .submittedAt] | min)',
  ', approvedAt: ([.reviews[] | select(.state == "APPROVED" and .submittedAt != null) | .submittedAt] | min) }',
].join('')

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
    // `baseRefName` is the base the PR lands on *now* — repoint a PR at another branch and
    // it changes, where the base a work recorded at `rig attach` never does. It rides along
    // with the PR state for no extra round trip, which is what makes a live base affordable
    // on every `list`, `status` and `close`. `headRefOid` rides along the same way: it is the
    // commit the PR carried, and the only thing that lets `close` tell a branch whose every
    // commit landed from one somebody pushed to after the merge.
    prForBranch (org, name, branch) {
      const r = gh(['pr', 'list', '--repo', `${org}/${name}`, '--head', branch,
        '--state', 'all', '--json', 'number,state,baseRefName,headRefOid,url,createdAt,mergedAt', '--limit', '1'])
      if (r.code !== 0 || !r.out) return null
      const prs = parseJson(r.out, 'gh pr list')
      if (!Array.isArray(prs)) fail(`gh pr list returned something that is not a list: ${firstLine(r.out)}`)
      const [pr] = prs
      return pr ? { number: pr.number, state: pr.state, base: pr.baseRefName || null, head: pr.headRefOid || null, url: pr.url, openedAt: pr.createdAt || null, mergedAt: pr.mergedAt || null } : null
    },
    // The open pull requests that land on a branch — what is stacked on top of it. `rig
    // restore` follows these up from the highest branch a work records, to name the stack
    // somebody built on it without telling rig.
    prsOnto (org, name, base) {
      const r = gh(['pr', 'list', '--repo', `${org}/${name}`, '--base', base,
        '--state', 'open', '--json', 'number,headRefName,url'])
      if (r.code !== 0 || !r.out) return []
      const prs = parseJson(r.out, 'gh pr list')
      if (!Array.isArray(prs)) fail(`gh pr list returned something that is not a list: ${firstLine(r.out)}`)
      return prs.map(pr => ({ number: pr.number, branch: pr.headRefName, url: pr.url }))
    },
    // Every pull request a commit belongs to, for assembling a release. Asked of the API per
    // commit rather than parsed out of commit messages: a squash subject carries `(#12)` and a
    // merge commit does not, and neither is a record.
    //
    // **All of them, not the first.** A commit reaches a branch under two numbers whenever it
    // is in a stage's pull request and in the work branch's, which is the ordinary shape of a
    // staged work — taking one would size a release by whichever the API listed first and drop
    // the other from the notes. An empty list is a real answer and stays one: it is what
    // `bin/release.mjs` refuses on rather than folding away.
    pullsForCommit (org, name, sha) {
      const r = gh(['api', `repos/${org}/${name}/commits/${sha}/pulls`, '--jq',
        'map({number, title, url: .html_url, body, headRefName: .head.ref, baseRefName: .base.ref, labels: [.labels[].name]})'])
      if (r.code !== 0 || !r.out) return []
      const pulls = parseJson(r.out, 'gh api commits/pulls')
      if (!Array.isArray(pulls)) fail(`gh api commits/pulls returned something that is not a list: ${firstLine(r.out)}`)
      return pulls
    },
    // The PR, not the branch, because a merged PR's branch is usually deleted — this is the
    // only place the first commit of finished work can still be read. Commits and reviews
    // come back in one call: a second round trip per repo is what makes a listing unusable.
    // `jq` reduces before parsing, because review bodies are the bulk of the answer and
    // nothing here wants them.
    prTimeline (org, name, number) {
      const r = gh(['pr', 'view', String(number), '--repo', `${org}/${name}`,
        '--json', 'commits,reviews', '--jq', PR_TIMELINE_JQ])
      if (r.code !== 0 || !r.out) return null
      const t = parseJson(r.out, 'gh pr view')
      return { firstCommitAt: t.firstCommitAt, firstReviewAt: t.firstReviewAt, approvedAt: t.approvedAt }
    },
    // The one write rig makes to a pull request, and it makes it once: `rig pr` checks for
    // an existing one first (idempotence is the caller's, because "already open" is a thing
    // to report rather than an error to raise).
    createPr (org, name, { branch, base, title, body }) {
      const out = must(['pr', 'create', '--repo', `${org}/${name}`,
        '--head', branch, '--base', base, '--title', title, '--body', body])
      const url = /(https:\/\/\S*\/pull\/\d+)\s*$/.exec(out)?.[1]
      if (!url) fail(`could not read the pull request URL from gh output:\n${out}`)
      return { number: Number(/\/pull\/(\d+)$/.exec(url)[1]), url }
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
// `env` is the run's, for the one call below that spawns anything: a clone made under the
// machine's real global config rather than the run's is how an isolated test starts
// answering for the machine it happens to be on.
export function githubInMemory (state, { env } = {}) {
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
      return pr ? { number: pr.number, state: pr.state, base: pr.base || null, head: pr.head || null, url: pr.url, openedAt: pr.openedAt || null, mergedAt: pr.mergedAt || null } : null
    },
    prsOnto (org, name, base) {
      if (!answers()) return []
      return (lookup(`${org}/${name}`)?.repo.prs || [])
        .filter(p => p.base === base && p.state === 'OPEN')
        .map(p => ({ number: p.number, branch: p.branch, url: p.url }))
    },
    // Every pull request whose `commits` list contains this sha, in the order the fixture
    // declares them — a commit in two of them answers with both, which is the case the real
    // adapter's `map(...)` exists for and the one a release has to get right.
    pullsForCommit (org, name, sha) {
      if (!answers()) return []
      return (lookup(`${org}/${name}`)?.repo.prs || [])
        .filter(p => (p.commits || []).includes(sha))
        .map(p => ({
          number: p.number,
          title: p.title || `PR ${p.number}`,
          url: p.url || `https://github.com/${org}/${name}/pull/${p.number}`,
          body: p.body || '',
          headRefName: p.branch || null,
          baseRefName: p.base || null,
          labels: p.labels || [],
        }))
    },
    prTimeline (org, name, number) {
      if (!answers()) return null
      const pr = (lookup(`${org}/${name}`)?.repo.prs || []).find(p => p.number === Number(number))
      if (!pr) return null
      const earliest = dates => dates.filter(Boolean).slice().sort()[0] || null
      const reviews = pr.reviews || []
      return {
        firstCommitAt: earliest(pr.commits || []),
        firstReviewAt: earliest(reviews.map(r => r.submittedAt)),
        approvedAt: earliest(reviews.filter(r => r.state === 'APPROVED').map(r => r.submittedAt)),
      }
    },
    createPr (org, name, { branch, base, title, body }) {
      write()
      const found = lookup(`${org}/${name}`) || fail(`${org}/${name}: no such repo (in-memory GitHub)`)
      found.repo.prs = found.repo.prs || []
      const number = Math.max(0, ...found.repo.prs.map(pr => pr.number)) + 1
      const url = `https://github.com/${found.key}/pull/${number}`
      found.repo.prs.push({
        branch, base, number, url, title, body,
        state: 'OPEN', openedAt: new Date().toISOString(), mergedAt: null, commits: [],
      })
      return { number, url }
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
      const r = spawnSync('git', ['clone', '-q', source, target], { encoding: 'utf8', ...(env ? { env } : {}) })
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
