// Journeys: one machine, walked through a sequence of states, with nothing restored between
// the steps.
//
// Every other CLI suite starts from a machine that has nothing and asserts one
// command. The bugs this file exists for are in the *second* command against a machine that
// already had state — an existing root, an existing `current`, an existing legacy pointer —
// and none of them is in resolution, which is where the fast tests are. Resolution order
// stays in test/dataroots.test.mjs, asserted against `bin/roots.mjs` in milliseconds; what is
// here is what only a sequence can show.
//
// These are slow, so there are three of them and each one earns its seconds. Fixture names
// carry an `e2e-` prefix because the suite shares a machine's worth of names across branches.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { scenario, step, previousRelease, previousReleaseTag, releaseTags, readJson, strip } from './harness.mjs'
import { dataAnchorFile, DEFAULT_ROOT_NAME } from '../bin/roots.mjs'

const ORG = 'e2e-acme'
const machineFile = m => readJson(m.localConfig)
// Paths in the machine file are resolved against its own directory and may be relative, and
// Windows hands out both short and long forms of the same directory.
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase()

// A bare repo standing in for `https://github.com/<ORG>/<repo>.git`, with one commit on main.
const publish = ({ tmp, remotesDir, gitMust }, repo) => {
  const seed = path.join(tmp, 'seed', repo)
  fs.mkdirSync(seed, { recursive: true })
  gitMust(seed, 'init', '-q', '-b', 'main')
  fs.writeFileSync(path.join(seed, 'README.md'), `# ${repo}\n`)
  gitMust(seed, 'add', '-A')
  gitMust(seed, 'commit', '-q', '-m', `${repo}: first`)
  const bare = path.join(remotesDir, ORG, `${repo}.git`)
  fs.mkdirSync(path.dirname(bare), { recursive: true })
  gitMust(tmp, 'clone', '-q', '--bare', seed, bare)
}

// ------------------------------------------------------------- one root becomes three

