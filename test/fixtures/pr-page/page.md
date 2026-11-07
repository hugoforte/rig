---
title: Retries that survive a restart
start: flow/restart, part/queue, risk/replay, open/backfill
---

Tidewatch reads tide gauges and alerts harbour staff. A reading that fails to send used to wait in memory and vanish on a restart. This PR writes each waiting reading to a [[part/journal|journal]] first, so a restart carries on where it stopped, and it replaces the fixed one-minute wait with a [[word/backoff|backoff]].

# part/queue: The retry queue
group: Sending
status: changed
uses: journal, clock
files: tidewatch/queue.py
aka: RetryQueue, retry queue
sub: Holds what could not be sent yet

The heart of the change. {{tidewatch/queue.py:12 ~ def enqueue}} writes to the journal before it holds anything in memory, and {{tidewatch/queue.py:18 ~ def next_delay}} works out the wait.

It used to hold a plain list, {{base:tidewatch/queue.py:6 ~ self.waiting = []}}, which nothing wrote down. See [[flow/restart]] for what that cost, and [[decision/journal-first]] for the order.

# part/journal: The journal
group: Sending
status: new
files: tidewatch/journal.py
aka: journal, Journal
sub: One line a reading, appended and synced

New in this PR. {{tidewatch/journal.py:9 ~ def append}} syncs before it returns, which is what [[test/crash-mid-append]] holds it to.

# part/clock: The clock
group: Sending
status: unchanged
files: tidewatch/clock.py
sub: The one place time comes from

Unchanged, and named because the queue's backoff reads it, so a test can move it.

# part/gauge: The gauge reader
group: Reading
status: changed
uses: queue
files: tidewatch/gauge.py
aka: GaugeReader
sub: Polls each station

{{tidewatch/gauge.py:8 ~ self.queue.enqueue}} hands a failed send to the [[part/queue]]. The rest of the file only reads the new setting.

# part/stations: Station settings
group: Reading
status: changed
files: stations/station-01.toml, stations/station-02.toml, stations/station-03.toml, stations/station-04.toml, stations/station-05.toml, stations/station-06.toml, stations/station-07.toml, stations/station-08.toml, stations/station-09.toml, stations/station-10.toml, stations/station-11.toml, stations/station-12.toml, stations/station-13.toml, stations/station-14.toml, stations/station-15.toml, stations/station-16.toml, stations/station-17.toml, stations/station-18.toml, stations/station-19.toml, stations/station-20.toml, stations/station-21.toml, stations/station-22.toml
sub: One file a station, each gaining a limit

Mechanical: each station file gains `retry_limit`. Read one and you have read them all.

# part/timer: The retry timer
group: Sending
status: removed
files: tidewatch/retry_timer.py
sub: Gone: the queue keeps its own time

It was the fixed one-minute wait, {{base:tidewatch/retry_timer.py:3 ~ INTERVAL = 60}}.

# flow/restart: A restart with a reading waiting
sub: The bug this PR exists for

@before The reading sat in a list in memory, and a restart lost it. Nobody was told.

@step A send fails
[[part/gauge]] hands the reading to the [[part/queue]].

@step It is written down first
The queue calls [[part/journal]] and only then holds it. See {{tidewatch/queue.py:13 ~ self.journal.append}}.

@step The process restarts
{{tidewatch/queue.py:9 ~ self.journal.replay}} loads what was waiting.

@step The send succeeds
The journal line is cleared.

@after The reading goes out once the network is back, however many restarts came between.

# flow/outage: A long outage at one station
sub: Why the wait grows

@before Every waiting reading retried once a minute, for ever.

@step The sends keep failing
[[word/backoff]] doubles the wait, up to ten minutes.

@step It reaches the limit
At `retry_limit` the reading stops retrying and [[part/gauge]] raises an alert.

@after A dead station costs a few sends an hour, and someone hears of it. [[risk/alert-storm]] is the worry here.

# decision/journal-first: Write the journal before holding in memory
sub: The one order that loses nothing

The queue writes to the journal and then holds the reading. The other order is quicker, and it loses the reading if the process dies between the two steps. A slow disk costs little here, since a reading only reaches the queue after a send has failed.

# decision/no-database: A flat file, not a database
sub: One writer, a few hundred lines at most

Tidewatch has no database today. A flat file needs nothing installed on a station's box, where size < 1 MB & it stays readable.

| Choice | Held by | Needs | Why not |
|---|---|---|---|
| A flat file | `RetryQueueJournalWriter` | `appendOneLineAndFlushToDisk` | Nothing against it here |
| A database | `RetryQueueDatabaseWriter` | `installAndMigrateOnEveryStation` | One writer does not need it |

# test/crash-mid-append: A crash in the middle of an append
sub: tests/test_journal.py

{{tests/test_journal.py:4 ~ def test_torn_line}} cuts a line short and asserts that the replay skips it. It holds [[part/journal]] to its word.

# test/restart: A restart replays what was waiting
sub: tests/test_queue.py

{{tests/test_queue.py:4 ~ def test_restart_replays}} is [[flow/restart]] as a test.

# risk/replay: A reading sent twice
pill: medium
sub: A crash between the send and the clear

The reading goes out again on restart. Harbour staff would see a duplicate, which is better than a gap, and the receiver drops repeats by timestamp.

# risk/alert-storm: Many stations reaching the limit at once
pill: low
sub: A wide outage

Every station alerts within the same ten minutes. [[open/backfill]] would also make this louder.

# open/backfill: What happens to readings already lost?
sub: Not in this PR

Readings lost before this ships stay lost. Whether to backfill from the gauges' own logs is still to be decided.

# word/backoff: Backoff
aka: backoff
sub: Waiting longer after each failure

Doubling the wait after each failed send, from {{tidewatch/queue.py:18 ~ def next_delay}}.

# file/README.md: The one-line mention
A line in the README only.
