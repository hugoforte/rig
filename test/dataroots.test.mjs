// More than one data root on one installation.
//
// Two halves, and they are tested in the two places they live. The resolution order is a
// decision about files and an environment, so it is asserted directly against
// `bin/roots.mjs` with no subprocess. `rig use`, a work two roots hold,
// and the refusal of a work id another root already owns are things the CLI does,
// so those drive the tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locate, registry, load, rootsCataloguing, DATA_ROOT_ENV, DEFAULT_ROOT_NAME } from '../bin/roots.mjs'
import { makeInstall, strip } from './harness.mjs'

// A tool checkout and as many data roots beside it as the machine file names. Nothing here
// is a git checkout: resolution is a question about paths and JSON, and answering it should
// not need a repo.
const fixture = (machine, body) => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dataroots-')))
  try {
    const toolRoot = path.join(tmp, 'rig')
    fs.mkdirSync(toolRoot, { recursive: true })
    const resolved = JSON.parse(JSON.stringify(machine).replaceAll('<tmp>', tmp.replaceAll('\\', '\\\\')))
    for (const entry of Object.values(resolved.dataRoots ?? {})) {
      if (!entry.path) continue   // the malformed-entry case: there is nothing to make
      fs.mkdirSync(entry.path, { recursive: true })
      fs.writeFileSync(path.join(entry.path, 'rig.json'), JSON.stringify({ orgs: [] }))
    }
    if (resolved.dataRoot) fs.mkdirSync(resolved.dataRoot, { recursive: true })
    fs.writeFileSync(path.join(toolRoot, 'rig.local.json'), JSON.stringify(resolved))
    body({ tmp, toolRoot, machine: resolved })
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) }
}

// What `rig attach` drafts the first time it sees a repo, reduced to the part that binds it
// to a root: a file at catalog/<org>/<repo>.md.
const catalogue = (root, org, repo) => {
  fs.mkdirSync(path.join(root, 'catalog', org), { recursive: true })
  fs.writeFileSync(path.join(root, 'catalog', org, `${repo}.md`),
    `---\nrepo: ${repo}\norg: ${org}\nrole: whatever\n---\n`)
}

const THREE = {
  workRoot: '<tmp>/w',
  dataRoots: {
    hugoforte: { path: '<tmp>/rig-data' },
    personal: { path: '<tmp>/rig-data-personal' },
    linenmaster: { path: '<tmp>/rig-data-work', identities: { acme: 'hugo@work.invalid' } },
  },
  identities: { acme: 'hugo@personal.invalid' },
  current: 'hugoforte',
}

// ------------------------------------------------------------------ resolution order

test('the current data root is the one in hand when nothing else says otherwise', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    const location = locate(toolRoot, {}, { cwd: tmp })
    assert.equal(location.name, 'hugoforte')
    assert.equal(location.dataRoot, path.join(tmp, 'rig-data'))
    assert.equal(location.source, 'current')
  })
})

test('--data names a root and beats the current one', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    const location = locate(toolRoot, {}, { cwd: tmp, data: 'personal' })
    assert.equal(location.name, 'personal')
    assert.equal(location.source, 'flag')
  })
})

test(`${DATA_ROOT_ENV} pins a shell to one root, and --data still overrides it`, () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    const env = { [DATA_ROOT_ENV]: 'personal' }
    assert.equal(locate(toolRoot, env, { cwd: tmp }).name, 'personal')
    assert.equal(locate(toolRoot, env, { cwd: tmp, data: 'linenmaster' }).name, 'linenmaster')
  })
})

// A root's record of a work, reduced to what decides which root holds it: whether it is closed,
// or that it will not parse. `bom` is a closed record as PowerShell 5.1 saves it, BOM first.
const holds = (root, id, state = 'open') => {
  fs.mkdirSync(path.join(root, 'work', id), { recursive: true })
  const closed = JSON.stringify({ id, closedAt: '2026-10-01' })
  const text = { open: JSON.stringify({ id }), closed, bom: `﻿${closed}`, unreadable: '{"id":' }[state]
  fs.writeFileSync(path.join(root, 'work', id, 'work.json'), text)
}
// A work folder as `rig new` leaves it, reduced to its `.rig/id`.
const folder = (tmp, id) => {
  const dir = path.join(tmp, 'w', id)
  fs.mkdirSync(path.join(dir, '.rig'), { recursive: true })
  fs.writeFileSync(path.join(dir, '.rig', 'id'), `${id}\n`)
  return dir
}

test('a work open in one root resolves there, from its folder or by name, whatever closed copies the others keep', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    // hugoforte/rig#274: the current root keeps an abandoned copy, and the work moved on in another.
    holds(machine.dataRoots.hugoforte.path, 'w', 'closed')
    holds(machine.dataRoots.personal.path, 'w')
    const dir = folder(tmp, 'w')
    // A marker from before the move names the closed copy's root, and is no longer read.
    fs.writeFileSync(path.join(dir, '.rig', 'data'), 'hugoforte\n')
    const fromFolder = locate(toolRoot, {}, { cwd: path.join(dir, 'billing', 'src') })
    assert.equal(fromFolder.name, 'personal', 'resolved from a directory deep inside the work')
    assert.equal(fromFolder.source, 'work')
    assert.equal(locate(toolRoot, {}, { cwd: tmp, work: 'w' }).name, 'personal', 'named on the command')
    catalogue(machine.dataRoots.linenmaster.path, 'acme', 'Payments')
    assert.equal(locate(toolRoot, {}, { cwd: dir, repos: ['Payments'] }).name, 'personal', 'the work beats the repo')
    assert.equal(locate(toolRoot, { [DATA_ROOT_ENV]: 'linenmaster' }, { cwd: dir }).name, 'linenmaster', 'a pinned shell beats it')
    assert.equal(locate(toolRoot, {}, { cwd: dir, data: 'hugoforte' }).name, 'hugoforte', '--data beats it')
    holds(machine.dataRoots.hugoforte.path, 'w', 'bom')
    assert.equal(locate(toolRoot, {}, { cwd: dir }).name, 'personal', 'a closed copy saved with a BOM is still closed')
  })
})

