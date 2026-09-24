// The one-command install: install.ps1 and install.sh, each run for real. The clone source
// is a git repo in a temp directory, so nothing here reaches GitHub, and `npm_config_prefix`
// points the global install at a temp prefix of its own — without that these tests would
// replace whatever rig the machine actually uses.
//
// Two tests per script, in order: the first installs, the second re-runs over what the first
// left behind.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const WINDOWS = process.platform === 'win32'

// Forward slashes in every path handed to bash: bash is the shell on the Windows leg of the
// matrix too, and it re-reads the Windows command line with a backslash as an escape, so
// `C:\Users\…` would arrive as `C:Users…`.
const slash = p => p.replace(/\\/g, '/')

// The shells the scripts are written for, or the reason to skip the test that needs one.
const answers = (command, args) => spawnSync(command, args, { encoding: 'utf8' }).status === 0
const POWERSHELL = ['pwsh', 'powershell'].find(s => answers(s, ['-NoProfile', '-Command', 'exit 0']))

// A bash that can open this checkout by the path these tests hand it. On a Windows machine
// with WSL, `bash` on PATH is WSL's, and WSL has a filesystem of its own where `C:/…` is
// nothing; Git for Windows ships the bash that can, beside `git.exe`, and that is the bash a
// person installing rig on Windows would use.
const gitBash = () => {
  const core = spawnSync('git', ['--exec-path'], { encoding: 'utf8' }).stdout?.trim()
  return core && path.resolve(core, '..', '..', '..', 'bin', 'bash.exe')
}
const BASH = ['bash', ...(WINDOWS ? [gitBash()] : [])]
  .filter(Boolean)
  .find(b => answers(b, ['-c', 'test -f "$1/package.json"', 'bash', slash(ROOT)]))

let tmp, source, env
const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
const head = dir => git(dir, 'rev-parse', 'HEAD').stdout.trim()

// The PATH the scripts are handed: a machine with a node but no rig, which is the machine
// they are for.
//
// Without a rig, because any rig already installed would answer the script's last line
// instead of the one it just installed, and the developer running these tests has one. What
// is left is the interesting case: the fresh prefix is not on PATH either, so the script has
// to find the bin it made for itself.
//
// Without a version manager either, and with the real node directory first. nvm for Windows'
// `nvm.exe` puts up a modal dialog and waits for a click when it is run without a console,
// which is exactly how a spawned test would run it, and `C:\ProgramData\nvm` sits ahead of
// `C:\Program Files\nodejs` on a normal machine. Dropping every directory that holds an `nvm`
// command puts it out of reach however it were to be found. The scripts themselves call plain
// `npm`, as a person would: the isolation belongs here, not in what ships.
const holds = (dir, ...names) => names.some(f => fs.existsSync(path.join(dir, f)))
const PATH_FOR_SCRIPTS = [path.dirname(process.execPath), ...(process.env.PATH ?? '').split(path.delimiter)]
  .filter(d => d && !holds(d, 'rig', 'rig.cmd', 'rig.ps1') && !holds(d, 'nvm', 'nvm.exe', 'nvm.cmd', 'nvm.ps1'))
  .join(path.delimiter)

// A run of one script, against a global prefix of its own: `npm_config_prefix` is what keeps
// `npm install -g` away from the rig this machine actually uses.
const install = (script, target, prefix) => {
  const e = { ...env, npm_config_prefix: prefix }
  for (const k of Object.keys(e)) if (k.toLowerCase() === 'path') delete e[k]
  e.PATH = PATH_FOR_SCRIPTS
  const r = script === 'install.sh'
    ? spawnSync(BASH, [slash(path.join(ROOT, script)), slash(target)], { encoding: 'utf8', env: e })
    : spawnSync(POWERSHELL, ['-NoProfile', '-File', path.join(ROOT, script), target], { encoding: 'utf8', env: e })
  return { code: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') }
}

// Where `npm install -g` puts the package, under a prefix of our choosing.
const installedPackage = prefix =>
  path.join(prefix, WINDOWS ? 'node_modules' : path.join('lib', 'node_modules'), 'rig')

const place = name => ({ target: path.join(tmp, `${name}-checkout`), prefix: fs.mkdtempSync(path.join(tmp, `${name}-prefix-`)) })
let sh, ps

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-install-script-'))
  env = { ...process.env }
  env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig')
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = 'rig install script test'
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = 'install@example.invalid'

  // The clone source: this tool, as much of it as `npm install -g` and `rig help` need.
  source = path.join(tmp, 'source')
  for (const d of ['bin', 'prompts', 'templates', 'skills']) fs.cpSync(path.join(ROOT, d), path.join(source, d), { recursive: true })
  for (const f of ['package.json', '.gitignore']) fs.cpSync(path.join(ROOT, f), path.join(source, f))
  assert.equal(git(tmp, 'init', '-q', '-b', 'main', source).status, 0)
  assert.equal(git(source, 'add', '-A').status, 0)
  assert.equal(git(source, 'commit', '-q', '-m', 'the tool').status, 0)
  env.RIG_INSTALL_SOURCE = source

  sh = place('sh')
  ps = place('ps')
})

after(() => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) })

for (const [script, where, skip] of [
  ['install.sh', () => sh, BASH ? false : 'no bash that can open this checkout'],
  ['install.ps1', () => ps, POWERSHELL ? false : 'neither pwsh nor powershell on PATH'],
]) {
  test(`${script} clones the tool, installs it globally, and ends in a rig that answers`, { skip }, () => {
    const { target, prefix } = where()
    const r = install(script, target, prefix)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /is not on your PATH/, 'it says the global bin is not somewhere the shell looks')
    assert.match(r.out, /cross-repo work harness/, 'and the `rig help` it ends with ran anyway')
    assert.equal(fs.realpathSync(installedPackage(prefix)), fs.realpathSync(target),
      'the global command is a link to the checkout it just made')
    assert.ok(fs.existsSync(path.join(target, 'skills', 'rig', 'SKILL.md')),
      'the agent skills arrived with the checkout, for whatever links them into an agent host')
  })

  test(`${script} run again over a checkout fetches nothing and resets nothing`, { skip }, () => {
    const { target, prefix } = where()
    // The source moves on and the checkout picks up an edit of its own. A re-run that fetched
    // or reset would lose one or the other.
    fs.writeFileSync(path.join(source, 'NOTES.md'), `a commit made after ${script} ran\n`)
    assert.equal(git(source, 'add', '-A').status, 0)
    assert.equal(git(source, 'commit', '-q', '-m', 'the source moved on').status, 0)
    const was = head(target)
    fs.writeFileSync(path.join(target, 'MINE.md'), 'an edit of my own\n')

    const r = install(script, target, prefix)
    assert.equal(r.code, 0, r.out)
    assert.match(r.out, /leaving it exactly as it is/)
    assert.equal(head(target), was, 'nothing was fetched')
    assert.ok(fs.existsSync(path.join(target, 'MINE.md')), 'and nothing was reset')
  })
}
