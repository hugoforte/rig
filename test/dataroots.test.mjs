// More than one data root on one installation.
//
// Two halves, and they are tested in the two places they live. The resolution order is a
// decision about files and an environment, so it is asserted directly against
// `bin/roots.mjs` with no subprocess. `rig use`, the `.rig/data` anchor a work folder
// carries, and the refusal of a work id another root already owns are things the CLI does,
// so those drive the tool.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { locate, registry, load, anchoredRoot, rootsCataloguing, dataAnchorFile, DATA_ROOT_ENV, DEFAULT_ROOT_NAME } from '../bin/roots.mjs'
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

test('a work folder says which root it belongs to, and that beats the current one', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    const work = path.join(tmp, 'w', 'payments-refunds')
    fs.mkdirSync(path.dirname(dataAnchorFile(work)), { recursive: true })
    fs.writeFileSync(dataAnchorFile(work), 'linenmaster\n')
    const location = locate(toolRoot, {}, { cwd: path.join(work, 'billing', 'src') })
    assert.equal(location.name, 'linenmaster', 'resolved from a directory deep inside the work')
    assert.equal(location.source, 'cwd')
  })
})

test('the shell beats the work folder: a pinned shell was pinned on purpose', () => {
  fixture(THREE, ({ tmp, toolRoot }) => {
    const work = path.join(tmp, 'w', 'payments-refunds')
    fs.mkdirSync(path.dirname(dataAnchorFile(work)), { recursive: true })
    fs.writeFileSync(dataAnchorFile(work), 'linenmaster\n')
    assert.equal(locate(toolRoot, { [DATA_ROOT_ENV]: 'personal' }, { cwd: work }).name, 'personal')
  })
})

test('outside any work folder there is no anchor to read', () => {
  fixture(THREE, ({ tmp }) => {
    assert.equal(anchoredRoot(path.join(tmp, 'w')), null)
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

test('the work folder still beats the repo: the work already said where it lives', () => {
  fixture(THREE, ({ tmp, toolRoot, machine }) => {
    catalogue(machine.dataRoots.linenmaster.path, 'acme', 'Payments')
    const work = path.join(tmp, 'w', 'a-work')
    fs.mkdirSync(path.dirname(dataAnchorFile(work)), { recursive: true })
    fs.writeFileSync(dataAnchorFile(work), 'personal\n')
    assert.equal(locate(toolRoot, {}, { cwd: work, repos: ['Payments'] }).name, 'personal')
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

const install = makeInstall({ prefix: 'dataroots-cli-', localConfig: true, github: { issues: {} } })
const { tmp, dataRoot, workRoot, localConfig, rig, gitMust, cleanup } = install
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

test('the work folder records which root holds its record', () => {
  assert.equal(fs.readFileSync(dataAnchorFile(path.join(workRoot, 'only-here')), 'utf8').trim(), 'hugoforte')
})

test('a command run inside a work folder reads that work\'s root, whatever is current', () => {
  assert.equal(rig(['use', 'personal']).code, 0)
  const r = rig(['status'], { cwd: path.join(workRoot, 'only-here') })
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /only-here/, 'the anchor won, and `current` was never consulted')
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