test('a work no root holds open is in the one root that holds it at all', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    holds(machine.dataRoots.linenmaster.path, 'w', 'closed')
    assert.equal(locate(toolRoot, {}, { cwd: folder(tmp, 'w') }).name, 'linenmaster')
  })
})

test('two copies with none to prefer is a pick, so it is refused, naming the roots', () => {
  // Two open, and two closed: a closed work is still written to, since lessons are reviewed
  // after the close. A copy that will not parse counts as open, and a closed copy beside two
  // open ones is not one of the roots to choose between.
  for (const [a, b, c] of [['open', 'open'], ['closed', 'closed'], ['unreadable', 'open', 'closed']]) {
    fixture(THREE, ({ tmp, toolRoot, machine }) => {
      holds(machine.dataRoots.hugoforte.path, 'w', a)
      holds(machine.dataRoots.personal.path, 'w', b)
      if (c) holds(machine.dataRoots.linenmaster.path, 'w', c)
      const refused = /: data roots hugoforte, personal each hold a record of work "w" — pass --data <name> to say which$/
      assert.throws(() => locate(toolRoot, {}, { cwd: folder(tmp, 'w') }), refused, [a, b, c].join(', '))
    })
  }
})

test('the work a command names beats the folder it runs in, and one no root holds falls through to current', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    holds(machine.dataRoots.personal.path, 'w')
    holds(machine.dataRoots.linenmaster.path, 'other')
    const dir = folder(tmp, 'w')
    assert.equal(locate(toolRoot, {}, { cwd: dir, work: 'other' }).name, 'linenmaster')
    assert.equal(locate(toolRoot, {}, { cwd: dir, work: 'nowhere' }).source, 'current')
    assert.equal(locate(toolRoot, {}, { cwd: folder(tmp, 'nowhere') }).source, 'current', 'and so does a folder no root holds')
  })
})

// ------------------------------------------------- the repo says which knowledge is its own

test('a repo named on the command puts the work in the root that catalogues it', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    catalogue(machine.dataRoots.linenmaster.path, 'acme', 'Payments')
    const location = locate(toolRoot, {}, { cwd: tmp, repos: ['Payments'] })
    assert.equal(location.name, 'linenmaster', 'and not `current`, which is hugoforte')
    assert.equal(location.source, 'repo')
  })
})

test('the repo the current directory is in answers when nothing named one', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    catalogue(machine.dataRoots.personal.path, 'acme', 'notes')
    const location = locate(toolRoot, {}, { cwd: tmp, repoAt: () => 'notes' })
    assert.equal(location.name, 'personal')
    assert.equal(location.source, 'repo')
  })
})

test('a repo named with its org matches only that org\'s entry', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    catalogue(machine.dataRoots.personal.path, 'hugoforte', 'rig-data')
    const location = locate(toolRoot, {}, { cwd: tmp, repoAt: () => 'linenmaster/rig-data' })
    assert.equal(location.source, 'current', 'another org\'s repo of the same name is not this one')
  })
})

test('the same org and repo still places the command in the root that catalogues it', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    catalogue(machine.dataRoots.personal.path, 'acme', 'notes')
    assert.equal(locate(toolRoot, {}, { cwd: tmp, repoAt: () => 'ACME/Notes' }).name, 'personal')
  })
})

test('standing in a data root\'s own checkout places the command in that root', () => {
  fixture(THREE, ({ toolRoot, machine }) => {
    let asked = 0
    const inside = path.join(machine.dataRoots.linenmaster.path, 'work')
    fs.mkdirSync(inside, { recursive: true })
    const location = locate(toolRoot, {}, { cwd: inside, repoAt: () => { asked++; return 'rig-data' } })
    assert.equal(location.name, 'linenmaster', 'and not `current`, which is hugoforte')
    assert.equal(location.source, 'root')
    assert.equal(asked, 0, 'the checkout answered, so the repo it is was never asked')
  })
})

test('a data root cloned inside another root\'s folder answers for itself', () => {
  const nested = {
    workRoot: '<tmp>/w',
    dataRoots: { outer: { path: '<tmp>/outer' }, inner: { path: '<tmp>/outer/inner' } },
    current: 'outer',
  }
  fixture(nested, ({ toolRoot, machine }) => {
    assert.equal(locate(toolRoot, {}, { cwd: machine.dataRoots.inner.path }).name, 'inner')
  })
})

test('a repo named on the command still beats the data root checkout it runs in', () => {
  fixture(THREE, ({ toolRoot, machine }) => {
    catalogue(machine.dataRoots.personal.path, 'acme', 'Payments')
    const location = locate(toolRoot, {}, { cwd: machine.dataRoots.linenmaster.path, repos: ['Payments'] })
    assert.equal(location.name, 'personal')
  })
})

test('finding the repo the cwd is in costs a subprocess, so it is not asked when something cheaper answered', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    let asked = 0
    locate(toolRoot, {}, { cwd: tmp, data: 'personal', repoAt: () => { asked++; return 'notes' } })
    assert.equal(asked, 0)
  })
})

