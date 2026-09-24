// One throwaway rig installation in a temp directory, for the tests that drive the CLI end
// to end: the tool on disk, the roots it works on, an environment isolated from the machine,
// and the runners the tests drive it with. What only one test file needs stays in that file;
// what they all need lives here.
//
// The call sites differ on how the tool is put on disk and what it may reach, and the
// options carry the differences rather than flattening them:
//
// - test/smoke.test.mjs and test/jira.test.mjs take the default: a copy of the tool with no
//   `.git`, which is what keeps `rig update` and every freshness path off the checkout the
//   tests run from. With `localConfig` smoke's rig.local.json moves out of the copy too, so
//   nothing that suite writes lands beside the tool.
// - test/installation-fixture.mjs wants the opposite, and passes `checkout`: a real clone of
//   the tool from a bare origin in the temp dir, which is the only way the freshness and
//   update paths are reachable at all. The remote is a directory, so no test touches a
//   network.
// - test/attach.test.mjs wants repos to clone, and passes `remotes`: `RIG_FAKE_REMOTES`
//   points at a directory of bare repos the test publishes into, so `bin/worktrees.mjs`
//   resolves a repo to disk instead of github.com.
// - most of them pass `inProcess`, which is about how the tool is *run* rather than how it is
//   put on disk: `rig()` below then calls `bin/rig.mjs`'s `run(argv, io)` here rather than
//   starting a process for it.
//
// GitHub and Jira are the in-memory adapters selected by `RIG_FAKE_GITHUB` and
// `RIG_FAKE_TWG`, each naming a JSON state file the tool reads on start and writes back on
// exit. Pass `github`/`twg` to seed one; read the file back to see what the tool did. The
// real `gh` and `twg` are never spawned.
//
// Below `makeInstall` is what drives an installation through a *sequence* rather than one
// command: `scenario` walks a machine through named steps with nothing restored between
// them, and `previousRelease` puts the tool as the previous release shipped it beside the
// installation, so one machine file can be driven by two versions of rig.
import { test } from 'node:test'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run as runInProcess } from '../bin/rig.mjs'

