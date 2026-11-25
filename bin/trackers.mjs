// Which tracker holds a ticket, and how rig speaks to each kind of tracker.
//
// A key's shape cannot say where it lives: `ABC-123` is a Jira key and a Linear key alike, and
// reading it as Jira's sent a Linear ticket to twg. The org's tracker in rig.json says, so
// routing reads that. Only `owner/repo#n` names its tracker itself, because it names the repo.
//
// The kinds rig.json can name, and what each holds:
//   github  { repo }      owner/repo#n keys, any repo
//   jira    { project }   PROJ-123 keys; `project` is the prefix it claims and the one it creates in
//   linear  { team }      ABC-123 keys; `team` is optional for comments, needed to create
//   none                  nothing: a ticket rig cannot tell is passed over in one line
//
// Each provider answers the same questions (comment on a ticket, read one, and for GitHub
// close one) over the adapter its module holds: bin/github.mjs, bin/jira.mjs, bin/linear.mjs.
// Everything a provider throws for a tracker reason is a TrackerError.
import { TrackerError } from './errors.mjs'

// Ticket keys: `PROJ-42`, held by Jira and Linear alike, or GitHub's `owner/repo#n`. Only the
// first is safe in a branch name.
export const isProjectKey = k => /^[A-Z][A-Z0-9]+-\d+$/.test(k)
export const isGithubKey = k => /^[\w.-]+\/[\w.-]+#\d+$/.test(k)

// The kinds whose tickets are `PROJ-123`-shaped.
const PROJECT_KINDS = ['jira', 'linear']
const prefixOf = t => (t.kind === 'jira' ? t.project : t.kind === 'linear' ? t.team : null)

// The tracker that holds `key`, from rig.json's `tracker` map and the orgs the ticket's work
// belongs to:
//   { kind: 'github' }                         an owner/repo#n key
//   { kind: 'jira' | 'linear', org, config }    the tracker that holds it
//   { kind: 'none' | 'ambiguous' | 'unknown', reason }   nothing to tell, and why
//
// A `PROJ-123` key goes, in order:
//   1. to the org whose tracker claims its prefix (a Jira `project`, a Linear `team`), whichever
//      orgs the work has; where two kinds claim it, to the claim the work's own org makes;
//   2. to the one kind of tracker the work's orgs keep;
//   3. when they keep none, to the one kind the data root keeps, which is where `rig new --key`
//      fetched it from before the work had repos.
// Two kinds that could hold it are not guessed between.
export function trackerOfKey (trackers, key, orgs) {
  if (isGithubKey(key)) return { kind: 'github' }
  if (!isProjectKey(key)) return { kind: 'unknown', reason: `"${key}" is neither PROJ-123 nor owner/repo#n` }
  const prefix = key.slice(0, key.indexOf('-'))
  const entries = Object.entries(trackers || {}).filter(([, t]) => t && PROJECT_KINDS.includes(t.kind))
  const inWork = ([org]) => orgs.includes(org)
  const kindsOf = held => [...new Set(held.map(([, t]) => t.kind))]
  const who = held => held.map(([org, t]) => `${org} (${t.kind})`).join(' and ')
  const route = ([org, config]) => ({ kind: config.kind, org, config })

  let claims = entries.filter(([, t]) => prefixOf(t) === prefix)
  if (kindsOf(claims).length > 1 && kindsOf(claims.filter(inWork)).length === 1) claims = claims.filter(inWork)
  if (claims.length) {
    return kindsOf(claims).length === 1 ? route(claims[0])
      : { kind: 'ambiguous', reason: `${who(claims)} both claim ${prefix}; give the work a repo in one of those orgs, or the prefix to one of them only` }
  }
  for (const held of [entries.filter(inWork), entries]) {
    const kinds = kindsOf(held)
    if (kinds.length === 1) return route(held[0])
    if (kinds.length > 1) return { kind: 'ambiguous', reason: `${who(held)} could each hold it; give one of them "${prefix}" as its project or team in rig.json` }
  }
  const kept = orgs.length ? orgs.map(org => `${org}: ${trackers?.[org]?.kind || 'no tracker'}`).join(', ') : 'no org'
  return { kind: 'none', reason: `no tracker in rig.json holds it (${kept})` }
}

// One provider per kind, each over a getter for its adapter, so an adapter is only made for a
// tracker some ticket is actually in. `closes` says whether rig closes the tracker's tickets
// itself; `footer` is the line added where it does not.
export function providers ({ github, jira, linear }) {
  // twg is how rig reaches Jira, and the one tool a Jira org needs on PATH. Asked once per
  // run, and said as what to do, since "spawnSync twg ENOENT" names neither Jira nor the fix.
  let twgPresent
  const twg = (org, key) => {
    twgPresent ??= jira().present()
    if (!twgPresent) {
      throw new TrackerError(`Jira is reached through twg, and twg is not on PATH: install it, or set ${org || 'the org'}'s tracker in rig.json to the one that holds ${key}`)
    }
    return jira()
  }
  const repoOf = key => { const [repo, n] = key.split('#'); return { repo, n } }
  return {
    github: {
      label: 'GitHub',
      closes: true,
      comment: (key, body) => { const { repo, n } = repoOf(key); github().commentIssue(repo, n, body) },
      close: key => { const { repo, n } = repoOf(key); github().closeIssue(repo, n) },
    },
    jira: {
      label: 'Jira',
      closes: false,
      footer: 'rig does not transition Jira tickets — move this one yourself.',
      comment: (key, body, route) => twg(route?.org, key).commentIssue(key, body),
      getIssue: (key, route) => twg(route?.org, key).getIssue(key),
    },
    linear: {
      label: 'Linear',
      closes: false,
      footer: 'rig does not move Linear issues: move this one yourself.',
      comment: (key, body) => linear().commentIssue(key, body),
      getIssue: key => linear().getIssue(key),
    },
  }
}