test('nor when no root catalogues anything, because a repo could not place this installation', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    let asked = 0
    const location = locate(toolRoot, {}, { cwd: tmp, repoAt: () => { asked++; return 'notes' } })
    assert.equal(asked, 0, 'a catalogue entry is what binds a repo to a root, and there is none')
    assert.equal(location.source, 'current', 'so the pointer decides, exactly as it would have')
  })
})

test('a repo nothing catalogues falls through to the current root', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    const location = locate(toolRoot, {}, { cwd: tmp, repos: ['never-seen'] })
    assert.equal(location.name, 'hugoforte')
    assert.equal(location.source, 'current')
  })
})

test('two repos in two roots is one work that cannot exist, and says so', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    catalogue(machine.dataRoots.linenmaster.path, 'acme', 'Payments')
    catalogue(machine.dataRoots.personal.path, 'acme', 'notes')
    assert.throws(() => locate(toolRoot, {}, { cwd: tmp, repos: ['Payments', 'notes'] }),
      /one work cannot span two data roots/)
  })
})

test('a repo catalogued in two roots is ambiguous, not a coin toss', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    catalogue(machine.dataRoots.linenmaster.path, 'acme', 'Payments')
    catalogue(machine.dataRoots.personal.path, 'acme', 'Payments')
    assert.throws(() => locate(toolRoot, {}, { cwd: tmp, repos: ['Payments'] }),
      /catalogued in more than one data root \(personal, linenmaster\) — pass --data/)
  })
})

test('a root with no catalogue at all is not an error, it simply has no repos', () => {
  fixture(THREE, ({ machine }) => {
    assert.deepEqual(rootsCataloguing({ personal: { path: machine.dataRoots.personal.path } }, 'anything'), [])
  })
})

// ------------------------------------------------------------------ the one-root form

test('a machine file with one bare dataRoot reads as a registry of exactly one', () => {
  fixture({ dataRoot: '<tmp>/rig-data', workRoot: '<tmp>/w' }, ({ tmp, toolRoot }) => {
    const reg = registry(toolRoot, {})
    assert.deepEqual(Object.keys(reg.roots), [DEFAULT_ROOT_NAME])
    const location = locate(toolRoot, {}, { cwd: tmp })
    assert.equal(location.dataRoot, path.join(tmp, 'rig-data'))
    assert.equal(location.source, 'only', 'one root and no pointer: nothing was chosen invisibly')
  })
})

test('a relative path under dataRoots resolves against the machine file, not the cwd', () => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'dataroots-rel-')))
  try {
    const toolRoot = path.join(tmp, 'rig')
    fs.mkdirSync(toolRoot, { recursive: true })
    fs.writeFileSync(path.join(toolRoot, 'rig.local.json'),
      JSON.stringify({ dataRoots: { personal: { path: '../rig-data' } }, current: 'personal' }))
    assert.equal(locate(toolRoot, {}, { cwd: tmp }).dataRoot, path.join(tmp, 'rig-data'))
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) }
})

// ------------------------------------------------------------------ what cannot be guessed

test('a name nothing configures is fatal, and says what there is instead', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    assert.throws(() => locate(toolRoot, {}, { cwd: tmp, data: 'nope' }),
      /--data names data root "nope".*hugoforte, personal, linenmaster/s)
  })
})

test('several roots and no current is fatal rather than a guess', () => {
  fixture({ ...THREE, current: undefined }, ({ tmp, toolRoot }) => {
    assert.throws(() => locate(toolRoot, {}, { cwd: tmp }), /none is current/)
  })
})

test('an entry with no path names the entry that is wrong', () => {
  fixture({ dataRoots: { personal: { note: 'no path here' } } }, ({ toolRoot }) => {
    assert.throws(() => registry(toolRoot, {}), /dataRoots\.personal .* has no "path"/)
  })
})

// ------------------------------------------------------------------ identities

test('a root\'s identity for an org beats the machine-wide one', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    assert.equal(load(locate(toolRoot, {}, { cwd: tmp, data: 'linenmaster' })).identities.acme, 'hugo@work.invalid')
  })
})

test('a root that says nothing about an org falls back to the machine-wide identity', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    assert.equal(load(locate(toolRoot, {}, { cwd: tmp, data: 'personal' })).identities.acme, 'hugo@personal.invalid')
  })
})

test('the registry is the location\'s to answer, and never the merged config\'s', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    const cfg = load(locate(toolRoot, {}, { cwd: tmp }))
    assert.equal(cfg.dataRoots, undefined)
    assert.equal(cfg.current, undefined)
    assert.equal(cfg.dataRootName, 'hugoforte')
  })
})

// ------------------------------------------------------------------ the CLI

const install = makeInstall({ prefix: 'dataroots-cli-', localConfig: true, github: { issues: {} }, inProcess: true })
const { tmp, dataRoot, workRoot, localConfig, githubStateFile, rig, gitMust, cleanup } = install
const second = path.join(tmp, 'rig-data-personal')

// Two data roots, each a checkout of its own with a rig.json this rig stamped, and the
// machine file naming both. `rig init` writes the first; the second is made the same way so
// that the two are indistinguishable to everything downstream.
const setUp = () => {
  assert.equal(rig(['init', '--data-root', dataRoot, '--work-root', workRoot,
    '--orgs', 'acme', '--email', 'hugo@acme.invalid', '--name', 'hugoforte']).code, 0)
  assert.equal(rig(['init', '--data-root', second, '--orgs', 'personal',
    '--email', 'hugo@personal.invalid', '--name', 'personal']).code, 0)
}
setUp()

