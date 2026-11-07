// An invented pull request big enough to want a reading page: a made-up tide-gauge service whose
// retries start surviving a restart. Real git in a temp directory, so citations are checked
// against real commits. `page.md` beside it, under `test/fixtures/pr-page/`, is the page's source.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const PAGE_SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pr-page', 'page.md')
export const PR_URL = 'https://github.com/example-harbour/tidewatch/pull/41'

const lines = (...l) => `${l.join('\n')}\n`

const stations = Array.from({ length: 22 }, (_, i) => `station-${String(i + 1).padStart(2, '0')}`)
const stationFile = (name, extra = []) => lines(`name = "${name}"`, 'poll_seconds = 30', ...extra)

const BASE = {
  'README.md': lines('# Tidewatch', '', 'Reads tide gauges and alerts harbour staff.'),
  'tidewatch/clock.py': lines('import time', '', 'def now():', '    return time.time()'),
  'tidewatch/retry_timer.py': lines('# The fixed wait between retries.', '', 'INTERVAL = 60'),
  'tidewatch/queue.py': lines(
    '# Holds readings that could not be sent yet.',
    '',
    'class RetryQueue:',
    '',
    '    def __init__(self):',
    '        self.waiting = []',
    '',
    '    def enqueue(self, reading):',
    '        self.waiting.append(reading)',
  ),
  'tidewatch/gauge.py': lines(
    'class GaugeReader:',
    '',
    '    def __init__(self, queue):',
    '        self.queue = queue',
    '',
    '    def poll(self, station):',
    '        if not send(station.read()):',
    '            self.queue.enqueue(station.read())',
  ),
  'docs/operations.md': lines('# Operations', '', 'How Tidewatch runs.', '', '## Restarting', '', 'Readings waiting to send are lost on a restart.'),
  'tests/test_queue.py': lines('from tidewatch.queue import RetryQueue', '', 'def test_enqueue_holds():', '    assert RetryQueue().waiting == []'),
}
for (const s of stations) BASE[`stations/${s}.toml`] = stationFile(s)

const HEAD = {
  'README.md': lines('# Tidewatch', '', 'Reads tide gauges and alerts harbour staff. Readings waiting to send survive a restart.'),
  'tidewatch/queue.py': lines(
    '# Holds readings that could not be sent yet, written down so that a restart loses none.',
    '',
    'class RetryQueue:',
    '',
    '    def __init__(self, journal, clock):',
    '        self.journal = journal',
    '        self.clock = clock',
    '        self.attempts = {}',
    '        self.waiting = self.journal.replay()',
    '',
    '    # The journal first, then memory: see the journal-first decision.',
    '    def enqueue(self, reading):',
    '        self.journal.append(reading)',
    '        self.waiting.append(reading)',
    '',
    '    # Doubling, from thirty seconds, up to ten minutes.',
    '',
    '    def next_delay(self, reading):',
    '        return min(30 * 2 ** self.attempts.get(reading.id, 0), 600)',
  ),
  'tidewatch/journal.py': lines(
    '# One line a reading, appended and synced.',
    'import os',
    '',
    'class Journal:',
    '',
    '    def __init__(self, path):',
    '        self.path = path',
    '',
    '    def append(self, reading):',
    '        with open(self.path, "a") as f:',
    '            f.write(reading.to_line() + "\\n")',
    '            f.flush()',
    '            os.fsync(f.fileno())',
    '',
    '    def replay(self):',
    '        return [parse(line) for line in open(self.path) if line.endswith("\\n")]',
  ),
  'tidewatch/gauge.py': lines(
    'class GaugeReader:',
    '',
    '    def __init__(self, queue):',
    '        self.queue = queue',
    '',
    '    def poll(self, station):',
    '        if not send(station.read()):',
    '            self.queue.enqueue(station.read(), limit=station.retry_limit)',
  ),
  'docs/operations.md': lines(
    '# Operations',
    '',
    'How Tidewatch runs.',
    '',
    '## Restarting',
    '',
    'Readings waiting to send are replayed from the journal on a restart. See [the journal](#the-journal).',
    '',
    '## The journal',
    '',
    'A flat file beside the service. Delete it only with the service stopped.',
    '',
    '- One line a reading',
    '- Cleared as each send succeeds',
    '',
    '```text',
    '{{not a citation}} in a code fence',
    '```',
    '',
    'A template word such as {{FIELD}} in the prose of a doc is only text.',
  ),
  'tests/test_queue.py': lines(
    'from tidewatch.queue import RetryQueue',
    '',
    '# A restart must carry on where it stopped.',
    'def test_restart_replays(journal, clock):',
    '    journal.append(reading())',
    '    assert RetryQueue(journal, clock).waiting == [reading()]',
  ),
  'tests/test_journal.py': lines(
    'from tidewatch.journal import Journal',
    '',
    '# A line cut short by a crash is skipped.',
    'def test_torn_line(tmp_path):',
    '    (tmp_path / "j").write_text("whole\\ntorn")',
    '    assert Journal(tmp_path / "j").replay() == ["whole"]',
  ),
}
for (const s of stations) HEAD[`stations/${s}.toml`] = stationFile(s, ['retry_limit = 5'])

const REMOVED = ['tidewatch/retry_timer.py']

// Base and head as commits in a temp repo, `main` and `feat/retries`. `clean()` removes it.
export function prRepo ({ head = HEAD, removed = REMOVED } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rig-pr-page-'))
  const env = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: path.join(dir, '.gitconfig-none'),
    GIT_AUTHOR_NAME: 'Fixture',
    GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Fixture',
    GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
  }
  const repo = path.join(dir, 'repo')
  fs.mkdirSync(repo)
  const git = (...args) => {
    const r = spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', env })
    if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`)
    return r.stdout.trim()
  }
  const write = files => {
    for (const [name, text] of Object.entries(files)) {
      const file = path.join(repo, name)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, text)
    }
  }
  git('init', '-q', '-b', 'main')
  git('remote', 'add', 'origin', 'https://github.com/example-harbour/tidewatch.git')
  write(BASE)
  git('add', '-A')
  git('commit', '-qm', 'Tidewatch as it stood')
  const baseSha = git('rev-parse', 'HEAD')
  git('checkout', '-qb', 'feat/retries')
  write(head)
  for (const name of removed) fs.rmSync(path.join(repo, name))
  git('add', '-A')
  git('commit', '-qm', 'Retries that survive a restart')
  return {
    repo,
    baseSha,
    headSha: git('rev-parse', 'HEAD'),
    clean: () => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 }),
  }
}

// A pull request of documents alone, on the same base: the other shape a page has to serve.
export const DOCS_ONLY = { head: { 'docs/operations.md': HEAD['docs/operations.md'] }, removed: [] }
