// The two config files and the location they are read from.
//
// Everything here is a decision about files in a temp directory — no git, no subprocess — so
// the rules that used to be spread across `config()`, `init` and `doctor` in bin/rig.mjs can
// be asserted directly: which key belongs to which file, what an absent file means as against
// an empty one, and where a relative `dataRoot` resolves against.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  LOCAL_CONFIG_ENV, locate, withDataRoot, load, readOrg, writeMachine, writeOrg, strayOrgKeys,
  sameDir, insideDir,
} from '../bin/roots.mjs'
import { DEFAULT_FRESHNESS } from '../bin/freshness.mjs'

// A tool checkout and a data root beside it, with whatever each file is meant to say already
// in place. `body` gets the paths; the temp directory goes away afterwards either way.
const fixture = ({ machine, org, dataRoot = 'rig-data', env = {} } = {}, body) => {
  const tmp = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'rig-roots-')))
  try {
    const toolRoot = path.join(tmp, 'rig')
    const dataDir = path.isAbsolute(dataRoot) ? dataRoot : path.join(tmp, dataRoot)
    fs.mkdirSync(toolRoot, { recursive: true })
    fs.mkdirSync(dataDir, { recursive: true })
    if (machine) fs.writeFileSync(path.join(toolRoot, 'rig.local.json'), JSON.stringify(machine))
    if (org) fs.writeFileSync(path.join(dataDir, 'rig.json'), JSON.stringify(org))
    body({ tmp, toolRoot, dataDir, location: locate(toolRoot, env) })
  } finally { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) }
}

test('with no machine file at all, the data root is the tool checkout — and that is not split', () => {
  fixture({}, ({ toolRoot, location }) => {
    assert.equal(location.dataRoot, toolRoot)
    assert.equal(location.localFile, path.join(toolRoot, 'rig.local.json'))
    assert.equal(location.orgFile, path.join(toolRoot, 'rig.json'))
    assert.equal(location.split, false)
  })
})

test('the data root named in the machine file is where rig.json is looked for', () => {
  fixture({}, ({ tmp, toolRoot }) => {
    const dataDir = path.join(tmp, 'rig-data')
    fs.writeFileSync(path.join(toolRoot, 'rig.local.json'), JSON.stringify({ dataRoot: dataDir }))
    const location = locate(toolRoot)
    assert.equal(location.dataRoot, dataDir)
    assert.equal(location.orgFile, path.join(dataDir, 'rig.json'))
    assert.equal(location.split, true)
  })
})

test('a relative dataRoot resolves against the machine file, not the current directory', () => {
  fixture({ machine: { dataRoot: '../rig-data' } }, ({ tmp, location }) => {
    assert.equal(location.dataRoot, path.join(tmp, 'rig-data'))
  })
})

test('a data root inside the tool checkout is not split — knowledge must not live there', () => {
  fixture({ machine: { dataRoot: './data' } }, ({ toolRoot, location }) => {
    assert.equal(location.dataRoot, path.join(toolRoot, 'data'))
    assert.equal(location.split, false)
  })
})

test(`${LOCAL_CONFIG_ENV} moves the machine file without moving the tool`, () => {
  fixture({}, ({ tmp, toolRoot }) => {
    const elsewhere = path.join(tmp, 'elsewhere', 'rig.local.json')
    fs.mkdirSync(path.dirname(elsewhere), { recursive: true })
    fs.writeFileSync(elsewhere, JSON.stringify({ workRoot: path.join(tmp, 'w'), dataRoot: '../rig-data' }))
    const location = locate(toolRoot, { [LOCAL_CONFIG_ENV]: elsewhere })
    assert.equal(location.toolRoot, toolRoot, 'the tool is still measured where the code runs from')
    assert.equal(location.localFile, elsewhere)
    assert.equal(location.dataRoot, path.join(tmp, 'rig-data'), 'relative to the file that named it')
    assert.equal(load(location).workRoot, path.join(tmp, 'w'))
  })
})

test('withDataRoot moves the data root and everything under it, and re-answers split', () => {
  fixture({}, ({ tmp, toolRoot, location }) => {
    const moved = withDataRoot(location, path.join(tmp, 'rig-data'))
    assert.equal(moved.orgFile, path.join(tmp, 'rig-data', 'rig.json'))
    assert.equal(moved.split, true)
    assert.equal(moved.localFile, location.localFile, 'the machine file does not move with it')
    assert.equal(withDataRoot(location, toolRoot).split, false)
  })
})

test('the merged config is the org half with the machine half over it', () => {
  fixture({
    machine: { dataRoot: '../rig-data', workRoot: 'W', identities: { acme: 'me@acme.example' } },
    org: { orgs: ['acme'], tracker: { acme: { kind: 'none' } } },
  }, ({ dataDir, location }) => {
    const cfg = load(location)
    assert.deepEqual(cfg.orgs, ['acme'])
    assert.deepEqual(cfg.tracker, { acme: { kind: 'none' } })
    assert.deepEqual(cfg.identities, { acme: 'me@acme.example' })
    assert.equal(cfg.workRoot, 'W')
    assert.equal(cfg.dataRoot, dataDir, 'resolved, not the relative form the file used')
  })
})

