// Versioning and record-format migrations.
//
// One semver, and `major` means one thing: the shape of the records in the data root
// (`work.json`, catalogue frontmatter, `rig.json`). `minor` is everything else, bumped by
// hand as a label for humans. Major is *derived* — it is the number of migrations — because
// a forgotten major bump means silently writing a record neither version can read, and that
// is not a thing to leave to memory: the format cannot change without a migration being
// added here, and adding one moves the major. See docs/adr/0002-version-major-is-the-record-format.md.
//
// Migrations are record-only and idempotent. Each transforms files in the data root and
// never touches a worktree, which is why a work in progress survives one.

export const MIGRATIONS = [
  {
    name: 'stamp the data root with the version that wrote it',
    // Additive on purpose. This is the one major bump the write gate cannot protect: a rig
    // from before this check has never heard of `writtenBy`, so when the first machine
    // migrates, the second does not refuse — that code is not in it. Adding a key and
    // changing nothing else means the old rig reads a field it ignores and stays correct.
    config: (cfg, version) => ({ ...cfg, writtenBy: version }),
  },
]

export const MAJOR = MIGRATIONS.length

// `package.json` carries the whole version for anyone reading the file, but only its minor
// and patch are believed here; a test asserts the two agree on the major.
export function toolVersion (pkg = {}) {
  const [, minor = '0', patch = '0'] = String(pkg.version || '0.0.0').split('.')
  return `${MAJOR}.${minor}.${patch}`
}

export const majorOf = version => Number(String(version ?? '0').split('.')[0]) || 0

// The record format the data root is in: what the last rig to write it stamped, or 0 for a
// data root written before stamping existed.
export const dataMajor = repoConfig => majorOf(repoConfig?.writtenBy)

export const pendingMigrations = repoConfig => MIGRATIONS.slice(dataMajor(repoConfig))

// True when this rig must not write to that data root: its records are in a format this
// version has never seen. Reading a newer record with an older rig is harmless — writing
// one is how a record becomes unreadable by both.
export const writesBlocked = repoConfig => dataMajor(repoConfig) > MAJOR

// Runs every pending migration over `rig.json`, returning the new config and the names of
// what ran. Idempotent: on a data root already at this major, nothing runs.
export function applyMigrations (repoConfig, version) {
  const ran = []
  let cfg = repoConfig
  for (const m of pendingMigrations(repoConfig)) {
    if (m.config) cfg = m.config(cfg, version)
    ran.push(m.name)
  }
  return { config: cfg, ran }
}
