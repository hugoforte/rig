// `rig pr`: one pull request per repo, work branch to the base it was cut from.
//
// Review is the phase rig was most obviously absent from: it has read PR state everywhere
// since it existed and had never opened one. Not a gate — a command you run when the stages
// are in.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall, slicedWork } from './billing-install.mjs'

const m = billingInstall('rig-pr-')
const { tmp, bare, dataRoot, rig, gitMust, github, setGithub, setVisibility, withVisibility, publish, worktree, cleanup } = m

after(cleanup)

// The two-stage work this file renders: the first slice landed, the second is up for review.
before(() => slicedWork(m))

test('pr refuses on a work with nothing attached, rather than succeeding at nothing', () => {
  assert.equal(rig(['new', 'to-review', '--title', 'Work to review', '--type', 'feat', '--no-ticket']).code, 0)
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /no repos attached/)
})

test('an unpushed branch is told to push rather than having a PR opened on nothing', () => {
  assert.equal(rig(['attach', 'billing', '--work', 'to-review']).code, 0)
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /is not on the remote yet — push it first/)
})

test('pr --help prints how pr is used and opens nothing', () => {
  const dest = worktree('to-review', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'reviewable\n')
  gitMust(dest, 'commit', '-qam', 'reviewable')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  const before = github().repos['acme/billing'].prs.length

  const r = rig(['pr', '--work', 'to-review', '--help'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /^ {2}rig pr {2,}open one PR per repo/)
  assert.equal(github().repos['acme/billing'].prs.length, before, 'no pull request opened')
})

test('pr opens one per repo, work branch to the base it was cut from', () => {
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: PR #\d+ → main/)

  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review')
  assert.ok(opened, 'it reached GitHub through the adapter, not by shelling out on its own')
  assert.equal(opened.base, 'main')
  assert.equal(opened.state, 'OPEN')
})

test('the body carries the title, the ticket line and the context doc, not a paraphrase', () => {
  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review')
  assert.match(opened.title, /Work to review/)
  assert.match(opened.body, /Context doc:/)
})

test('the Direction the design was agreed in is lifted verbatim, and the stub never is', () => {
  // The scaffolded `_TODO_` says nothing, and an empty section is worse than none.
  assert.doesNotMatch(github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/work-to-review').body,
    /## Direction/)

  // A second work, so the first is left as it is for the idempotence test below.
  assert.equal(rig(['new', 'reviewed-2', '--title', 'Second', '--type', 'feat', '--no-ticket']).code, 0)
  const doc = path.join(dataRoot, 'work', 'reviewed-2', 'context.md')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('_TODO_', 'Because the adjacent effort would have cost a third major.'))
  assert.equal(rig(['attach', 'billing', '--work', 'reviewed-2']).code, 0)
  const dest = worktree('reviewed-2', 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), 'second\n')
  gitMust(dest, 'commit', '-qam', 'second')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')

  const r = rig(['pr', '--work', 'reviewed-2'])
  assert.equal(r.code, 0, r.out)
  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/second')
  assert.match(opened.body, /## Direction\n\nBecause the adjacent effort would have cost a third major\./)
})

test('running it again reports the open PR instead of opening a second', () => {
  const before = github().repos['acme/billing'].prs.length
  const r = rig(['pr', '--work', 'to-review'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /is already open/)
  assert.equal(github().repos['acme/billing'].prs.length, before, 'idempotent, like every other command')
})

test('a PR state GitHub would not answer for opens nothing, rather than opening a duplicate', () => {
  const state = github()
  const before = state.repos['acme/billing'].prs.length
  setGithub({ ...state, auth: 'missing' })
  const r = rig(['pr', '--work', 'to-review'])
  assert.match(r.out, /GitHub would not say whether a PR exists/)
  assert.doesNotMatch(r.out, /PR #\d+ →/)
  setGithub(state)
  assert.equal(github().repos['acme/billing'].prs.length, before, 'and nothing was opened blind')
})

test('an unauthenticated gh is not opened over: GitHub would not say whether a PR exists', () => {
  // A lookup gh could not answer throws, so the refusal comes before any write is tried
  // (DESIGN.md decision 169), rather than resting on `createPr` refusing too.
  const state = github()
  const before = state.repos['acme/billing'].prs.length
  setGithub({ ...state, auth: 'unauthenticated' })
  const r = rig(['pr', '--work', 'to-review'])
  setGithub(state)
  assert.match(r.out, /billing: GitHub would not say whether a PR exists \(gh is not authenticated \(in-memory GitHub\)\) — not opening one/)
  assert.equal(github().repos['acme/billing'].prs.length, before)
})

test('the stage table in the body is rendered from the stack, never hand-typed', () => {
  const dest = worktree('sliced', 'billing')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  const r = rig(['pr', '--work', 'sliced'])
  assert.equal(r.code, 0, r.out)
  const opened = github().repos['acme/billing'].prs.find(pr => pr.branch === 'feat/sliced-work')
  assert.ok(opened, 'a PR was opened for the sliced work')
  assert.match(opened.body, /## Stages/)
  // The same renderer the rollout plan uses: two generators would be two tables that disagree.
  assert.match(opened.body, /\| 1 \| `feat\/sliced-one` \| the schema \| billing \| #10 \| landed \|/)
  assert.match(opened.body, /\| 2 \| `feat\/sliced-two` \| the endpoints \| billing \| #11 \| up for review \|/)
})

test('a worktree left on a stage that landed is told how to get back to the work branch (#200)', () => {
  // Every stage merged on GitHub and the stage branch was deleted there, and the worktree is
  // still where the last push left it: on the stage, with the work branch behind the remote's.
  assert.equal(rig(['new', 'landed', '--title', 'Landed work', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'landed']).code, 0)
  assert.equal(rig(['stage', 'feat/landed-one', '--delivers', 'the schema', '--work', 'landed']).code, 0)
  const dest = worktree('landed', 'billing')
  const work = 'feat/landed-work'
  gitMust(dest, 'push', '-q', 'origin', work)
  gitMust(dest, 'checkout', '-q', '-b', 'feat/landed-one')
  fs.appendFileSync(path.join(dest, 'README.md'), 'the schema\n')
  gitMust(dest, 'commit', '-qam', 'the schema')
  gitMust(dest, 'push', '-q', 'origin', `feat/landed-one:${work}`)
  const state = github()
  state.repos['acme/billing'].prs.push({ branch: 'feat/landed-one', number: 30, state: 'MERGED', url: 'https://github.com/acme/billing/pull/30', base: work, openedAt: '2026-09-19T00:00:00Z', mergedAt: '2026-09-19T12:00:00Z', commits: [] })
  setGithub(state)

  const r = rig(['pr', '--work', 'landed'])
  assert.equal(r.code, 0, r.out)
  const commands = [`git switch ${work}`, `git pull --ff-only origin ${work}`]
  assert.ok(r.out.includes(`billing: the worktree is still on feat/landed-one, a stage that has landed — \`${commands[0]}\`, then \`${commands[1]}\``), r.out)
  assert.ok(github().repos['acme/billing'].prs.some(pr => pr.branch === work), 'the PR is opened all the same')

  // And the commands it names do what they say.
  for (const command of commands) gitMust(dest, ...command.split(' ').slice(1))
  assert.equal(gitMust(dest, 'branch', '--show-current'), work)
  assert.match(fs.readFileSync(path.join(dest, 'README.md'), 'utf8'), /the schema/)
})

test('pr --refresh rewrites an open PR from the record as it stands now', () => {
  const doc = path.join(dataRoot, 'work', 'reviewed-2', 'context.md')
  fs.writeFileSync(doc, fs.readFileSync(doc, 'utf8').replace('Because the adjacent effort would have cost a third major.', 'Because a trial run showed the cheaper path.'))
  assert.equal(rig(['ticket', 'acme/billing#12', '--work', 'reviewed-2']).code, 0)
  assert.equal(rig(['save', '--title', 'Second, as it turned out', '--work', 'reviewed-2']).code, 0)

  const r = rig(['pr', '--refresh', '--work', 'reviewed-2'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: PR #\d+ refreshed from the record/)
  const pr = github().repos['acme/billing'].prs.find(p => p.branch === 'feat/second')
  assert.equal(pr.title, 'Second, as it turned out')
  assert.match(pr.body, /^Second, as it turned out\n\nFixes acme\/billing#12\n\n## Direction\n\nBecause a trial run showed the cheaper path\.\n/)
})

test('pr --refresh again finds nothing to change, and edits nothing', () => {
  const before = github().repos['acme/billing'].prs.find(p => p.branch === 'feat/second')
  const r = rig(['pr', '--refresh', '--work', 'reviewed-2'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: PR #\d+ is already up to date/)
  assert.deepEqual(github().repos['acme/billing'].prs.find(p => p.branch === 'feat/second'), before)
})

test('a body GitHub hands back with CRLF line ends and a trailing newline still counts as up to date', () => {
  const state = github()
  const pr = state.repos['acme/billing'].prs.find(p => p.branch === 'feat/second')
  pr.body = `${pr.body.replace(/\n/g, '\r\n')}\r\n`
  setGithub(state)
  const r = rig(['pr', '--refresh', '--work', 'reviewed-2'])
  assert.match(r.out, /billing: PR #\d+ is already up to date/)
})

test('list --json leaves out the PR title, body and labels that pr reads', () => {
  const listed = JSON.parse(rig(['list', '--json']).out)
  const repo = listed.works.find(w => w.id === 'reviewed-2').repos[0]
  assert.ok(repo.pr.number, 'the PR itself is listed')
  assert.deepEqual([repo.pr.title, repo.pr.body, repo.pr.labels], [undefined, undefined, undefined])
})

test('a stage GitHub will not answer for stops the refresh, rather than writing "PR state unknown" into the PR', () => {
  const state = github()
  setGithub({ ...state, auth: 'missing' })
  const r = rig(['pr', '--refresh', '--work', 'sliced'])
  setGithub(state)
  assert.match(r.out, /would not say what became of feat\/sliced-one, feat\/sliced-two — nothing refreshed/)
})

test('an unauthenticated gh is not reported as having no open PR, and nothing is refreshed', () => {
  const state = github()
  setGithub({ ...state, auth: 'unauthenticated' })
  const r = rig(['pr', '--refresh', '--work', 'reviewed-2'])
  setGithub(state)
  assert.match(r.out, /billing: GitHub would not say whether a PR is open \(gh is not authenticated \(in-memory GitHub\)\) — nothing refreshed/)
  assert.doesNotMatch(r.out, /no open PR/)
})

test('dropping a stage changes the stage table, so the open PR is offered a refresh that says so', () => {
  assert.equal(rig(['stage', 'feat/sliced-three', '--delivers', 'the UI', '--work', 'sliced']).code, 0)
  assert.equal(rig(['pr', '--refresh', '--work', 'sliced']).code, 0)
  assert.equal(rig(['stage', 'feat/sliced-three', '--dropped', 'the UI moved to its own work', '--work', 'sliced']).code, 0)
  assert.match(rig(['next', '--work', 'sliced']).out, /rig pr --refresh/)
  assert.equal(rig(['pr', '--refresh', '--work', 'sliced']).code, 0)
  const body = github().repos['acme/billing'].prs.find(p => p.branch === 'feat/sliced-work').body
  assert.match(body, /\| `feat\/sliced-three` \| the UI \| — \| — \| dropped: the UI moved to its own work \|/)
})

test('pr --refresh with no open PR says so and opens nothing', () => {
  assert.equal(rig(['new', 'unopened', '--title', 'Not up yet', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'unopened']).code, 0)
  const before = github().repos['acme/billing'].prs.length
  const r = rig(['pr', '--refresh', '--work', 'unopened'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: no open PR — nothing to refresh/)
  assert.equal(github().repos['acme/billing'].prs.length, before)
})

test('rig next offers the refresh while an open PR says something the record no longer does', () => {
  assert.equal(rig(['ticket', 'acme/billing#13', '--work', 'reviewed-2']).code, 0)
  assert.match(rig(['next', '--work', 'reviewed-2']).out, /rig pr --refresh/)
  assert.equal(rig(['pr', '--refresh', '--work', 'reviewed-2']).code, 0)
  assert.doesNotMatch(rig(['next', '--work', 'reviewed-2']).out, /rig pr --refresh/)
})

test('rig next offers no refresh of a stale PR while one stage\'s lookup fails', () => {
  // The work PR answered and one stage's lookup did not: the stage table the refresh would
  // write says "PR state unknown" for it, so the PR is no evidence of being stale (decision 171).
  const state = github()
  const stale = structuredClone(state)
  stale.repos['acme/billing'].prs.find(p => p.branch === 'feat/sliced-work').body = 'a body the record no longer says'
  setGithub(stale)
  const answered = rig(['next', '--work', 'sliced']).out
  stale.repos['acme/billing'].branchLookupFails = { 'feat/sliced-two': 'HTTP 502: Bad Gateway' }
  setGithub(stale)
  const refused = rig(['next', '--work', 'sliced']).out
  setGithub(state)
  assert.match(answered, /rig pr --refresh/, 'the stale PR is offered a refresh while every lookup answers')
  assert.doesNotMatch(refused, /rig pr --refresh/)
})

test('a withdrawn stage GitHub would not answer for does not stop the refresh, since nothing of it is asked', () => {
  // A dropped stage renders as dropped whatever GitHub says, so its unknown PR state changes
  // nothing the refresh would write (decisions 171 and 173 agree on this).
  const state = github()
  const failing = structuredClone(state)
  failing.repos['acme/billing'].branchLookupFails = { 'feat/sliced-three': 'HTTP 502: Bad Gateway' }
  setGithub(failing)
  const r = rig(['pr', '--refresh', '--work', 'sliced'])
  setGithub(state)
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /would not say what became of/)
})

// A work with one repo, one commit pushed and whatever `extra` commands it names, so the PR
// `rig pr` opens for it says only what the test is about.
const pushedWork = (id, title, ...extra) => {
  assert.equal(rig(['new', id, '--title', title, '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', id]).code, 0)
  for (const args of extra) assert.equal(rig([...args, '--work', id]).code, 0)
  const dest = worktree(id, 'billing')
  fs.appendFileSync(path.join(dest, 'README.md'), `${id}\n`)
  gitMust(dest, 'commit', '-qam', id)
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
}
const bodyOf = branch => github().repos['acme/billing'].prs.find(pr => pr.branch === branch).body

test('a stage GitHub would not answer for stops a PR being opened, rather than publishing a stage table that guessed', () => {
  // GitHub keeps a body's edit history, so a stage table that guessed cannot be taken back
  // (decision 171).
  pushedWork('unasked-stage', 'Unasked stage', ['stage', 'feat/unasked-stage-one', '--delivers', 'the slice'])
  const state = github()
  const before = state.repos['acme/billing'].prs.length
  const failing = structuredClone(state)
  failing.repos['acme/billing'].branchLookupFails = { 'feat/unasked-stage-one': 'HTTP 502: Bad Gateway' }
  setGithub(failing)
  const r = rig(['pr', '--work', 'unasked-stage'])
  setGithub(state)
  assert.match(r.out, /GitHub would not say what became of feat\/unasked-stage-one — not opening a PR/)
  assert.doesNotMatch(r.out, /fetching|base moved|conflicts with/, 'a refusal costs no fetch and says nothing about the base')
  assert.equal(github().repos['acme/billing'].prs.length, before)
})

// The data root's remote, for the length of `fn`. Only `rig pr` and `rig next` run inside it,
// and neither fetches or pushes the data root, so the URL is never dialled.
const withDataRemote = (url, fn) => {
  gitMust(dataRoot, 'remote', 'add', 'origin', url)
  try { return fn() } finally { gitMust(dataRoot, 'remote', 'remove', 'origin') }
}
const refresh = id => {
  const r = rig(['pr', '--refresh', '--work', id])
  assert.equal(r.code, 0, r.out)
  return r
}
const LINK = /\nContext doc: /
const LEFT_OUT = /context-doc link left out: GitHub would not say whether acme\/billing is more visible than the data root/g

test('a PR on a public repo never carries the link to a private data root (#202)', () => {
  // This data root has no remote, which counts as private: nothing more visible may name it.
  pushedWork('public-pr', 'Public PR')
  withVisibility('acme/billing', 'public', () => {
    const r = rig(['pr', '--work', 'public-pr'])
    assert.equal(r.code, 0, r.out)
    assert.doesNotMatch(bodyOf('feat/public-pr'), /Context doc|context\.md/)
  })
})

test('a data root GitHub does not host is never linked, since nothing says who reads it (#202)', () => {
  withDataRemote('https://gitlab.example/acme/rig-data.git', () => {
    const r = refresh('public-pr')
    assert.doesNotMatch(bodyOf('feat/public-pr'), LINK)
    assert.doesNotMatch(r.out, LEFT_OUT, 'a fixed answer, not a lookup that failed')
  })
})

test('a data root as public as the repo is linked all the same, however its remote is spelled (#202)', () => {
  withDataRemote('ssh://git@github.com/acme/rig-data.git', () =>
    withVisibility('acme/rig-data', 'public', () => withVisibility('acme/billing', 'public', () => {
      refresh('public-pr')
      assert.match(bodyOf('feat/public-pr'), /\nContext doc: https:\/\/github\.com\/acme\/rig-data\/blob\/main\/work\/public-pr\/context\.md$/)
    })))
})

test('a data root remote with credentials in it, or spelled scp-style, links cleanly (#202)', () => {
  for (const remote of ['https://x-access-token:SECRET@github.com/acme/rig-data.git', 'git@github.com:acme/rig-data.git']) {
    withDataRemote(remote, () =>
      withVisibility('acme/rig-data', 'public', () => withVisibility('acme/billing', 'public', () => {
        refresh('public-pr')
        const body = bodyOf('feat/public-pr')
        assert.match(body, /\nContext doc: https:\/\/github\.com\/acme\/rig-data\/blob\/main\/work\/public-pr\/context\.md$/, remote)
        assert.doesNotMatch(body, /@|SECRET/, remote)
      })))
  }
})

test('a visibility GitHub will not say is no evidence an open PR is stale (#202)', () => {
  // The open PR carries the public data root's link, which the record, with no remote now,
  // would not write; but a lookup that failed cannot say which of the two is right.
  withVisibility('acme/billing', undefined, () => {
    assert.doesNotMatch(rig(['next', '--work', 'public-pr']).out, /rig pr --refresh/)
  })
})

test('and a PR written without knowing it leaves the link out, saying so once (#202)', () => {
  withVisibility('acme/billing', undefined, () => {
    const r = refresh('public-pr')
    assert.doesNotMatch(bodyOf('feat/public-pr'), LINK)
    assert.equal(r.out.match(LEFT_OUT)?.length, 1, r.out)
  })
})

test('an internal repo is linked from a public data root, and not from a private one (#202)', () => {
  withDataRemote('https://github.com/acme/rig-data.git', () => withVisibility('acme/billing', 'internal', () => {
    withVisibility('acme/rig-data', 'public', () => refresh('public-pr'))
    assert.match(bodyOf('feat/public-pr'), LINK)
    withVisibility('acme/rig-data', 'private', () => refresh('public-pr'))
    assert.doesNotMatch(bodyOf('feat/public-pr'), LINK)
  }))
})

test('a data root GitHub will not say for leaves the link out as well, and says it was the data root (#202)', () => {
  withDataRemote('https://github.com/acme/rig-data.git', () => {
    withVisibility('acme/rig-data', 'private', () => refresh('public-pr'))
    assert.match(bodyOf('feat/public-pr'), LINK)
    const r = withVisibility('acme/rig-data', undefined, () => refresh('public-pr'))
    assert.doesNotMatch(bodyOf('feat/public-pr'), LINK)
    assert.match(r.out, /context-doc link left out: GitHub would not say how visible the data root is/)
    assert.doesNotMatch(r.out, LEFT_OUT, 'acme/billing answered, so it is not the one named')
  })
})

test('a single-repo work\'s PR closes its own tickets, and only names one in another repo (#202)', () => {
  pushedWork('fixing', 'Fixing work', ['ticket', 'acme/billing#40'], ['ticket', 'acme/other#41'])
  assert.equal(rig(['pr', '--work', 'fixing']).code, 0)
  assert.match(bodyOf('feat/fixing-work'), /^Fixing work\n\nFixes acme\/billing#40\nTickets: acme\/other#41\n/)
})

test('a stage\'s own key is left to rig close, since the stage merges where no keyword fires (#202)', () => {
  pushedWork('stage-key', 'Stage key', ['stage', 'feat/stage-key-one', '--delivers', 'the part', '--key', 'acme/billing#44'])
  assert.equal(rig(['pr', '--work', 'stage-key']).code, 0)
  assert.doesNotMatch(bodyOf('feat/stage-key'), /Fixes/)
})

test('a work ticket whose slice was withdrawn is named, never closed by the merge (#202)', () => {
  pushedWork('withdrawn-fix', 'Withdrawn fix', ['ticket', 'acme/billing#43'],
    ['stage', 'feat/withdrawn-fix-one', '--delivers', 'the part', '--key', 'acme/billing#43'],
    ['stage', 'feat/withdrawn-fix-one', '--dropped', 'not needed'])
  assert.equal(rig(['pr', '--work', 'withdrawn-fix']).code, 0)
  const body = bodyOf('feat/withdrawn-fix')
  assert.match(body, /\nTickets: acme\/billing#43\n/)
  assert.doesNotMatch(body, /Fixes/)
})

test('no ticket is closed by the merge while a declared slice has not landed (#202)', () => {
  pushedWork('unlanded', 'Unlanded', ['ticket', 'acme/billing#50'],
    ['stage', 'feat/unlanded-two', '--delivers', 'the rest'])
  assert.equal(rig(['pr', '--work', 'unlanded']).code, 0)
  const body = bodyOf('feat/unlanded')
  assert.match(body, /\nTickets: acme\/billing#50\n/)
  assert.doesNotMatch(body, /Fixes/)
})

test('and once the slice lands, the refresh writes the Fixes the merge can now honour (#202)', () => {
  const state = github()
  state.repos['acme/billing'].prs.push({ branch: 'feat/unlanded-two', number: 90, state: 'MERGED', base: 'feat/unlanded', url: 'https://github.com/acme/billing/pull/90', openedAt: '2026-09-19T00:00:00Z', mergedAt: '2026-09-19T12:00:00Z', commits: [] })
  setGithub(state)
  assert.match(rig(['next', '--work', 'unlanded']).out, /rig pr --refresh/)
  assert.equal(rig(['pr', '--refresh', '--work', 'unlanded']).code, 0)
  assert.match(bodyOf('feat/unlanded'), /\nFixes acme\/billing#50\n/)
})

test('in a work of two repos no one PR closes a ticket, because its merge is not the landing (#202)', () => {
  publish('orders')
  setVisibility('acme/orders', 'private')
  pushedWork('two-repo', 'Two repos', ['ticket', 'acme/billing#42'], ['attach', 'orders'])
  const dest = worktree('two-repo', 'orders')
  fs.appendFileSync(path.join(dest, 'README.md'), 'orders\n')
  gitMust(dest, 'commit', '-qam', 'orders')
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  assert.equal(rig(['pr', '--work', 'two-repo']).code, 0)
  const body = bodyOf('feat/two-repos')
  assert.match(body, /\nTickets: acme\/billing#42\n/)
  assert.doesNotMatch(body, /Fixes/)
})

// A repo's labels on GitHub, and a PR's: the two things that say which release a PR asks for.
const labelRepo = labels => {
  const state = github()
  state.repos['acme/billing'].labels = labels
  setGithub(state)
}
const labelPr = (branch, labels) => {
  const state = github()
  state.repos['acme/billing'].prs.find(pr => pr.branch === branch).labels = labels
  setGithub(state)
}
const RELEASES = ['bug', 'release:minor', 'release:patch', 'release:none']

test('on a repo that releases by release: labels, rig pr says which release the PR asks for (#228)', () => {
  labelRepo(RELEASES)
  pushedWork('bumped', 'Bumped')
  const r = rig(['pr', '--work', 'bumped'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: this PR asks for a minor release \(the branch prefix `feat\/`\)/)
})

test('and says it again of the PR it finds open, where a label outranks the prefix (#228)', () => {
  labelPr('feat/bumped', ['release:patch'])
  const r = rig(['pr', '--work', 'bumped'])
  assert.match(r.out, /already open/)
  assert.match(r.out, /billing: this PR asks for a patch release \(the `release:patch` label\)/)
})

test('a repo with no release: labels is told nothing about a release, since it releases some other way (#228)', () => {
  labelRepo(['bug'])
  try {
    assert.doesNotMatch(rig(['pr', '--work', 'bumped']).out, /asks for/)
  } finally {
    labelRepo(RELEASES)
  }
})

test('labels GitHub will not list say nothing about a release, in rig pr or rig next (#228)', () => {
  labelRepo(undefined)
  try {
    assert.doesNotMatch(rig(['pr', '--work', 'bumped']).out, /asks for/)
    pushedWork('unlisted', 'Unlisted')
    const next = rig(['next', '--work', 'unlisted']).out
    assert.match(next, /pushed with no PR open/)
    assert.doesNotMatch(next, /would ask for/)
  } finally {
    labelRepo(RELEASES)
  }
})

test('rig next says which release beside its offer to open the PR (#228)', () => {
  pushedWork('bump-next', 'Bump next')
  assert.match(rig(['next', '--work', 'bump-next']).out, /billing is pushed with no PR open — its PR would ask for a minor release \(the branch prefix `feat\/`\)/)
})

test('a PR labelled release:none is said to ask for no release (#228)', () => {
  labelPr('feat/bumped', ['release:none'])
  assert.match(rig(['pr', '--work', 'bumped']).out, /billing: this PR asks for no release \(the `release:none` label\)/)
})

// Another PR merging into billing's main after the work branch was cut: one commit, from a
// clone of its own, appending `line` to `file`.
let landedElsewhere = 0
const landOnMain = (file, line) => {
  const clone = path.join(tmp, `elsewhere-${++landedElsewhere}`)
  gitMust(tmp, 'clone', '-q', bare('billing'), clone)
  fs.appendFileSync(path.join(clone, file), `${line}\n`)
  gitMust(clone, 'add', '-A')
  gitMust(clone, 'commit', '-qm', `elsewhere: ${line}`)
  gitMust(clone, 'push', '-q', 'origin', 'HEAD:main')
}

test('rig pr says how far the base has moved past the branch, and opens the PR (#208)', () => {
  pushedWork('moved-base', 'Moved base')
  landOnMain('OTHER.md', 'another PR')
  const r = rig(['pr', '--work', 'moved-base'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: base moved — main has 1 commit this branch does not/)
  assert.doesNotMatch(r.out, /conflicts/)
  assert.ok(github().repos['acme/billing'].prs.some(pr => pr.branch === 'feat/moved-base'), 'reported, never refused')
})

test('rig pr names the files a branch conflicts with its base in, and how to merge, then opens the PR (#208)', () => {
  pushedWork('conflicted', 'Conflicted')
  landOnMain('README.md', 'the same line, written elsewhere')
  const r = rig(['pr', '--work', 'conflicted'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: feat\/conflicted conflicts with main in README\.md — `git merge origin\/main` in the worktree, then push/)
  assert.ok(github().repos['acme/billing'].prs.some(pr => pr.branch === 'feat/conflicted'), 'reported, never refused')
})

test('a PR already open is not asked about the base again, since GitHub shows its own (#208)', () => {
  landOnMain('OTHER.md', 'yet another PR')
  const r = rig(['pr', '--work', 'moved-base'])
  assert.match(r.out, /is already open/)
  assert.doesNotMatch(r.out, /fetching|base moved/)
})

test('a merge git refuses to try is said, never read as a clean one (#208)', () => {
  assert.equal(rig(['new', 'orphaned', '--title', 'Orphaned', '--type', 'feat', '--no-ticket']).code, 0)
  assert.equal(rig(['attach', 'billing', '--work', 'orphaned']).code, 0)
  const dest = worktree('orphaned', 'billing')
  // A branch that shares no history with main: git will not merge unrelated histories.
  const orphan = gitMust(dest, 'commit-tree', 'HEAD^{tree}', '-m', 'unrelated')
  gitMust(dest, 'reset', '-q', '--hard', orphan)
  gitMust(dest, 'push', '-q', '-u', 'origin', 'HEAD')
  const r = rig(['pr', '--work', 'orphaned'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /billing: could not test-merge feat\/orphaned with main: .*unrelated histories/)
  assert.ok(github().repos['acme/billing'].prs.some(pr => pr.branch === 'feat/orphaned'), 'reported, never refused')
})

test('a branch the base has not moved past is told nothing about it (#208)', () => {
  pushedWork('level', 'Level')
  const r = rig(['pr', '--work', 'level'])
  assert.equal(r.code, 0, r.out)
  assert.doesNotMatch(r.out, /base moved|conflicts/)
})