test('orgs, tracker and the record stamp in the machine file are ignored, never shadowing rig.json', () => {
  fixture({
    machine: { dataRoot: '../rig-data', orgs: ['stale'], tracker: { stale: { kind: 'jira' } }, writtenBy: '9.9.9' },
    org: { orgs: ['acme'], tracker: { acme: { kind: 'none' } }, writtenBy: '1.0.0' },
  }, ({ location }) => {
    const cfg = load(location)
    assert.deepEqual(cfg.orgs, ['acme'])
    assert.deepEqual(cfg.tracker, { acme: { kind: 'none' } })
    assert.equal(cfg.writtenBy, '1.0.0')
  })
})

test('those are the keys doctor reports as stray, and freshness is not one of them', () => {
  fixture({
    machine: { dataRoot: '../rig-data', orgs: [], tracker: {}, freshness: { enabled: false } },
  }, ({ location }) => {
    assert.deepEqual(strayOrgKeys(location), ['orgs', 'tracker'])
  })
})

test('a machine file that keeps to its own half is stray nothing', () => {
  fixture({ machine: { workRoot: 'W', identities: {}, secrets: {} } }, ({ location }) => {
    assert.deepEqual(strayOrgKeys(location), [])
  })
})

test('freshness merges key by key: the policy travels, the machine overrides one of it', () => {
  fixture({
    machine: { dataRoot: '../rig-data', freshness: { enabled: false } },
    org: { freshness: { everyHours: 6 } },
  }, ({ location }) => {
    assert.deepEqual(load(location).freshness, { enabled: false, everyHours: 6 })
  })
})

test('an interval that is not a positive number is corrected to the default, not believed', () => {
  fixture({ machine: { dataRoot: '../rig-data', freshness: { everyHours: 'soon' } } }, ({ location }) => {
    assert.equal(load(location).freshness.everyHours, DEFAULT_FRESHNESS.everyHours)
  })
})

test('the mirror root defaults under the work root, and is overridable', () => {
  fixture({ machine: { workRoot: path.join('W', 'root') } }, ({ location }) => {
    assert.equal(load(location).mirrorRoot, path.join('W', 'root', '.mirrors'))
  })
  fixture({ machine: { workRoot: 'W', mirrorRoot: 'M' } }, ({ location }) => {
    assert.equal(load(location).mirrorRoot, 'M')
  })
})

test('with neither file, the config is still usable — that is what makes `rig init` runnable', () => {
  fixture({}, ({ location }) => {
    const cfg = load(location)
    assert.deepEqual(cfg.orgs, [])
    assert.deepEqual(cfg.tracker, {})
    assert.equal(path.basename(cfg.workRoot), 'w')
    assert.deepEqual(cfg.freshness, DEFAULT_FRESHNESS)
  })
})

test('a rig.json that is not there reads as null, which is not the same as one that says nothing', () => {
  fixture({ machine: { dataRoot: '../rig-data' } }, ({ location }) => {
    assert.equal(readOrg(location), null)
  })
  fixture({ machine: { dataRoot: '../rig-data' }, org: {} }, ({ location }) => {
    assert.deepEqual(readOrg(location), {})
  })
})

test('a file that is not valid JSON fails with the file named', () => {
  fixture({}, ({ toolRoot, location }) => {
    fs.writeFileSync(path.join(toolRoot, 'rig.local.json'), '{ nope')
    assert.throws(() => load(location), e => e.message.includes('rig.local.json') && /not valid JSON/.test(e.message))
  })
})

test('the writers hand the editor the file as it is, and null when there is none', () => {
  fixture({ machine: { dataRoot: '../rig-data' } }, ({ location }) => {
    const seen = []
    writeOrg(location, prev => { seen.push(prev); return { orgs: ['acme'] } })
    writeOrg(location, prev => { seen.push(prev); return { ...prev, tracker: {} } })
    assert.deepEqual(seen, [null, { orgs: ['acme'] }])
    assert.deepEqual(readOrg(location), { orgs: ['acme'], tracker: {} })
  })
})

test('writing the machine file creates it, and load reads back what was written', () => {
  fixture({}, ({ tmp, toolRoot }) => {
    const file = path.join(tmp, 'elsewhere', 'rig.local.json')
    const location = locate(toolRoot, { [LOCAL_CONFIG_ENV]: file })
    writeMachine(location, prev => ({ ...prev, workRoot: 'W' }))
    assert.equal(load(locate(toolRoot, { [LOCAL_CONFIG_ENV]: file })).workRoot, 'W',
      'the directory was made on the way, not assumed')
  })
})

test('writing the same content again leaves the file alone, so `git add -A` sees nothing', () => {
  fixture({ machine: { dataRoot: '../rig-data' } }, ({ location }) => {
    writeOrg(location, () => ({ orgs: ['acme'] }))
    const before = fs.statSync(location.orgFile).mtimeMs
    writeOrg(location, prev => ({ ...prev }))
    assert.equal(fs.statSync(location.orgFile).mtimeMs, before)
  })
})

test('a directory is inside itself, and its parent is not inside it', () => {
  fixture({}, ({ tmp, toolRoot }) => {
    assert.equal(insideDir(toolRoot, toolRoot), true)
    assert.equal(insideDir(path.join(toolRoot, 'bin'), toolRoot), true)
    assert.equal(insideDir(tmp, toolRoot), false)
    assert.equal(sameDir(toolRoot, path.join(toolRoot, 'bin', '..')), true)
  })
})

test('a sibling whose name starts the same is not inside', () => {
  fixture({}, ({ tmp, toolRoot }) => {
    assert.equal(insideDir(`${toolRoot}-data`, toolRoot), false, 'rig-data is not inside rig')
    assert.equal(insideDir(path.join(tmp, 'rig-data'), toolRoot), false)
  })
})
