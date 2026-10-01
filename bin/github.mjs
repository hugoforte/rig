// GitHub, behind one interface. Every `gh` invocation rig makes lives here, with its
// output parsing, so callers never build argv or read gh output themselves. Two
// adapters satisfy the interface: `githubViaGh` shells out to `gh` (DESIGN.md §2: rig
// authenticates to nothing but git), and `githubInMemory` holds canned repos,
// PRs and issues for tests. rig picks the adapter; see `github()` in rig.mjs.
//
// The interface, and what each call may do:
//   auth()                              'ok' | 'unauthenticated' | 'missing'; never throws
//   repo(org, name)                     { name, language, visibility } with GitHub's canonical name, or null;
//                                       visibility is 'public', 'internal' or 'private', or null when not said
//   prForBranch(org, name, branch)      { number, state, base, head, merge, url, openedAt, mergedAt, title, body, labels } newest PR, or null
//   labels(org, name)                   every label's name
//   prTimeline(org, name, number)       { firstCommitAt, firstReviewAt, approvedAt }, or null
//   createPr(org, name, { branch, base, title, body })   { number, url } for the new PR
//   editPr(org, name, number, { title, body })
//   stacks(org, name)                   [{ number, open, base, prs, openPrs }] every GitHub stack
//   stackTool()                         'ok' | 'missing' | 'old': is `gh stack link` there; never
//                                       throws for a non-zero exit, which is 'missing'
//   linkStack(org, name, { base, urls })  register open PRs, by URL, as one stack on `base`
//   prsOnto(org, name, base)            [{ number, branch, url }] the open PRs landing on `base`
//   pullsForCommit(org, name, sha)      every PR the commit belongs to
//   createIssue(repo, title, body)      the new issue's number
//   commentIssue(repo, number, body)
//   closeIssue(repo, number)
//   repoExists(spec)                    true or false; spec is owner/name
//   clone(spec, target)
//   createRepo(spec, { source, description })   private, pushed from `source`
// Every call but auth() throws GithubError when gh cannot be spawned, and every call but
// auth() and stackTool() when gh runs and exits non-zero, carrying gh's stderr. A lookup that gh could not answer —
// signed out, rate limited, offline — therefore throws, and never reads as "not found"
// (DESIGN.md decision 168). Not found is said only where gh says it: exit 0 with nothing
// (prForBranch, prTimeline, prsOnto, pullsForCommit), or HTTP 404 (repo, repoExists).
//
// createIssue, commentIssue and closeIssue are the tracker operations: what rig does to
// a ticket. bin/jira.mjs presents the same operations for Jira under its own names.
import { spawnSync } from 'node:child_process'
import { TrackerError } from './errors.mjs'
import { jsonCliHelpers, cliRunner } from './cli.mjs'
import { NO_PROMPT_ENV } from './remote-env.mjs'

export class GithubError extends TrackerError {}
const { fail, firstLine, parseJson } = jsonCliHelpers(GithubError)

// `min` of an empty list is null, which is what "never reviewed" should read as. A review
// still being written has no `submittedAt`, and must not count as the first look.
const PR_TIMELINE_JQ = [
  '{ firstCommitAt: ([.commits[].authoredDate] | min)',
  ', firstReviewAt: ([.reviews[] | select(.submittedAt != null) | .submittedAt] | min)',
  ', approvedAt: ([.reviews[] | select(.state == "APPROVED" and .submittedAt != null) | .submittedAt] | min) }',
].join('')

const STACKS_JQ = '.[] | {number, open, base: .base.ref, prs: [.pull_requests[].number], openPrs: [.pull_requests[] | select(.state == "open") | .number]}'

const spawnGh = (args, { env } = {}) => spawnSync('gh', args, { encoding: 'utf8', env: { ...process.env, ...env } })

