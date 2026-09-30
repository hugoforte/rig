// What every git call rig makes to a remote runs with, so that none can stop to ask for
// credentials (decisions 138 and 156): the freshness refresh is detached, and an agent's session
// has nobody at the terminal, so a call that prompts is a process that never returns.
// `GIT_TERMINAL_PROMPT` stops git's own prompt; `GCM_INTERACTIVE` stops Git Credential
// Manager's sign-in window, which the first does not reach. An empty `GIT_ASKPASS` is how git is
// told there is no askpass: git runs the first of `GIT_ASKPASS`, `core.askPass` and
// `SSH_ASKPASS` that is set, and only when it is not empty, so this one shadows the other two.
// `SSH_ASKPASS_REQUIRE=never` keeps ssh from starting one of its own for a passphrase or a host
// key. ssh can still ask on a terminal it can reach, which only `-o BatchMode=yes` would stop,
// and that cannot be added without overriding an ssh command the user chose: a key rig uses
// over ssh is expected to be in an agent. The only symptom of dropping any of these is a hang,
// on a machine whose remote happens to want credentials, so tests assert them.
export const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', GIT_ASKPASS: '', SSH_ASKPASS_REQUIRE: 'never' }

// A call refused for want of credentials, in the words git and Git Credential Manager use for
// it. Those words say only that a prompt was skipped, not that nothing will ever answer one, so
// every place that reports such a failure names the fix with `signIn`.
export const NEEDS_CREDENTIALS = /terminal prompts disabled|could not read (Username|Password)|cannot prompt/i

// ssh's words for the two things it would otherwise have asked about.
const HINTS = [
  [NEEDS_CREDENTIALS, 'git needed credentials, and rig never waits at a prompt: sign git in with `gh auth setup-git`'],
  [/Permission denied \(publickey/i, 'ssh had no key it could use without asking, and rig never waits at a prompt: load the key into an agent with `ssh-add`'],
  [/Host key verification failed/i, "ssh has not seen this host before, and rig never waits at a prompt: accept the host's key once with `ssh -T` to it"],
]
export const signIn = error => {
  const hint = HINTS.find(([words]) => words.test(error || ''))
  return hint ? ` — ${hint[1]}` : ''
}