test.after(cleanup)

test('init names the root it set up, and normalises nothing away in doing so', () => {
  const machine = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  assert.deepEqual(Object.keys(machine.dataRoots), ['hugoforte', 'personal'])
  assert.equal(machine.dataRoots.hugoforte.path, dataRoot)
  assert.equal(path.resolve(machine.dataRoot), path.resolve(second),
    'the one-root key stays, pointed at current, for a rig that has not updated yet')
  assert.equal(machine.current, 'personal', 'the root just set up is the one in hand')
})

test('naming the root you already have renames it, and never invents a second entry', () => {
  // The one-root form normalises to `default`; `--name` is how it stops being that. Setting
  // `current` to a name with no entry would leave a machine file that refuses every command.
  const saved = fs.readFileSync(localConfig, 'utf8')
  fs.writeFileSync(localConfig, JSON.stringify({ ...JSON.parse(saved), dataRoots: undefined, current: undefined, dataRoot }))
  assert.equal(rig(['init', '--data-root', dataRoot, '--name', 'hugoforte']).code, 0)
  const machine = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  assert.deepEqual(Object.keys(machine.dataRoots), ['hugoforte'], 'renamed, not added alongside default')
  assert.equal(machine.current, 'hugoforte')
  assert.equal(rig(['use']).code, 0, 'and the machine file still resolves')
  fs.writeFileSync(localConfig, saved)
})

test('--data-repo --name adds a second root rather than refusing to move the first', () => {
  // The README's own recipe for adding one. It used to die on the guard against switching
  // data roots by accident, and land both roots on one directory named for the repo.
  const saved = fs.readFileSync(localConfig, 'utf8')
  const r = rig(['init', '--data-repo', 'acme/rig-data', '--name', 'third', '--orgs', 'acme'])
  assert.equal(r.code, 0, r.out)
  const machine = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  assert.ok(machine.dataRoots.third, 'the second root was added')
  assert.match(machine.dataRoots.third.path, /rig-data-third$/, 'in a directory named for it, not for the repo')
  assert.notEqual(path.resolve(machine.dataRoots.third.path), path.resolve(dataRoot), 'and not on top of the first')
  fs.writeFileSync(localConfig, saved)
})

test('a data repo GitHub would not say exists is neither joined nor created', () => {
  // "gh could not answer" read as "does not exist" would send an existing repo down the
  // create path, so the lookup's own refusal stops it (decision 170).
  const saved = fs.readFileSync(localConfig, 'utf8')
  const state = JSON.parse(fs.readFileSync(githubStateFile, 'utf8'))
  fs.writeFileSync(githubStateFile, JSON.stringify({ ...state, auth: 'unauthenticated' }))
  const r = rig(['init', '--data-repo', 'acme/unasked', '--name', 'unasked', '--orgs', 'acme'])
  fs.writeFileSync(localConfig, saved)
  fs.writeFileSync(githubStateFile, JSON.stringify(state))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /could not ask GitHub whether acme\/unasked exists \(gh is not authenticated \(in-memory GitHub\)\) — joining or creating a data repo needs it/)
  assert.doesNotMatch(r.out, /cloning to|creating it, private/, 'nothing was joined or created')
})

test('joining an empty data repo pushes its first commit without ever asking for credentials', () => {
  // A server-side hook runs under the pushing git's environment on a local remote, so it
  // sees what the push was run with. The two variables are taken out of the run's own
  // environment first, so a shell that already sets them cannot pass this for rig.
  const saved = fs.readFileSync(localConfig, 'utf8')
  const bare = path.join(tmp, 'empty-data.git')
  const seen = path.join(tmp, 'push-env')
  gitMust(tmp, 'init', '-q', '--bare', '-b', 'main', bare)
  fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'), `#!/bin/sh\necho "$GIT_TERMINAL_PROMPT $GCM_INTERACTIVE" >> '${seen.replaceAll('\\', '/')}'\n`, { mode: 0o755 })
  const state = JSON.parse(fs.readFileSync(githubStateFile, 'utf8'))
  fs.writeFileSync(githubStateFile, JSON.stringify({ ...state, auth: 'ok', repos: { ...state.repos, 'acme/empty-data': { language: '', prs: [], issues: [], source: bare } } }))
  const env = Object.fromEntries(Object.entries(install.env).filter(([k]) => !['GIT_TERMINAL_PROMPT', 'GCM_INTERACTIVE'].includes(k)))

  const r = rig(['init', '--data-repo', 'acme/empty-data', '--name', 'joined', '--orgs', 'acme'], { env })
  fs.writeFileSync(localConfig, saved)
  fs.writeFileSync(githubStateFile, JSON.stringify(state))
  assert.equal(r.code, 0, r.out)
  // The first push, and then the save every mutating command ends in.
  assert.deepEqual(fs.readFileSync(seen, 'utf8').trim().split(/\r?\n/), ['0 never', '0 never'])
})

