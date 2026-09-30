// What every git call rig makes to a remote runs with, so that none can stop to ask for
// credentials (decision 138): the freshness refresh is detached, and an agent's session has
// nobody at the terminal, so a call that prompts is a process that never returns.
// `GIT_TERMINAL_PROMPT` stops git's own prompt; `GCM_INTERACTIVE` stops Git Credential
// Manager's sign-in window, which the first does not reach. The only symptom of dropping it
// is a hang, on a machine whose remote happens to want credentials, so tests assert it.
export const NO_PROMPT_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' }
