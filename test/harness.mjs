// One throwaway rig installation in a temp directory, for the tests that drive the CLI as a
// subprocess: the tool on disk, the roots it works on, an environment isolated from the
// machine, and the runners the tests drive it with. What only one test file needs stays in
// that file; what they all need lives here.
//
// The call sites differ on how the tool is put on disk and what it may reach, and the
// options carry the differences rather than flattening them:
//
// - test/smoke.test.mjs and test/jira.test.mjs take the default: a copy of the tool with no
//   `.git`, which is what keeps `rig update` and every freshness path off the checkout the
//   tests run from. With `localConfig` smoke's rig.local.json moves out of the copy too, so
//   nothing that suite writes lands beside the tool.
// - test/installation.test.mjs wants the opposite, and passes `checkout`: a real clone of
//   the tool from a bare origin in the temp dir, which is the only way the freshness and
//   update paths are reachable at all. The remote is a directory, so no test touches a
//   network.
// - test/attach.test.mjs wants repos to clone, and passes `remotes`: `RIG_FAKE_REMOTES`
//   points at a directory of bare repos the test publishes into, so `bin/worktrees.mjs`
//   resolves a repo to disk instead of github.com.
//
// GitHub and Jira are the in-memory adapters selected by `RIG_FAKE_GITHUB` and
// `RIG_FAKE_TWG`, each naming a JSON state file the tool reads on start and writes back on
// exit. Pass `github`/`twg` to seed one; read the file back to see what the tool did. The
// real `gh` and `twg` are never spawned.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
  const rig = (args, { input = '', env: envOverride = env, root = install } = {}) => {
    const r = spawnSync(process.execPath, [path.join(root, 'bin', 'rig.mjs'), ...args],
      { encoding: 'utf8', env: envOverride, input })
    return { code: r.status, out: strip(r.stdout + r.stderr), stdout: strip(r.stdout) }
  }

  const cleanup = () => { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5 }) }

  return {
    tmp, install, origin, dataRoot, workRoot,
    localConfig: localConfigFile, githubStateFile, twgStateFile, remotesDir,
    env, rig, git, gitMust, cleanup,
  }
}