test('a first push refused for want of credentials names the command that signs git in', () => {
  // The remote refuses in Git Credential Manager's words for a sign-in it may not ask for.
  const saved = fs.readFileSync(localConfig, 'utf8')
  const bare = path.join(tmp, 'signed-out.git')
  gitMust(tmp, 'init', '-q', '--bare', '-b', 'main', bare)
  fs.writeFileSync(path.join(bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho "fatal: Cannot prompt because user interactivity has been disabled." >&2\nexit 1\n', { mode: 0o755 })
  const state = JSON.parse(fs.readFileSync(githubStateFile, 'utf8'))
  fs.writeFileSync(githubStateFile, JSON.stringify({ ...state, auth: 'ok', repos: { ...state.repos, 'acme/signed-out': { language: '', prs: [], issues: [], source: bare } } }))

  const r = rig(['init', '--data-repo', 'acme/signed-out', '--name', 'signed-out', '--orgs', 'acme'])
  fs.writeFileSync(localConfig, saved)
  fs.writeFileSync(githubStateFile, JSON.stringify(state))
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /git needed credentials, and rig never waits at a prompt: sign git in with `gh auth setup-git`/)
})

test('rig use lists every root and marks the current one', () => {
  const r = rig(['use'])
  assert.equal(r.code, 0)
  assert.match(r.out, /hugoforte/)
  assert.match(r.out, /\* personal/)
})

test('the one-root form has no pointer, and is marked all the same', () => {
  const saved = fs.readFileSync(localConfig, 'utf8')
  fs.writeFileSync(localConfig, JSON.stringify({ ...JSON.parse(saved), dataRoots: undefined, current: undefined, dataRoot }))
  const r = rig(['use'])
  assert.equal(r.code, 0)
  assert.match(r.out, new RegExp(`\\* ${DEFAULT_ROOT_NAME}`))
  fs.writeFileSync(localConfig, saved)
})

test('rig use switches, and says what it switched from', () => {
  const r = rig(['use', 'hugoforte'])
  assert.equal(r.code, 0)
  assert.match(r.out, /was personal/)
  assert.equal(JSON.parse(fs.readFileSync(localConfig, 'utf8')).current, 'hugoforte')
})

test('the one-root key is kept pointed at current, so a rig that has not updated still works', () => {
  // Between naming the roots and `rig update` bringing the installed copy forward, the rig on
  // PATH reads `dataRoot` and nothing else. Deleting it broke that rig until it updated.
  assert.equal(rig(['use', 'personal']).code, 0)
  const onPersonal = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  assert.equal(path.resolve(onPersonal.dataRoot), path.resolve(second))
  assert.equal(rig(['use', 'hugoforte']).code, 0)
  const onHugoforte = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  assert.equal(path.resolve(onHugoforte.dataRoot), path.resolve(dataRoot), 'it follows `rig use`')

  // And `rig use <the one you are already on>` is how a missing or stale one is asked back.
  const machine = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  delete machine.dataRoot
  fs.writeFileSync(localConfig, JSON.stringify(machine))
  assert.equal(rig(['use', 'hugoforte']).code, 0)
  assert.equal(path.resolve(JSON.parse(fs.readFileSync(localConfig, 'utf8')).dataRoot), path.resolve(dataRoot))
})

test('rig use refuses a name the machine does not configure', () => {
  const r = rig(['use', 'employer'])
  assert.equal(r.code, 1)
  assert.match(r.out, /no data root "employer"/)
  assert.equal(JSON.parse(fs.readFileSync(localConfig, 'utf8')).current, 'hugoforte', 'and did not move')
})

test('rig use refuses a root whose directory has gone, rather than switching into nothing', () => {
  const machine = JSON.parse(fs.readFileSync(localConfig, 'utf8'))
  const saved = JSON.stringify(machine)
  machine.dataRoots.ghost = { path: path.join(tmp, 'not-here') }
  fs.writeFileSync(localConfig, JSON.stringify(machine))
  const r = rig(['use', 'ghost'])
  assert.equal(r.code, 1)
  assert.match(r.out, /which is not there/)
  fs.writeFileSync(localConfig, saved)
})

test('a work belongs to the root it was made in, and every other root is unaware of it', () => {
  assert.equal(rig(['new', 'only-here', '--title', 'Only in hugoforte', '--no-ticket']).code, 0)
  assert.match(rig(['list', '--quick']).out, /only-here/)
  assert.doesNotMatch(rig(['list', '--quick', '--data', 'personal']).out, /only-here/)
  assert.ok(fs.existsSync(path.join(dataRoot, 'work', 'only-here', 'work.json')))
  assert.ok(!fs.existsSync(path.join(second, 'work', 'only-here', 'work.json')))
})

test('a work abandoned in the current root and open in another is the open one, in its folder and by name', (t) => {
  // hugoforte/rig#274: the work moved to personal, leaving its first copy behind abandoned.
  const record = path.join(dataRoot, 'work', 'only-here', 'work.json')
  const saved = fs.readFileSync(record, 'utf8')
  const copy = path.join(second, 'work', 'only-here')
  t.after(() => { fs.rmSync(copy, { recursive: true, force: true }); fs.writeFileSync(record, saved) })
  fs.cpSync(path.dirname(record), copy, { recursive: true })
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(saved), closedAt: '2026-10-01T00:00:00Z', abandonedAt: '2026-10-01T00:00:00Z' }))
  for (const [r, how] of [[rig(['status'], { cwd: path.join(workRoot, 'only-here') }), 'in its folder'], [rig(['status', '--work', 'only-here']), 'by --work']]) {
    assert.equal(r.code, 0, `${how}: ${r.out}`)
    assert.match(r.out, /only-here/, how)
    assert.doesNotMatch(r.out, /abandoned/i, how)
  }
  assert.match(rig(['restore', 'only-here']).out, /has no repos attached/, 'not "abandoned — there is nothing to restore"')
  const doctor = strip(rig(['doctor']).out)
  assert.match(doctor, /only-here: data roots hugoforte, personal each hold its record/)
  assert.equal(doctor.match(/only-here:/g)?.length, 1, 'said once, though two roots list it')
})