export function githubViaGh ({ exec = spawnGh } = {}) {
  const { run: gh, must, refused } = cliRunner('gh', exec, fail)
  // `gh api`'s answer, or null when GitHub says it has no such thing. Only a 404 is "not
  // found": a 401, a rate limit or a network error is gh failing to ask, and throws.
  const unless404 = args => {
    const r = gh(args)
    if (r.code === 0) return r.out
    if (/\(HTTP 404\)/.test(r.err)) return null
    refused(args, r)
  }

  return {
    auth () {
      const r = exec(['auth', 'status'])
      if (r.error) return 'missing'
      return r.status === 0 ? 'ok' : 'unauthenticated'
    },
    repo (org, name) {
      const out = unless404(['api', `repos/${org}/${name}`, '--jq', '{name,language,visibility}'])
      if (!out) return null
      const { name: canonical, language, visibility } = parseJson(out, 'gh api')
      return { name: canonical, language: language || '', visibility: visibility || null }
    },
    // `baseRefName` is the base the PR lands on *now* — repoint a PR at another branch and
    // it changes, where the base a work recorded at `rig attach` never does. It rides along
    // with the PR state for no extra round trip, which is what makes a live base affordable
    // on every `list`, `status` and `close`. `headRefOid` rides along the same way: it is the
    // commit the PR carried, and the only thing that lets `close` tell a branch whose every
    // commit landed from one somebody pushed to after the merge. `mergeCommit` is the commit it
    // landed as, and the only way to tell a stage that was squashed from one that was merged.
    // `title` and `body` are what `rig next` and `rig pr --refresh` compare with what `rig pr`
    // would write now.
    prForBranch (org, name, branch) {
      const out = must(['pr', 'list', '--repo', `${org}/${name}`, '--head', branch,
        '--state', 'all', '--json', 'number,state,baseRefName,headRefOid,mergeCommit,url,createdAt,mergedAt,title,body,labels', '--limit', '1'])
      if (!out) return null
      const prs = parseJson(out, 'gh pr list')
      if (!Array.isArray(prs)) fail(`gh pr list returned something that is not a list: ${firstLine(out)}`)
      const [pr] = prs
      return pr ? { number: pr.number, state: pr.state, base: pr.baseRefName || null, head: pr.headRefOid || null, merge: pr.mergeCommit?.oid || null, url: pr.url, openedAt: pr.createdAt || null, mergedAt: pr.mergedAt || null, title: pr.title ?? null, body: pr.body ?? null, labels: (pr.labels || []).map(l => l.name) } : null
    },
    // Every label a repo has, by name. `rig pr` asks whether any is a `release:` label, which is
    // what says the repo releases the way rig does.
    labels (org, name) {
      const out = must(['api', `repos/${org}/${name}/labels`, '--paginate', '--jq', '.[].name'])
      return out.split('\n').map(l => l.trim()).filter(Boolean)
    },
    // The open pull requests that land on a branch — what is stacked on top of it. `rig
    // restore` follows these up from the highest branch a work records, to name the stack
    // somebody built on it without telling rig.
    prsOnto (org, name, base) {
      const out = must(['pr', 'list', '--repo', `${org}/${name}`, '--base', base,
        '--state', 'open', '--json', 'number,headRefName,url'])
      if (!out) return []
      const prs = parseJson(out, 'gh pr list')
      if (!Array.isArray(prs)) fail(`gh pr list returned something that is not a list: ${firstLine(out)}`)
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
      const out = must(['api', `repos/${org}/${name}/commits/${sha}/pulls`, '--jq',
        'map({number, title, url: .html_url, body, headRefName: .head.ref, baseRefName: .base.ref, labels: [.labels[].name]})'])
      if (!out) return []
      const pulls = parseJson(out, 'gh api commits/pulls')
      if (!Array.isArray(pulls)) fail(`gh api commits/pulls returned something that is not a list: ${firstLine(out)}`)
      return pulls
    },
    // The PR, not the branch, because a merged PR's branch is usually deleted — this is the
    // only place the first commit of finished work can still be read. Commits and reviews
    // come back in one call: a second round trip per repo is what makes a listing unusable.
    // `jq` reduces before parsing, because review bodies are the bulk of the answer and
    // nothing here wants them.
    prTimeline (org, name, number) {
      const out = must(['pr', 'view', String(number), '--repo', `${org}/${name}`,
        '--json', 'commits,reviews', '--jq', PR_TIMELINE_JQ])
      if (!out) return null
      const t = parseJson(out, 'gh pr view')
      return { firstCommitAt: t.firstCommitAt, firstReviewAt: t.firstReviewAt, approvedAt: t.approvedAt }
    },
    // `rig pr` opens a pull request once: it checks for an existing one first (idempotence is
    // the caller's, because "already open" is a thing to report rather than an error to raise).
    createPr (org, name, { branch, base, title, body }) {
      const out = must(['pr', 'create', '--repo', `${org}/${name}`,
        '--head', branch, '--base', base, '--title', title, '--body', body])
      const url = /(https:\/\/\S*\/pull\/\d+)\s*$/.exec(out)?.[1]
      if (!url) fail(`could not read the pull request URL from gh output:\n${out}`)
      return { number: Number(/\/pull\/(\d+)$/.exec(url)[1]), url }
    },
    // The one write rig makes to a pull request that is already open: `rig pr --refresh`
    // rewriting its title and body.
    editPr (org, name, number, { title, body }) {
      must(['pr', 'edit', String(number), '--repo', `${org}/${name}`, '--title', title, '--body', body])
    },
    // Every GitHub stack a repo has, open or merged, by the endpoint the gh-stack extension
    // itself reads. GitHub's REST reference does not list it, so an answer it will not give —
    // a 404 included — throws, and is unknown to the caller, never "no stacks".
    stacks (org, name) {
      const out = must(['api', `repos/${org}/${name}/stacks`, '--paginate', '--jq', STACKS_JQ])
      return out.split('\n').filter(l => l.trim()).map(l => {
        const s = parseJson(l, 'gh api stacks')
        return { number: s.number, open: s.open, base: s.base, prs: s.prs, openPrs: s.openPrs }
      })
    },
    // Is the gh-stack extension here, and new enough to `link`? Read off its help, because an
    // unknown `gh stack` subcommand prints that help and exits 0.
    stackTool () {
      const r = gh(['stack', '--help'])
      if (r.code !== 0) return 'missing'
      return /^\s+link\s/m.test(r.out) ? 'ok' : 'old'
    },
    // `gh stack link`, which registers pull requests that already exist as one stack and owns
    // no branch. Given URLs, never branch names: a branch name is pushed, and opened as a pull
    // request when it has none. `--base` always, since it defaults to the default branch. The
    // repo is named by `GH_REPO`, so nothing depends on where rig was run.
    linkStack (org, name, { base, urls }) {
      must(['stack', 'link', '--base', base, ...urls], { env: { GH_REPO: `${org}/${name}` } })
    },
    createIssue (repo, title, body) {
      const out = must(['issue', 'create', '--repo', repo, '--title', title, '--body', body])
      const n = /\/issues\/(\d+)\s*$/.exec(out)?.[1]
      // gh exited 0, so the issue exists whether or not its answer can be read, and a retry
      // makes a second one (DESIGN.md decision 171, the twin of 150).
      if (!n) {
        fail(`gh exited 0 but rig could not read the new issue's number from its answer, so the issue may have been created. ` +
          `Search ${repo} for "${title}" before retrying, ` +
          `then record it on this work with \`rig ticket ${repo}#<n> --work <id>\`.\ngh's answer:\n${out}`)
      }
      return Number(n)
    },
    commentIssue (repo, number, body) {
      must(['issue', 'comment', String(number), '--repo', repo, '--body', body])
    },
    closeIssue (repo, number) {
      must(['issue', 'close', String(number), '--repo', repo])
    },
    // Asked of `gh api`, as `repo` is, so a 404 is the one "does not exist".
    repoExists (spec) {
      return unless404(['api', `repos/${spec}`, '--jq', '.name']) !== null
    },
    clone (spec, target) {
      // Both go through git, which may never stop to ask for credentials (decision 138).
      must(['repo', 'clone', spec, target], { env: NO_PROMPT_ENV })
    },
    createRepo (spec, { source, description }) {
      must(['repo', 'create', spec, '--private', '--source', source, '--push', '--description', description], { env: NO_PROMPT_ENV })
    },
  }
}