// The path a machine actually takes to more than one data root: it has one already, names it,
// and adds the others afterwards. Two of these steps are bugs that shipped — naming the root
// you already have set `current` to a name it never created, and `--data-repo --name`, the
// README's own recipe for the second root, refused outright — and both are invisible to a test
// that asserts a single `init` against a machine with nothing.
scenario('one root becomes three', {
  // A journey about records and machine files, so it is walked in this process.
  inProcess: true,
  prefix: 'e2e-roots-',
  localConfig: true,
  // No repos seeded: the data repo `--data-repo` names does not exist, so init takes the
  // create path, which is the one that has to place the directory.
  github: { auth: 'ok', repos: {} },
}, [
  step('the first data root is set up without a name of its own', m => {
    const r = m.rig(['init', '--data-root', m.dataRoot, '--work-root', m.workRoot,
      '--orgs', ORG, '--tracker', `${ORG}=none`, '--email', 'hugo@e2e.invalid'])
    assert.equal(r.code, 0, r.out)
    const machine = machineFile(m)
    assert.deepEqual(Object.keys(machine.dataRoots), [DEFAULT_ROOT_NAME], 'a registry of one')
    assert.equal(machine.current, DEFAULT_ROOT_NAME)
    assert.ok(samePath(machine.dataRoot, m.dataRoot), 'and the key a rig from before named roots reads')
  }),

  step('naming the root you already have renames it, and the next command still runs', m => {
    // The rename used to fire only when the *path* changed, so naming the one root a machine
    // had left `current` pointing at a name with no entry — and every command after it died on
    // resolution. Asserting the file is half of that; the other half is that anything still
    // works, which only a second command can say.
    assert.equal(m.rig(['init', '--data-root', m.dataRoot, '--name', 'e2e-first']).code, 0)
    const machine = machineFile(m)
    assert.deepEqual(Object.keys(machine.dataRoots), ['e2e-first'], 'renamed, not added beside default')
    assert.equal(machine.current, 'e2e-first')

    const listed = m.rig(['use'])
    assert.equal(listed.code, 0, listed.out)
    assert.match(listed.out, /e2e-first/)
    assert.equal(m.rig(['list', '--quick']).code, 0, 'and a command that resolves a root answers')
  }),

  step('a second root arrives by --data-repo --name, in a directory of its own', m => {
    // Every data repo is called `rig-data` by convention, so the repo's name cannot place the
    // second one. It used to derive the directory from the repo, land both roots on top of each
    // other, and then die on the guard against switching roots by accident.
    const r = m.rig(['init', '--data-repo', `${ORG}/rig-data`, '--name', 'e2e-second',
      '--orgs', ORG, '--tracker', `${ORG}=none`])
    assert.equal(r.code, 0, r.out)
    const machine = machineFile(m)
    assert.deepEqual(Object.keys(machine.dataRoots).sort(), ['e2e-first', 'e2e-second'])
    assert.ok(!samePath(machine.dataRoots['e2e-second'].path, m.dataRoot), 'not on top of the first')
    assert.match(machine.dataRoots['e2e-second'].path, /rig-data-e2e-second$/, 'named for the root, not the repo')
    assert.equal(machine.current, 'e2e-second', 'the root just set up is the one in hand')
    assert.ok(readJson(m.githubStateFile).repos[`${ORG}/rig-data`], 'and the repo was created, not reached for')
  }),

  step('a third arrives by --data-root --name, and the legacy pointer follows current', m => {
    const third = path.join(m.tmp, 'rig-data-e2e-third')
    const r = m.rig(['init', '--data-root', third, '--name', 'e2e-third',
      '--orgs', ORG, '--tracker', `${ORG}=none`])
    assert.equal(r.code, 0, r.out)
    const machine = machineFile(m)
    assert.deepEqual(Object.keys(machine.dataRoots).sort(), ['e2e-first', 'e2e-second', 'e2e-third'])
    assert.ok(samePath(machine.dataRoot, third), 'the one-root key tracks whichever root is current')
  }),

  step('rig use lists all three and switches between them', m => {
    const listed = m.rig(['use'])
    assert.equal(listed.code, 0, listed.out)
    for (const name of ['e2e-first', 'e2e-second', 'e2e-third']) assert.match(listed.out, new RegExp(name))
    assert.match(listed.out, /\* e2e-third/, 'the one in hand is marked')

    const moved = m.rig(['use', 'e2e-first'])
    assert.equal(moved.code, 0, moved.out)
    assert.match(moved.out, /was e2e-third/)
    assert.ok(samePath(machineFile(m).dataRoot, m.dataRoot), 'and the legacy pointer came with it')
  }),

  step('each root holds its own works, and the work folder says which root holds its record', m => {
    assert.equal(m.rig(['new', 'e2e-first-work', '--title', 'In the first root', '--no-ticket']).code, 0)
    assert.equal(m.rig(['new', 'e2e-second-work', '--title', 'In the second root', '--no-ticket',
      '--data', 'e2e-second']).code, 0)

    const here = m.rig(['list', '--quick'])
    assert.match(here.stdout, /e2e-first-work/)
    assert.doesNotMatch(here.stdout, /e2e-second-work/, 'the other root is not consulted')
    const there = m.rig(['list', '--quick', '--data', 'e2e-second'])
    assert.match(there.stdout, /e2e-second-work/)
    assert.doesNotMatch(there.stdout, /e2e-first-work/)

    const folder = path.join(m.workRoot, 'e2e-second-work')
    assert.equal(fs.readFileSync(dataAnchorFile(folder), 'utf8').trim(), 'e2e-second')
    const inside = m.rig(['status'], { cwd: folder })
    assert.equal(inside.code, 0, inside.out)
    assert.match(inside.out, /e2e-second-work/, 'the anchor answered, and `current` — e2e-first — was never asked')
  }),
])

// -------------------------------------- the previous release, against a file this one wrote

// The upgrade window. Between the `init` that writes the new shape and the `rig update` that
// brings the installed copy forward, the rig on PATH is the previous release reading a machine
// file this one wrote — and it once read it as an installation that had never been set up,
// because `init` had deleted the only key it knows. That window opens on every machine at
// every release, and nothing could express it: the suite could fabricate a *newer* rig
// (test/installation.test.mjs) and never an older one.
const PREVIOUS = previousReleaseTag()

// The last release that had never heard of named roots, and so the last one that reads
// `dataRoot` and nothing else. It is pinned rather than derived because what it holds down is
// a **compatibility key**, not a moving property: `dataRoot` is written for rigs at or below
// this tag and for nothing else, so when the key is deliberately dropped this step is
// deliberately dropped with it. The previous release below covers the window that is open
// now; this covers the one where the bug happened.
const BEFORE_NAMED_ROOTS = 'v3.4.0'