test('a work moved, then closed, is closed in two roots: close says --data, commands ask for it, doctor and tidy name it', (t) => {
  assert.equal(rig(['new', 'moved-twice', '--title', 'Moved, then closed', '--no-ticket']).code, 0)
  const record = path.join(dataRoot, 'work', 'moved-twice', 'work.json')
  fs.cpSync(path.dirname(record), path.join(second, 'work', 'moved-twice'), { recursive: true })
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), closedAt: '2026-10-01T00:00:00Z', abandonedAt: '2026-10-01T00:00:00Z' }))
  t.after(() => { for (const root of [dataRoot, second]) fs.rmSync(path.join(root, 'work', 'moved-twice'), { recursive: true, force: true }) })
  t.after(() => fs.rmSync(path.join(workRoot, 'moved-twice'), { recursive: true, force: true }))
  const closed = rig(['close', '--work', 'moved-twice'])
  assert.equal(closed.code, 0, closed.out)
  assert.match(strip(closed.out), /`rig save --work moved-twice --data personal -m "lessons reviewed" --learned`/)
  const status = rig(['status', '--work', 'moved-twice'])
  assert.equal(status.code, 1, status.out)
  assert.match(strip(status.out), /data roots hugoforte, personal each hold a record of work "moved-twice" — pass --data <name> to say which/)
  assert.equal(rig(['status', '--work', 'moved-twice', '--data', 'personal']).code, 0)
  assert.match(strip(rig(['doctor']).out), /moved-twice: data roots hugoforte, personal each hold its record/)
  // A copy of the folder left on this machine, with a file in it that only this machine has.
  fs.mkdirSync(path.join(workRoot, 'moved-twice'), { recursive: true })
  fs.writeFileSync(path.join(workRoot, 'moved-twice', 'notes.txt'), 'mine')
  assert.match(strip(rig(['tidy', '--dry-run']).out), /`rig close --work moved-twice --data hugoforte --force` to discard it/)
})

test('a record in two roots with a copy unreadable: doctor names each broken copy and says both roots hold it, whichever is broken', (t) => {
  const copy = path.join(second, 'work', 'only-here')
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }))
  fs.cpSync(path.join(dataRoot, 'work', 'only-here'), copy, { recursive: true })
  const saved = fs.readFileSync(path.join(copy, 'work.json'), 'utf8')
  for (const broken of [[dataRoot], [second], [dataRoot, second]]) {
    const files = broken.map(root => path.join(root, 'work', 'only-here', 'work.json'))
    for (const file of files) fs.writeFileSync(file, saved.slice(0, 20))
    try {
      const out = strip(rig(['doctor']).out)
      assert.equal(out.match(/only-here: work record for "only-here" at .*work\.json could not be read/g)?.length, files.length, broken.join(', '))
      assert.equal(out.match(/only-here: data roots hugoforte, personal each hold its record — delete the copy that is wrong/g)?.length, 1, broken.join(', '))
    } finally { for (const file of files) fs.writeFileSync(file, saved) }
  }
})

test('a command run inside a work folder reads that work\'s root, whatever is current', () => {
  assert.equal(rig(['use', 'personal']).code, 0)
  const r = rig(['status'], { cwd: path.join(workRoot, 'only-here') })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /only-here/, 'the work its folder names won, and `current` was never consulted')
  assert.equal(rig(['use', 'hugoforte']).code, 0)
})

test('a rootless command says which root `current` chose for it', () => {
  assert.match(rig(['list', '--quick']).out, /data root: hugoforte/)
})

test('a work id another root already owns is refused, and that root is named', () => {
  const r = rig(['new', 'only-here', '--title', 'Same slug, other root', '--no-ticket', '--data', 'personal'])
  assert.equal(r.code, 1)
  assert.match(r.out, /belongs to data root "hugoforte"/)
  assert.ok(!fs.existsSync(path.join(second, 'work', 'only-here')), 'and nothing was recorded for it')
})

test('rig new --repos puts the work in the root that catalogues the repo', () => {
  // The binding `rig attach` would have written the first time it saw this repo.
  fs.mkdirSync(path.join(second, 'catalog', 'acme'), { recursive: true })
  fs.writeFileSync(path.join(second, 'catalog', 'acme', 'ledger.md'),
    '---\nrepo: ledger\norg: acme\nrole: the ledger\n---\n')
  assert.equal(rig(['use', 'hugoforte']).code, 0, 'current is the other root')
  const r = rig(['new', 'ledger-work', '--title', 'Ledger work', '--no-ticket', '--repos', 'ledger'])
  assert.match(strip(r.out), /data root: personal/, 'the repo chose, and the command said so')
  assert.ok(fs.existsSync(path.join(second, 'work', 'ledger-work', 'work.json')))
  assert.ok(!fs.existsSync(path.join(dataRoot, 'work', 'ledger-work')), 'and nothing landed in the current root')
})

test('a repo belonging to another root cannot be attached to this work', () => {
  const r = rig(['attach', 'ledger', '--work', 'only-here', '--data', 'hugoforte'])
  assert.equal(r.code, 1)
  assert.match(r.out, /catalogued in data root "personal".*one work cannot span two data roots/s)
  assert.ok(!fs.existsSync(path.join(dataRoot, 'catalog', 'acme', 'ledger.md')),
    'and no entry for it was drafted into this root')
})

