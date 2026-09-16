// The errors rig reports to the user as one line, rather than a stack trace. Everything
// else that escapes is a bug and propagates. `TrackerError` is the branch the tracker
// modules (bin/github.mjs, bin/jira.mjs) throw, so a caller can let one failed tracker
// call degrade to a warning without swallowing a rig bug alongside it.
export class RigError extends Error {}
export class TrackerError extends RigError {}
