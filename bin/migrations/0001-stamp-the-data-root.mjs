// No hook: the format change *is* that the format is now recorded, and the stamp is written by
// `applyMigrations` for every migration rather than by this one. Additive on purpose. This is
// the one major bump the write refusal cannot protect: a rig from before this check has never
// heard of `writtenBy`, so when the first machine migrates, the second does not refuse — that
// code is not in it. Adding a key and changing nothing else means the old rig reads a field it
// ignores and stays correct.

export default {
  name: 'stamp the data root with the version that wrote it',
}