// The repo the command stands in, found end to end: every test of that step above hands
// `locate` a fake. A real checkout outside any work folder, so no anchor answers first, and
// not named for its repo, so reading the folder name cannot pass for reading the remote. Its
// repo is ledger, which `personal` catalogues since `rig new --repos` above; current is the
// other root.
const checkoutAt = (where, repo, org = 'acme') => {
  const dir = path.join(tmp, where)
  fs.mkdirSync(dir, { recursive: true })
  gitMust(dir, 'init', '-q', '-b', 'main')
  gitMust(dir, 'remote', 'add', 'origin', `https://github.com/${org}/${repo}.git`)
  return dir
}

test('the checkout a command runs in chooses the root that catalogues its repo', () => {
  // The run's folder and not the process's: in this process that is the checkout the suite
  // runs from, whose repo no root here catalogues.
  assert.equal(rig(['use', 'hugoforte']).code, 0)
  const r = rig(['list', '--quick'], { cwd: checkoutAt('somewhere/my-clone', 'ledger') })
  assert.match(r.out, /data root: personal \(the repo it is about\)/)
})

test('the root a command chose is said beside its answer, so `list --json` is JSON alone', () => {
  const r = rig(['list', '--json', '--quick'], { cwd: checkoutAt('somewhere/piped', 'ledger') })
  assert.match(r.out, /data root: personal \(the repo it is about\)/, 'still said')
  assert.doesNotThrow(() => JSON.parse(r.stdout), 'and a pipe gets the payload and nothing else')
})

test('a checkout of another org\'s repo with the same name is not placed by it', () => {
  const r = rig(['list', '--quick'], { cwd: checkoutAt('somewhere/other-org', 'ledger', 'someone-else') })
  assert.match(r.out, /data root: hugoforte \(current\)/)
})

test('an ssh remote is matched by its org too', () => {
  const dir = checkoutAt('somewhere/over-ssh', 'ledger')
  gitMust(dir, 'remote', 'set-url', 'origin', 'git@github.com:someone-else/ledger.git')
  const r = rig(['list', '--quick'], { cwd: dir })
  assert.match(r.out, /data root: hugoforte \(current\)/)
})

test('a command run in a data root\'s own checkout reads that root, whatever is current', () => {
  assert.equal(rig(['use', 'hugoforte']).code, 0)
  const r = rig(['list', '--quick'], { cwd: second })
  assert.match(r.out, /ledger-work/, 'the work that root holds')
  assert.doesNotMatch(r.out, /only-here/, 'and not the current root\'s')
})

test('a checkout the filesystem walk hands back to git is still placed by its repo', () => {
  // `core.worktree` is a layout `gitfs` will not answer for, and its null means "ask git",
  // never "no checkout here".
  const dir = checkoutAt('somewhere/handed-back', 'ledger')
  gitMust(dir, 'config', 'core.worktree', dir.split(path.sep).join('/'))
  const r = rig(['list', '--quick'], { cwd: dir })
  assert.match(r.out, /data root: personal \(the repo it is about\)/)
})

// A folder named for ledger, so the name is there to be guessed from, and what decides
// whether it is guessed is git.

test('a checkout with no origin is named by its folder, the one name it has', () => {
  const dir = path.join(tmp, 'no-origin', 'ledger')
  fs.mkdirSync(dir, { recursive: true })
  gitMust(dir, 'init', '-q', '-b', 'main')
  const r = rig(['list', '--quick'], { cwd: dir })
  assert.match(r.out, /data root: personal \(the repo it is about\)/)
})

test('a repository git refuses to open is not named by its folder', () => {
  // git refuses a repository with an extension it does not know, or one another user owns,
  // and the filesystem walk sees neither. Every question put to git then fails, `remote
  // get-url` with it, and that is not the same answer as "no origin".
  const dir = checkoutAt('refused/ledger', 'payments')
  gitMust(dir, 'config', 'core.repositoryformatversion', '1')
  gitMust(dir, 'config', 'extensions.rigHasNeverHeardOfThis', 'true')
  const r = rig(['list', '--quick'], { cwd: dir })
  assert.match(r.out, /data root: hugoforte \(current\)/)
})

test('--data with no name is a typo, not a request', () => {
  const r = rig(['list', '--data'])
  assert.equal(r.code, 1)
  assert.match(r.out, /--data wants a data root name/)
})

test('rig update brings every configured root forward, not only the one in hand', () => {
  // Push both data roots back to a record format before this rig's, so both have something
  // to migrate. Only a loop over the registry moves them both.
  for (const root of [dataRoot, second]) {
    const file = path.join(root, 'rig.json')
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), writtenBy: '1.0.0' }, null, 2) + '\n')
    gitMust(root, 'add', '-A')
    gitMust(root, 'commit', '-q', '-m', 'back to format 1')
  }
  const r = rig(['update'])
  assert.match(strip(r.out), /data root hugoforte migrated/)
  assert.match(strip(r.out), /data root personal migrated/)
  for (const root of [dataRoot, second]) {
    assert.notEqual(JSON.parse(fs.readFileSync(path.join(root, 'rig.json'), 'utf8')).writtenBy, '1.0.0')
  }
})