// Canned GitHub for tests. `state` is mutated in place so the harness can persist and
// inspect it: { auth, repos: { 'owner/name': { language, visibility, labels, prs, issues, source } } }.
// A repo with no `visibility` is one GitHub would not say it for; one with no `labels`, or with
// `stacks: null`, is one gh could not list them for, so the lookup throws as the real one does.
// `auth` mirrors the real adapter: 'missing' fails every call; 'unauthenticated' fails every
// call but auth(), lookups included, as gh's non-zero exit does (DESIGN.md decision 168).
// One lookup can fail on its own, with gh's message: a repo's `lookupFails` fails every lookup
// on that repo, and its `branchLookupFails: { <branch>: <message> }` fails prForBranch for that
// branch only — "the work PR answered and one stage's did not".
// `env` is the run's, for the one call below that spawns anything: a clone made under the
// machine's real global config rather than the run's is how an isolated test starts
// answering for the machine it happens to be on.
export function githubInMemory (state, { env } = {}) {
  state.repos = state.repos || {}
  const lookup = spec => {
    const key = Object.keys(state.repos).find(k => k.toLowerCase() === spec.toLowerCase())
    return key ? { key, repo: state.repos[key] } : null
  }
  // Can gh run at all (missing), and is it signed in? Every call but auth() and stackTool()
  // asks first; a lookup also asks whether GitHub will answer for this repo and branch.
  const signedIn = () => {
    if (state.auth === 'missing') fail('gh not found on PATH (in-memory GitHub)')
    if (state.auth === 'unauthenticated') fail('gh is not authenticated (in-memory GitHub)')
  }
  const ask = (spec, branch) => {
    signedIn()
    const repo = lookup(spec)?.repo
    if (repo?.lookupFails) fail(repo.lookupFails)
    if (repo?.branchLookupFails?.[branch]) fail(repo.branchLookupFails[branch])
  }
  const issue = (spec, number) => {
    const found = lookup(spec)?.repo.issues?.find(i => i.number === Number(number))
    return found || fail(`${spec}#${number}: no such issue (in-memory GitHub)`)
  }

  return {
    auth: () => state.auth || 'ok',
    repo (org, name) {
      ask(`${org}/${name}`)
      const found = lookup(`${org}/${name}`)
      return found ? { name: found.key.split('/')[1], language: found.repo.language || '', visibility: found.repo.visibility || null } : null
    },
    prForBranch (org, name, branch) {
      ask(`${org}/${name}`, branch)
      // The newest PR on the branch, as `gh pr list --limit 1` answers — a closed PR
      // re-opened as a new one must show the open one to the close safety check.
      const pr = (lookup(`${org}/${name}`)?.repo.prs || [])
        .filter(p => p.branch === branch).sort((a, b) => b.number - a.number)[0]
      return pr ? { number: pr.number, state: pr.state, base: pr.base || null, head: pr.head || null, merge: pr.merge || null, url: pr.url, openedAt: pr.openedAt || null, mergedAt: pr.mergedAt || null, title: pr.title ?? null, body: pr.body ?? null, labels: pr.labels || [] } : null
    },
    labels (org, name) {
      ask(`${org}/${name}`)
      return lookup(`${org}/${name}`)?.repo.labels ?? fail(`gh api: ${org}/${name}: labels not listed (in-memory GitHub)`)
    },
    prsOnto (org, name, base) {
      ask(`${org}/${name}`)
      return (lookup(`${org}/${name}`)?.repo.prs || [])
        .filter(p => p.base === base && p.state === 'OPEN')
        .map(p => ({ number: p.number, branch: p.branch, url: p.url }))
    },
    // Every pull request whose `commits` list contains this sha, in the order the fixture
    // declares them — a commit in two of them answers with both, which is the case the real
    // adapter's `map(...)` exists for and the one a release has to get right.
    pullsForCommit (org, name, sha) {
      ask(`${org}/${name}`)
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
      ask(`${org}/${name}`)
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
      signedIn()
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
    editPr (org, name, number, { title, body }) {
      signedIn()
      const pr = (lookup(`${org}/${name}`)?.repo.prs || []).find(p => p.number === Number(number))
      if (!pr) fail(`${org}/${name}#${number}: no such pull request (in-memory GitHub)`)
      Object.assign(pr, { title, body })
    },
    stacks (org, name) {
      ask(`${org}/${name}`)
      const found = lookup(`${org}/${name}`)
      if (!found || found.repo.stacks === null) fail(`gh api: ${org}/${name}: stacks not listed (in-memory GitHub)`)
      const open = n => (found.repo.prs || []).some(p => p.number === n && p.state === 'OPEN')
      return (found.repo.stacks || []).map(s => ({ ...s, prs: [...s.prs], openPrs: s.prs.filter(open) }))
    },
    stackTool: () => state.ghStack || 'ok',
    // As `gh stack link` does: a stack holding any of the PRs grows by the rest, and otherwise
    // a new one is made. Stack numbers share the PRs' sequence, as they do on GitHub.
    // `linkFails` is gh stack's error, for a link that fails.
    linkStack (org, name, { base, urls }) {
      signedIn()
      if (state.linkFails) fail(state.linkFails)
      const found = lookup(`${org}/${name}`) || fail(`${org}/${name}: no such repo (in-memory GitHub)`)
      const numbers = urls.map(u => Number(/\/pull\/(\d+)$/.exec(u)?.[1] || fail(`${u}: not a pull request URL (in-memory GitHub)`)))
      found.repo.stacks = found.repo.stacks || []
      let stack = found.repo.stacks.find(s => s.open && s.prs.some(n => numbers.includes(n)))
      if (!stack) {
        const number = Math.max(0, ...(found.repo.prs || []).map(p => p.number), ...found.repo.stacks.map(s => s.number)) + 1
        stack = { number, open: true, base, prs: [] }
        found.repo.stacks.push(stack)
      }
      for (const n of numbers) if (!stack.prs.includes(n)) stack.prs.push(n)
    },
    createIssue (spec, title, body) {
      signedIn()
      const found = lookup(spec) || fail(`${spec}: no such repo (in-memory GitHub)`)
      found.repo.issues = found.repo.issues || []
      const number = Math.max(0, ...found.repo.issues.map(i => i.number)) + 1
      found.repo.issues.push({ number, title, body, state: 'OPEN', comments: [] })
      return number
    },
    commentIssue (spec, number, body) {
      signedIn()
      const found = issue(spec, number)
      found.comments = found.comments || []   // a hand-seeded fixture may omit it
      found.comments.push(body)
    },
    closeIssue (spec, number) {
      signedIn()
      issue(spec, number).state = 'CLOSED'
    },
    repoExists (spec) {
      ask(spec)
      return lookup(spec) !== null
    },
    clone (spec, target) {
      signedIn()
      // The one on-disk effect: a clone is a checkout, so it clones from the recorded source.
      const found = lookup(spec) || fail(`${spec}: no such repo (in-memory GitHub)`)
      const source = found.repo.source || fail(`${spec}: exists but has no \`source\` to clone from (in-memory GitHub)`)
      const r = spawnSync('git', ['clone', '-q', source, target], { encoding: 'utf8', ...(env ? { env } : {}) })
      if (r.error) fail(`git not found on PATH (${r.error.message})`)
      if (r.status !== 0) fail(`clone of ${spec}: ${(r.stderr || '').trim()}`)
    },
    createRepo (spec, { source }) {
      signedIn()
      if (lookup(spec)) fail(`${spec}: already exists (in-memory GitHub)`)
      state.repos[spec] = { language: '', prs: [], issues: [], source }
    },
  }
}