// The checkout under test — the source every temp installation is built from.
export const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const strip = s => s.replace(/\x1b\[\d+m/g, '')
export const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'))

// Everything a run of the tool needs that is not the tool: the code, the markdown it prints,
// and the package.json it reads its version from.
const copyTool = (dest, { gitignore = false } = {}) => {
  for (const d of ['bin', 'prompts', 'templates']) fs.cpSync(path.join(SRC, d), path.join(dest, d), { recursive: true })
  fs.cpSync(path.join(SRC, 'package.json'), path.join(dest, 'package.json'))
  // The real tool gitignores rig.local.json; without that the machine's own config would read
  // as an uncommitted change and `rig update` would refuse to move a perfectly clean install.
  if (gitignore) fs.cpSync(path.join(SRC, '.gitignore'), path.join(dest, '.gitignore'))
}

export function makeInstall ({
  prefix,
  author = 'rig test',
  email = 'test@example.invalid',
  checkout = false,
  localConfig = false,
  github,
  twg,
  remotes = false,
  inProcess = false,
} = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  const dataRoot = path.join(tmp, 'rig-data')
  const workRoot = path.join(tmp, 'w')

  // The machine's environment, minus every way it could reach into this run. The tool writes
  // `git config --global core.longpaths`, so both git configs are redirected into the temp
  // dir, and the identity comes from the environment — git has no *configured* user.email,
  // which is what the identity checks read.
  const env = { ...process.env }
  for (const key of Object.keys(env)) if (key.startsWith('RIG_')) delete env[key]
  env.GIT_CONFIG_GLOBAL = path.join(tmp, 'gitconfig')
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, '')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = author
  env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = email

  const git = (dir, ...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', env })
  const gitMust = (dir, ...args) => {
    const r = git(dir, ...args)
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} in ${dir}: ${r.stderr || r.error?.message}`)
    return r.stdout.trim()
  }

  let install = path.join(tmp, 'rig')
  let origin
  if (checkout) {
    // The remote everyone clones from, seeded with this tool, and the installation cloned
    // back out of it — an installation git can measure, which a bare copy is not.
    const seed = path.join(tmp, 'seed')
    copyTool(seed, { gitignore: true })
    gitMust(tmp, 'init', '-q', '-b', 'main', seed)
    gitMust(seed, 'add', '-A')
    gitMust(seed, 'commit', '-q', '-m', 'the tool')
    origin = path.join(tmp, 'origin.git')
    gitMust(tmp, 'init', '-q', '--bare', '-b', 'main', origin)
    gitMust(seed, 'push', '-q', origin, 'main')
    install = path.join(tmp, 'install')
    gitMust(tmp, 'clone', '-q', origin, install)
  } else {
    copyTool(install)
  }

  let localConfigFile, githubStateFile, twgStateFile, remotesDir
  if (localConfig) {
    localConfigFile = path.join(tmp, 'rig.local.json')
    env.RIG_LOCAL_CONFIG = localConfigFile
  }
  if (github) {
    githubStateFile = path.join(tmp, 'github.json')
    fs.writeFileSync(githubStateFile, JSON.stringify(github))
    env.RIG_FAKE_GITHUB = githubStateFile
  }
  if (twg) {
    twgStateFile = path.join(tmp, 'twg.json')
    fs.writeFileSync(twgStateFile, JSON.stringify(twg))
    env.RIG_FAKE_TWG = twgStateFile
  }
  if (remotes) {
    remotesDir = path.join(tmp, 'remotes')
    env.RIG_FAKE_REMOTES = remotesDir
  }

  // `out` is both streams, which is what almost every assertion wants. `stdout` is kept apart
  // for the callers that care: `rig list --json` is a pipe, and everything rig says for a
  // human — the freshness line above all — has to stay off it. `root` runs a different copy
  // of the tool than the installation; `env` a different environment than this one.
  // `cwd` is how a test reaches the commands that resolve something from the folder they run
  // in — the work, and the repo `rig stage --cut` makes the branch in. It defaults to the
  // temp directory rather than being inherited, for the same reason every `RIG_` variable is
  // stripped above: rig resolves its data root partly from the folder it runs in, and the
  // suite is itself run from inside a rig work folder often enough that inheriting would let
  // the machine decide what an isolated installation reads.
  //
  // Two adapters behind one signature, and which a call gets is a question about what the
  // test is *for* (DESIGN.md decisions 81 and 99). `bin/rig.mjs` exports `run(argv, io)`, so an
  // invocation is a value this process can produce: the same installation, cwd, environment
  // and stdin a subprocess would have been handed, with the two streams collected instead of
  // piped. What that buys is the ~51ms a Node boot costs on the Windows runner, and rig's
  // module graph on top of it, times the several hundred invocations this suite makes.
  //
  // A test whose subject *is* the process keeps the subprocess, and four kinds of test do:
  // `test/installation-freshness.test.mjs` and `test/installation-update.test.mjs`, which
  // drive the detached freshness refresh, `rig update` re-executing the tool that just
  // arrived, and a crippled PATH; the steps of
  // `test/scenarios.test.mjs` that drive the previous release; `rig check --run`, whose
  // catalogue commands inherit rig's stdio and so reach an assertion only down a pipe; and the
  // CLI's own answers for what a caller leaves out of `run` — its stdin, its `chdir` and its
  // streams — in `test/invocation.test.mjs` and the one brief `test/smoke.test.mjs` pipes in.
  // `inProcess` sets the installation's default and any call may say otherwise.
  //
  // A call naming a different `root` is always a subprocess, whatever it asked for: what it
  // wants is the code on *that* disk — the previous release, or a copy something has edited
  // — and in this process the code is always this checkout's.
  const rig = (args, { input = '', env: envOverride = env, root = install, cwd = tmp, inProcess: here = inProcess } = {}) => {
    if (here && root === install) {
      let stdout = ''
      let stderr = ''
      const code = runInProcess(args, {
        toolRoot: root,
        cwd: cwd || process.cwd(),
        env: envOverride,
        // What `fs.readFileSync(0, 'utf8').trim()` gives the subprocess, given the same input.
        stdin: () => input.trim(),
        out: s => { stdout += s },
        err: s => { stderr += s },
      })
      return { code, out: strip(stdout + stderr), stdout: strip(stdout) }
    }
    const r = spawnSync(process.execPath, [path.join(root, 'bin', 'rig.mjs'), ...args],
      { encoding: 'utf8', env: envOverride, input, ...(cwd ? { cwd } : {}) })
    return { code: r.status, out: strip(r.stdout + r.stderr), stdout: strip(r.stdout) }
  }

  const cleanup = () => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) }

  return {
    tmp, install, origin, dataRoot, workRoot,
    localConfig: localConfigFile, githubStateFile, twgStateFile, remotesDir,
    env, rig, git, gitMust, cleanup,
  }
}

// ---------------------------------------------------------------------------- scenarios

// A journey: one temp machine, walked through a named list of steps in order, with nothing
// restored between them. What a scenario is for is the state that carries forward — the bugs
// it exists to catch are in the *second* command against a machine that already had state,
// and a suite that puts its fixture back around every assertion cannot see one.
//
// A step that fails stops the journey and the rest are skipped naming it: a step run on state
// the previous step failed to produce asserts nothing, and would bury the real failure under
// its own. Each step is a subtest, so the step that died is named by the runner rather than
// having to be read out of an assertion message.
//
// A step is handed the machine `makeInstall` built and its own test context. The machine is
// the state that carries: the temp directory, the roots, the files rig has written into them —
// and anything a step hangs on it for the steps after, which is a path or two, never an
// assertion's worth of derived fact.
export const step = (name, run) => ({ name, run })

// `options` are `makeInstall`'s, plus `skip` for a journey this checkout cannot walk at all —
// the cross-version one, on a clone with no release tags in it.
export function scenario (name, { skip = false, ...install } = {}, steps = []) {
  return test(name, { skip }, async t => {
    const machine = makeInstall(install)
    try {
      let died = null
      for (const s of steps) {
        if (died) {
          await t.test(s.name, { skip: `the journey stopped at "${died}"` }, () => {})
          continue
        }
        let failed = false
        // The throw is re-raised so node:test records the subtest as failed, and caught so
        // the loop — not an exception — decides what happens to the steps after it.
        await t.test(s.name, async st => {
          try { await s.run(machine, st) } catch (e) { failed = true; throw e }
        })
        if (failed) died = s.name
      }
    } finally { machine.cleanup() }
  })
}

// Every release tag in the checkout under test, newest first, and empty when there are none
// to find: a shallow clone carries no tags and a downloaded tarball has no `.git` at all. A
// scenario that cannot be walked says so rather than inventing a release to walk it against.
export function releaseTags () {
  const r = spawnSync('git', ['-C', SRC, 'tag', '--list', 'v[0-9]*', '--sort=-v:refname'], { encoding: 'utf8' })
  if (r.status !== 0) return []
  return r.stdout.split('\n').map(s => s.trim()).filter(Boolean)
}

// The release before this one, skipping a tag that points at the commit this checkout is on —
// on `main` just after a release those are the same commit, and a "previous release" that is
// this code tests nothing. Asked of git rather than of `package.json`, which no longer carries
// a version to compare (ADR 0004); `--exact-match` answers only when HEAD *is* a release.
export function previousReleaseTag () {
  const r = spawnSync('git', ['-C', SRC, 'describe', '--tags', '--exact-match', '--match', 'v[0-9]*'], { encoding: 'utf8' })
  const here = r.status === 0 ? r.stdout.trim() : null
  return releaseTags().find(t => t !== here) ?? null
}

// The tool as the previous release shipped it, beside the installation, for the half of
// cross-version the suite could not express: `test/installation-update.test.mjs` fabricates a
// *newer* rig by pushing a clone that carries an extra migration, and this is the reverse —
// the rig still on PATH, run against a machine file the current code just wrote. That window
// is open on every machine at every release, because the change being installed is the one
// that would have updated it.
//
// A clone rather than a copy, because a tag is the only honest way to say "the previous
// release"; its `.git` goes for the reason `copyTool` leaves one out — a tool checkout git
// can measure would put `rig update` and the freshness paths back in the middle of a
// scenario. Pass it to `rig()` as `root`.
export function previousRelease ({ tmp, gitMust }, tag = previousReleaseTag()) {
  if (!tag) return null
  const root = path.join(tmp, `rig-${tag}`)
  // One checkout per tag per machine: a journey asks for the same release from more than one
  // step, and cloning it again would cost seconds the scenario count is rationed by.
  if (!fs.existsSync(root)) {
    // `--no-hardlinks`, because a local clone links its objects by default and the checkout
    // and the temp directory are not always on one volume — on the Windows runner the repo is
    // on D: and the temp directory on C:, and git dies with "Improper link".
    gitMust(tmp, 'clone', '-q', '--no-hardlinks', SRC, root)
    gitMust(root, 'checkout', '-q', '--detach', tag)
    fs.rmSync(path.join(root, '.git'), { recursive: true, force: true, maxRetries: 5 })
  }
  return { root, tag, version: readJson(path.join(root, 'package.json')).version }
}
