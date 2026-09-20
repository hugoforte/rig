// No hook, and no transform of any file: the field this adds (`repos[].pr`, a merged PR's
// terminal facts — DESIGN.md decision 60) is optional, and its absence already means "not yet
// known", which is exactly what `rig backfill` looks for. So the migration's only job, like
// migration 1's, is moving the major — a work.json with `pr` on some entries and not others is
// valid on both sides of this bump, so an old rig reading a backfilled record ignores a key it
// does not know and stays correct. Additive is not forced here the way it was on migration 1 —
// every installation refuses to write below its format now (ADR-0002) — it is just what this
// change needs.

export default {
  name: 'allow repos[].pr, the terminal PR facts backfill and close record',
}
