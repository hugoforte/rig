// **Two record changes, one migration, because they shipped together.** The SDLC epic
// (hugoforte/rig#9) moved `work.json` twice — the phase replacing `status`, and stages giving
// every branch its own base and PR — and both landed in one release. A migration is a *format
// someone's data root can be in*, not a changelog of shape edits, and there is no reachable
// format between these two: nothing was ever stamped with it, because the intermediate state
// existed only on a work branch. Two migrations here would claim four formats when only three
// are reachable, and would leave a hole in the published majors where nothing ever lived. So
// they are one, named for both.
//
// No hook, for the reason migration 2 had none and one this repo has to live with: there is no
// mechanism to transform `work/*/work.json` (see `unrunnableHook`), and both changes are
// entirely in that file. So the record moves on the read path, in `loadWork`, losslessly:
//
//   - `status` is dropped and its one meaningful value (`designed`) becomes the `designedAt`
//     gate; the other three were observable facts and `phaseOf` reproduces them exactly.
//   - `repos[].base` and `repos[].pr` become the first entry of `repos[].branches[]`, and
//     `work.stages` defaults to empty — a work with no stages is exactly the work rig modelled
//     before stages existed.
//
// What this migration is *for* is moving the major, and the major is what stops an older rig
// **writing**. Reading the new shape would survive; writing it back would reintroduce `status`
// and drop `branches[]` and `stages[]` on the floor, because an old rig spreads the entry it
// read and knows none of those keys on the way out. Additive on the read side is not enough
// when the write side is lossy, which is precisely what the write refusal is for.

export default {
  name: 'phase replaces status, and stages give every branch its own base and PR',
}
