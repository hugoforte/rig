// **A catalogue entry says what its repo can do under one `can:` block** (hugoforte/rig#188,
// DESIGN.md decision 109). `check` moved there from the top level, beside `run`, `verify`,
// `deploy` and `provision`, so one ability has one home.
//
// No hook, for the reason migration 3 had none: nothing is transformed. The move happens on
// the read path, in `abilitiesOf`, which still reads a top-level `check:` when `can` has none,
// and no entry is ever rewritten to move it. A migration would rewrite hand-formatted files in
// every data root to save one line of reading, which ADR-0002 says to build only when earned.
//
// What this migration is *for* is moving the major, and the major is what stops an older rig
// **writing**. An older rig would read `can.check` as no check at all, tell whoever asked to
// add a top-level `check:`, and so give one ability a second home. The write refusal is what
// sends it to `rig update` first.

export default {
  name: 'every ability a repo has lives under can:',
}