const noTagFor = wanted => `${wanted} is not in this checkout — a shallow clone carries no tags`

scenario('the previous release, against a machine file this one wrote', {
  // The steps that drive *this* rig run here; the ones that name `root: PREVIOUS.root` are
  // about a different tool on disk, and `rig()` spawns those whatever this says.
  inProcess: true,
  prefix: 'e2e-window-',
  localConfig: true,
  github: { auth: 'ok', repos: {} },
  skip: !PREVIOUS ? noTagFor('a release tag')
    : !releaseTags().includes(BEFORE_NAMED_ROOTS) ? noTagFor(BEFORE_NAMED_ROOTS) : false,
}, [
  step('this rig sets up two named data roots', m => {
    assert.equal(m.rig(['init', '--data-root', m.dataRoot, '--work-root', m.workRoot,
      '--orgs', ORG, '--tracker', `${ORG}=none`, '--email', 'hugo@e2e.invalid',
      '--name', 'e2e-first']).code, 0)
    assert.equal(m.rig(['init', '--data-root', path.join(m.tmp, 'rig-data-e2e-second'),
      '--orgs', ORG, '--tracker', `${ORG}=none`, '--name', 'e2e-second']).code, 0)
    assert.equal(m.rig(['use', 'e2e-first']).code, 0)
  }),

  step('the release before this one still finds the installation set up', m => {
    m.previous = previousRelease(m, PREVIOUS)
    const r = m.rig(['doctor'], { root: m.previous.root })
    assert.doesNotMatch(strip(r.out), /not set up/,
      `rig ${m.previous.version} reads this rig's machine file as an installation that was never set up`)
    assert.match(strip(r.out), /data root/, 'and it found a data root to report on')
  }),

  step('and reads the work records this rig writes', m => {
    assert.equal(m.rig(['new', 'e2e-window-work', '--title', 'Written by the new rig', '--no-ticket']).code, 0)
    const r = m.rig(['list', '--quick'], { root: m.previous.root })
    assert.equal(r.code, 0, r.out)
    assert.match(r.stdout, /e2e-window-work/, 'a record this rig wrote, read by the one still on PATH')
  }),

  step('and so does the last release that only ever knew one data root', m => {
    // The bug, in the shape it shipped in: `init` named the roots and deleted `dataRoot`, and
    // the rig on PATH — which could read no other key — reported the installation as never set
    // up. Delete the legacy pointer from the file below and this step says exactly that.
    const before = previousRelease(m, BEFORE_NAMED_ROOTS)
    const r = m.rig(['doctor'], { root: before.root })
    assert.doesNotMatch(strip(r.out), /not set up/,
      `rig ${before.version} reads no key but \`dataRoot\`, and this rig has to keep writing one`)
    const machine = readJson(m.localConfig)
    assert.ok(samePath(machine.dataRoot, machine.dataRoots[machine.current].path),
      'pointed at whichever root is current, so the two rigs are working on the same knowledge')
  }),

  step('a work the previous release records is one this rig reads', m => {
    // The other half of the window: the rig on PATH goes on being used while the update waits,
    // so what it writes has to come back. Run in the work root, because the previous release
    // resolves the same way this one does and `current` is where both of them look.
    const r = m.rig(['new', 'e2e-window-old', '--title', 'Written by the old rig', '--no-ticket'],
      { root: m.previous.root })
    assert.equal(r.code, 0, r.out)
    const here = m.rig(['status'], { cwd: path.join(m.workRoot, 'e2e-window-old') })
    assert.equal(here.code, 0, here.out)
    assert.match(here.out, /e2e-window-old/)
  }),
])

// ----------------------------------------------------------------- splitting a data root

