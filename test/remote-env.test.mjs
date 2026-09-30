// What every git call rig makes to a remote runs with, asked of real git: the variables are
// only worth carrying if git reads them the way decisions 138 and 156 say it does.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { NO_PROMPT_ENV, signIn } from '../bin/remote-env.mjs'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-remote-env-'))
after(() => fs.rmSync(tmp, { recursive: true, force: true }))

// An askpass that answers, and leaves a mark when it is run.
const marker = path.join(tmp, 'askpass-ran')
const askpass = path.join(tmp, 'askpass.sh')
fs.writeFileSync(askpass, `#!/bin/sh\necho ran > '${marker.replace(/\\/g, '/')}'\necho secret\n`, { mode: 0o755 })
const askpassPath = askpass.replace(/\\/g, '/')

// `git credential fill` with no helper asks for a username the way a fetch or push would. The
// shell's own askpass variables are dropped first: an editor's terminal sets `GIT_ASKPASS`,
// which would answer in place of this one.
const fill = env => {
  const { GIT_ASKPASS: _editor, SSH_ASKPASS_REQUIRE: _ssh, ...shell } = process.env
  return spawnSync('git', ['-c', 'credential.helper=', '-c', `core.askPass=${askpassPath}`, 'credential', 'fill'], {
    input: 'protocol=https\nhost=example.invalid\n\n',
    encoding: 'utf8',
    env: { ...shell, SSH_ASKPASS: askpassPath, ...env },
  })
}

test('an askpass that is configured is never run, and git says so in the words the hint knows', () => {
  fs.rmSync(marker, { force: true })
  const r = fill(NO_PROMPT_ENV)
  assert.notEqual(r.status, 0, r.stdout)
  assert.equal(fs.existsSync(marker), false, 'neither core.askPass nor SSH_ASKPASS was run')
  assert.match(signIn(r.stderr), /gh auth setup-git/)
})

test('and without the variables the same askpass would have answered', () => {
  // The control: proves the script runs at all here, so the test above is not passing on a
  // machine where it never could have.
  fs.rmSync(marker, { force: true })
  const r = fill({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' })
  assert.equal(r.status, 0, r.stderr)
  assert.equal(fs.existsSync(marker), true)
})

test('ssh, started by git for a remote, is told never to start an askpass of its own', () => {
  // A stand-in for ssh that writes down what it was told and refuses, as ssh would without a key.
  const told = path.join(tmp, 'ssh-told')
  const ssh = path.join(tmp, 'ssh.sh')
  fs.writeFileSync(ssh, `#!/bin/sh\necho "$SSH_ASKPASS_REQUIRE" > '${told.replace(/\\/g, '/')}'\nexit 1\n`, { mode: 0o755 })
  spawnSync('git', ['ls-remote', 'ssh://git@example.invalid/acme/repo.git'], {
    encoding: 'utf8',
    env: { ...process.env, ...NO_PROMPT_ENV, GIT_SSH_COMMAND: `sh '${ssh.replace(/\\/g, '/')}'` },
  })
  assert.equal(fs.readFileSync(told, 'utf8').trim(), 'never')
})

test('an ssh key ssh could not use without asking is named, with how to give it one', () => {
  assert.match(signIn('git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.'),
    /rig never waits at a prompt: load the key into an agent with `ssh-add`/)
})

test('a host ssh has never seen is named, with how to accept its key', () => {
  assert.match(signIn('Host key verification failed.\nfatal: Could not read from remote repository.'),
    /rig never waits at a prompt: accept the host's key once with `ssh -T git@<host>`/)
})

test('any other failure gets no hint', () => {
  assert.equal(signIn('fatal: repository not found'), '')
})