test('rig update still brings every root forward when none is current', (t) => {
  // Two roots and no pointer: every command that answers about a root's contents dies here,
  // and `update` is not one of them. Put back afterwards, since the tests below want a root
  // in hand.
  const saved = fs.readFileSync(localConfig, 'utf8')
  t.after(() => fs.writeFileSync(localConfig, saved))
  for (const root of [dataRoot, second]) {
    const file = path.join(root, 'rig.json')
    fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), writtenBy: '1.0.0' }, null, 2) + '\n')
    gitMust(root, 'add', '-A')
    gitMust(root, 'commit', '-q', '-m', 'back to format 1')
  }
  const machine = JSON.parse(saved)
  delete machine.current
  fs.writeFileSync(localConfig, JSON.stringify(machine))
  const out = strip(rig(['update']).out)
  assert.match(out, /data root hugoforte migrated/)
  assert.match(out, /data root personal migrated/)
})

test('rig update says a selection it cannot make once, through the doctor checks it ends in', (t) => {
  const saved = fs.readFileSync(localConfig, 'utf8')
  t.after(() => fs.writeFileSync(localConfig, saved))
  const machine = JSON.parse(saved)
  delete machine.current
  fs.writeFileSync(localConfig, JSON.stringify(machine))
  const r = rig(['update'])
  assert.equal(r.code, 1, 'a machine with nothing selected has something to look at')
  assert.match(strip(r.out), /thing\(s\) to look at/, 'the doctor checks ran')
  assert.equal(strip(r.out).match(/none is current/g)?.length, 1, strip(r.out))
})

// ------------------------------------------------------------- doctor, over every root

// What the findings say is asserted over fixtures in test/doctor.test.mjs; what these prove is
// the half that cannot be faked — that the gathering reaches past the root in hand, and that
// the work root it compares against is the one both roots share.

test('doctor checks every configured root, and says which root each line is about', () => {
  const out = strip(rig(['doctor']).out)
  assert.match(out, /hugoforte: data root/)
  assert.match(out, /personal: data root/)
  assert.match(out, /hugoforte: rig\.json/)
  assert.match(out, /personal: rig\.json/)
})

test('a work folder another root holds the record for is accounted for, not reported as junk', () => {
  assert.equal(rig(['use', 'hugoforte']).code, 0)
  assert.equal(rig(['new', 'doctor-roots-elsewhere', '--title', 'In the other root',
    '--no-ticket', '--data', 'personal']).code, 0)
  assert.doesNotMatch(strip(rig(['doctor']).out), /doctor-roots-elsewhere/,
    'the current root has never heard of it, and the work root is shared')
})

test('an entry under the work root no data root has a record for is named', () => {
  const junk = path.join(workRoot, 'doctor-roots-junk')
  fs.mkdirSync(junk, { recursive: true })
  try {
    assert.match(strip(rig(['doctor']).out), /unmanaged entry "doctor-roots-junk"/)
  } finally { fs.rmSync(junk, { recursive: true, force: true }) }
})

test('an unclosed work is warned about whichever root holds its record', () => {
  fs.rmSync(path.join(workRoot, 'doctor-roots-elsewhere'), { recursive: true, force: true })
  assert.match(strip(rig(['doctor']).out), /doctor-roots-elsewhere: work folder missing but not closed/)
})

test('a root whose directory has gone is a finding, and the roots that are fine still answer', () => {
  const saved = fs.readFileSync(localConfig, 'utf8')
  const machine = JSON.parse(saved)
  machine.dataRoots.ghost = { path: path.join(tmp, 'not-here') }
  fs.writeFileSync(localConfig, JSON.stringify(machine))
  try {
    const out = strip(rig(['doctor']).out)
    assert.match(out, /ghost: data root .* missing — check dataRoots\.ghost/)
    assert.match(out, /hugoforte: rig\.json/, 'and the root after it was still checked')
  } finally { fs.writeFileSync(localConfig, saved) }
})

// A work id held by two roots, closed in the first and open in the second: a work that moved to
// another root, with the copy it left behind closed. The folder is the open work's, so nothing
// that clears leftovers may take it, whichever root's records are read first.
const openInSecond = (t, id) => {
  assert.equal(rig(['new', id, '--title', 'Open in personal', '--no-ticket', '--data', 'personal']).code, 0)
  const copy = path.join(dataRoot, 'work', id)
  fs.cpSync(path.join(second, 'work', id), copy, { recursive: true })
  const record = path.join(copy, 'work.json')
  fs.writeFileSync(record, JSON.stringify({ ...JSON.parse(fs.readFileSync(record, 'utf8')), closedAt: '2026-09-29T12:00:00.000Z', abandonedAt: '2026-09-29T12:00:00.000Z' }, null, 2) + '\n')
  t.after(() => fs.rmSync(copy, { recursive: true, force: true }))
}

test('a work open in one root and closed in another is named as held by both, not as a leftover', (t) => {
  openInSecond(t, 'moved-open')
  const out = strip(rig(['doctor']).out)
  assert.match(out, /moved-open: data roots hugoforte, personal each hold its record — delete the copy that is wrong/)
  assert.doesNotMatch(out, /moved-open: abandoned/)
})

test('tidy leaves the folder of a work that is open in another root', (t) => {
  openInSecond(t, 'moved-tidy')
  const r = rig(['tidy'])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(workRoot, 'moved-tidy')), 'the open work keeps its folder')
})

test('close on the closed copy refuses, naming the root that holds the open one', (t) => {
  openInSecond(t, 'moved-close')
  const r = rig(['close', '--work', 'moved-close', '--data', 'hugoforte', '--force'])
  assert.equal(r.code, 1, r.out)
  assert.match(strip(r.out), /data root "personal" holds a record of moved-close that does not say it is closed/)
  assert.ok(fs.existsSync(path.join(workRoot, 'moved-close')), 'the open work keeps its folder')
})