// What hugoforte/rig#77 did to a real data root: a second root joins the installation and some
// of the first one's knowledge moves into it. Everything downstream of the move is derived
// from where the catalogue entry and the record now sit, which is the only reason the split is
// a file move and not a migration — and the only way to show that is to move them and ask.
scenario('splitting a data root', {
  inProcess: true,
  prefix: 'e2e-split-',
  localConfig: true,
  remotes: true,
  github: {
    auth: 'ok',
    repos: { [`${ORG}/e2e-billing`]: { language: 'JavaScript' }, [`${ORG}/e2e-ledger`]: { language: 'Go' } },
  },
}, [
  step('one root holds two repos and a work apiece', m => {
    publish(m, 'e2e-billing')
    publish(m, 'e2e-ledger')
    assert.equal(m.rig(['init', '--data-root', m.dataRoot, '--work-root', m.workRoot,
      '--orgs', ORG, '--tracker', `${ORG}=none`, '--email', 'hugo@e2e.invalid',
      '--name', 'e2e-one']).code, 0)

    for (const [id, repo] of [['e2e-billing-work', 'e2e-billing'], ['e2e-ledger-work', 'e2e-ledger']]) {
      const r = m.rig(['new', id, '--title', `Work on ${repo}`, '--no-ticket', '--repos', repo])
      assert.equal(r.code, 0, r.out)
    }
    for (const repo of ['e2e-billing', 'e2e-ledger']) {
      assert.ok(fs.existsSync(path.join(m.dataRoot, 'catalog', ORG, `${repo}.md`)),
        'attach drafted the entry that binds the repo to this root')
    }
  }),

  step('a second root joins the installation', m => {
    m.second = path.join(m.tmp, 'rig-data-e2e-two')
    const r = m.rig(['init', '--data-root', m.second, '--orgs', ORG, '--tracker', `${ORG}=none`,
      '--name', 'e2e-two'])
    assert.equal(r.code, 0, r.out)
    assert.equal(m.rig(['use', 'e2e-one']).code, 0, 'and the first root is the one in hand again')
  }),

  step('the ledger moves out: its catalogue entry, its work record, and the work folder anchor', m => {
    const move = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.renameSync(from, to) }
    move(path.join(m.dataRoot, 'catalog', ORG, 'e2e-ledger.md'), path.join(m.second, 'catalog', ORG, 'e2e-ledger.md'))
    move(path.join(m.dataRoot, 'work', 'e2e-ledger-work'), path.join(m.second, 'work', 'e2e-ledger-work'))
    // The anchor is the work folder's half of the binding, and a move that leaves it behind
    // points a live worktree at a root that no longer holds its record.
    fs.writeFileSync(dataAnchorFile(path.join(m.workRoot, 'e2e-ledger-work')), 'e2e-two\n')
    for (const root of [m.dataRoot, m.second]) {
      m.gitMust(root, 'add', '-A')
      m.gitMust(root, 'commit', '-q', '-m', 'split: the ledger moves to e2e-two')
    }
  }),

  step('each root now answers only for its own', m => {
    const one = m.rig(['list', '--quick'])
    assert.match(one.stdout, /e2e-billing-work/)
    assert.doesNotMatch(one.stdout, /e2e-ledger-work/, 'the work that moved is no longer this root\'s')
    const two = m.rig(['list', '--quick', '--data', 'e2e-two'])
    assert.match(two.stdout, /e2e-ledger-work/)
    assert.doesNotMatch(two.stdout, /e2e-billing-work/)

    // The worktrees never moved, and the folder they are in still answers — from the root the
    // anchor now names.
    const here = m.rig(['status'], { cwd: path.join(m.workRoot, 'e2e-ledger-work') })
    assert.equal(here.code, 0, here.out)
    assert.match(here.out, /e2e-ledger-work/)
  }),

  step('the repo that moved places its next work by itself', m => {
    const r = m.rig(['new', 'e2e-ledger-next', '--title', 'More ledger', '--no-ticket', '--repos', 'e2e-ledger'])
    assert.equal(r.code, 0, r.out)
    assert.match(strip(r.out), /data root: e2e-two/, 'the repo chose, and the command said which')
    assert.ok(fs.existsSync(path.join(m.second, 'work', 'e2e-ledger-next', 'work.json')))
    assert.ok(!fs.existsSync(path.join(m.dataRoot, 'work', 'e2e-ledger-next')),
      'and nothing landed in the root that is current')
  }),

  step('and a work in one root cannot attach a repo that now belongs to the other', m => {
    const r = m.rig(['attach', 'e2e-ledger', '--work', 'e2e-billing-work', '--data', 'e2e-one'])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, /one work cannot span two data roots/)
    assert.ok(!fs.existsSync(path.join(m.dataRoot, 'catalog', ORG, 'e2e-ledger.md')),
      'and no entry for it was drafted back into this root')
  }),
])
