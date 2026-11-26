// The chats a work has run in: `rig chat <link>`, `--chat` on `rig new` and `rig restore`, and
// where the record shows them. rig stores each link as it was given and never reads it, so the
// links here are placeholders of two shapes, and nothing asks an agent host anything.
//
// The tests share one installation and run in order; each names the work it starts from.
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { billingInstall } from './billing-install.mjs'

const { dataRoot, workRoot, rig, gitMust, record, cleanup } = billingInstall('rig-chats-')

after(cleanup)

const FIRST = 't3-thread://v2/env-1/thread-1'
const SECOND = 'https://chat.example.invalid/threads/2'
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/

const listed = id => JSON.parse(rig(['list', '--json', '--quick']).stdout).works.find(w => w.id === id)

test('rig chat <link> records the chat with its date, and commits the data root', () => {
  assert.equal(rig(['new', 'chatty', '--title', 'Chatty', '--no-ticket']).code, 0)
  const r = rig(['chat', FIRST, '--work', 'chatty'])
  assert.equal(r.code, 0, r.out)
  const { chats } = record('chatty')
  assert.equal(chats.length, 1)
  assert.equal(chats[0].link, FIRST)
  assert.match(chats[0].at, ISO)
  assert.equal(gitMust(dataRoot, 'log', '-1', '--format=%s'), 'rig chat chatty: recorded a chat')
})

test('the chat that is already the current one is recorded once', () => {
  const r = rig(['chat', FIRST, '--work', 'chatty'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /already the current chat of chatty, so there is nothing to do/)
  assert.equal(record('chatty').chats.length, 1)
})

test('a second chat becomes the current one, and the first stays as history', () => {
  assert.equal(rig(['chat', SECOND, '--work', 'chatty']).code, 0)
  assert.deepEqual(record('chatty').chats.map(c => c.link), [FIRST, SECOND])
})

test('an earlier chat that comes back is recorded again, as the current one', () => {
  assert.equal(rig(['chat', FIRST, '--work', 'chatty']).code, 0)
  assert.deepEqual(record('chatty').chats.map(c => c.link), [FIRST, SECOND, FIRST])
})

test('bare rig chat lists the entries newest first, the current one marked, and counts each chat once', () => {
  const r = rig(['chat', '--work', 'chatty'])
  assert.equal(r.code, 0, r.out)
  const lines = r.stdout.trim().split('\n')
  assert.match(lines[0], /chatty has run in 2 chats, newest first:/)
  assert.match(lines[1], new RegExp(`\\d{4}-\\d{2}-\\d{2}  ${FIRST}  \\(current\\)$`))
  assert.match(lines[2], new RegExp(`\\d{4}-\\d{2}-\\d{2}  ${SECOND}$`))
  assert.match(lines[3], new RegExp(`\\d{4}-\\d{2}-\\d{2}  ${FIRST}$`))
})

test('rig status counts the earlier chats, not the current one come back', () => {
  assert.match(rig(['status', '--work', 'chatty']).out, new RegExp(`^chat ${FIRST} \\(1 earlier\\)$`, 'm'))
})

test('bare rig chat on a work with none says how to record one, and writes nothing', () => {
  assert.equal(rig(['new', 'quiet', '--title', 'Quiet', '--no-ticket']).code, 0)
  const head = gitMust(dataRoot, 'rev-parse', 'HEAD')
  const r = rig(['chat', '--work', 'quiet'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /quiet has no chat recorded: `rig chat <link>` records the one you are in/)
  assert.equal(gitMust(dataRoot, 'rev-parse', 'HEAD'), head)
})

test('rig chat --remove takes every entry with that link off the record, and the chat on either side of it is one again', () => {
  const firstAt = record('chatty').chats[0].at
  const r = rig(['chat', '--remove', SECOND, '--work', 'chatty'])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('chatty').chats, [{ link: FIRST, at: firstAt }])
  assert.equal(gitMust(dataRoot, 'log', '-1', '--format=%s'), 'rig chat chatty: removed a chat')
})

test('removing the last chat leaves the record as it was before any', () => {
  assert.equal(rig(['chat', '--remove', FIRST, '--work', 'chatty']).code, 0)
  assert.equal(record('chatty').chats, undefined)
})

test('a chat asked for badly is refused, says why, and changes nothing', () => {
  assert.equal(rig(['chat', FIRST, '--work', 'chatty']).code, 0)
  for (const [args, says] of [
    [['not-a-link'], /"not-a-link" is not a link: a chat is recorded by its scheme:\/\/… link, as the agent host gives it/],
    [['https://chat.example.invalid/a b'], /is not a link/],
    [['--remove'], /--remove needs the link to take off the record/],
    [[SECOND, '--remove', FIRST], /--remove takes the one link it removes, and nothing else/],
    [['--remove', SECOND], new RegExp(`${SECOND} is not a chat recorded on chatty, which has ${FIRST}`)],
    [[FIRST, SECOND], /rig chat takes one link/],
    // Whatever shows the work's chat may open its link, and the record is committed.
    [['javascript://%0aalert(1)'], /a javascript: link is refused: whatever shows the work's chat may open it/],
    [['https://someone:hunter2@chat.example.invalid/x'], /a chat's link carries no user or password: it is committed to the data root and shown by rig status/],
  ]) {
    const r = rig(['chat', ...args, '--work', 'chatty'])
    assert.equal(r.code, 1, `${args.join(' ')}\n${r.out}`)
    assert.match(r.out, says)
    assert.doesNotMatch(r.out, /hunter2/, 'a password in a refused link is not echoed')
  }
  assert.deepEqual(record('chatty').chats.map(c => c.link), [FIRST])
})

test('a closed or an abandoned work records no chat, and says why', () => {
  assert.equal(rig(['new', 'stopped', '--title', 'Stopped', '--no-ticket']).code, 0)
  assert.equal(rig(['close', '--abandoned', '--work', 'stopped']).code, 0)
  const r = rig(['chat', FIRST, '--work', 'stopped'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /stopped was abandoned, so it has no chat left to run in/)
  assert.equal(record('stopped').chats, undefined)

  assert.equal(rig(['new', 'finished', '--title', 'Finished', '--no-ticket']).code, 0)
  assert.equal(rig(['close', '--work', 'finished']).code, 0)
  const closed = rig(['chat', FIRST, '--work', 'finished'])
  assert.equal(closed.code, 1, closed.out)
  assert.match(closed.out, /finished is closed, so it has no chat left to run in/)
  // The history is still read.
  assert.equal(rig(['chat', '--work', 'finished']).code, 0)
})

test('rig new --chat records the chat the work was started from', () => {
  const r = rig(['new', 'started', '--title', 'Started', '--no-ticket', '--chat', FIRST])
  assert.equal(r.code, 0, r.out)
  assert.deepEqual(record('started').chats.map(c => c.link), [FIRST])
})

test('rig new --chat with no link, or not a link, is refused before the work is made', () => {
  for (const [value, says] of [[[], /--chat needs the link of the chat you are in/], [['nope'], /"nope" is not a link/]]) {
    const r = rig(['new', 'unmade', '--title', 'Unmade', '--no-ticket', '--chat', ...value])
    assert.equal(r.code, 1, r.out)
    assert.match(r.out, says)
    assert.equal(fs.existsSync(path.join(dataRoot, 'work', 'unmade')), false)
  }
})

test('rig new --chat records the chat even when a repo it was asked to attach refuses', () => {
  const r = rig(['new', 'half', '--title', 'Half', '--no-ticket', '--repos', 'billing,nosuch', '--chat', FIRST])
  assert.equal(r.code, 1, r.out)
  assert.ok(record('half'), 'the work was made')
  assert.deepEqual(record('half').chats.map(c => c.link), [FIRST])
})

test('rig restore --chat that is not a link is refused before any worktree is put back', () => {
  assert.equal(rig(['new', 'moved', '--title', 'Moved', '--no-ticket', '--repos', 'billing']).code, 0)
  fs.rmSync(path.join(workRoot, 'moved', 'billing'), { recursive: true, force: true, maxRetries: 5 })
  const r = rig(['restore', 'moved', '--chat', 'nope'])
  assert.equal(r.code, 1, r.out)
  assert.match(r.out, /"nope" is not a link/)
  assert.equal(fs.existsSync(path.join(workRoot, 'moved', 'billing')), false)
})

test('rig restore --chat records the chat that picked the work up, after putting its worktrees back', () => {
  const r = rig(['restore', 'moved', '--chat', FIRST])
  assert.equal(r.code, 0, r.out)
  assert.ok(fs.existsSync(path.join(workRoot, 'moved', 'billing', 'README.md')), r.out)
  assert.deepEqual(record('moved').chats.map(c => c.link), [FIRST])
  assert.equal(gitMust(dataRoot, 'log', '-1', '--format=%s'), 'rig restore moved: recorded a chat')
})

test('rig restore --chat records it when every worktree is already here, as on a pickup', () => {
  const { chats: _before, ...rest } = record('moved')
  const r = rig(['restore', 'moved', '--chat', SECOND])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /every worktree is already here/)
  const { chats, ...after } = record('moved')
  assert.deepEqual(chats.map(c => c.link), [FIRST, SECOND])
  assert.deepEqual(after, rest, 'a restore records the chat and nothing else')
})

test('rig restore --chat with the current chat says so, and commits nothing', () => {
  const head = gitMust(dataRoot, 'rev-parse', 'HEAD')
  const r = rig(['restore', 'moved', '--chat', SECOND])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, /already the current chat of moved, so there is nothing to do/)
  assert.equal(gitMust(dataRoot, 'rev-parse', 'HEAD'), head)
})

test('rig restore with no --chat still commits nothing', () => {
  const head = gitMust(dataRoot, 'rev-parse', 'HEAD')
  assert.equal(rig(['restore', 'moved']).code, 0)
  assert.equal(gitMust(dataRoot, 'rev-parse', 'HEAD'), head)
})

test('rig list --json gives each work its chats and its current chat', () => {
  const moved = listed('moved')
  assert.equal(moved.chat, SECOND)
  assert.deepEqual(moved.chats.map(c => c.link), [FIRST, SECOND])
  assert.ok(moved.chats.every(c => ISO.test(c.at) && Object.keys(c).sort().join() === 'at,link'))
  const quiet = listed('quiet')
  assert.equal(quiet.chat, null)
  assert.deepEqual(quiet.chats, [])
})

test('rig status names the current chat, and how many came before it', () => {
  const r = rig(['status', '--work', 'moved'])
  assert.equal(r.code, 0, r.out)
  assert.match(r.out, new RegExp(`^chat ${SECOND} \\(1 earlier\\)$`, 'm'))
  assert.match(rig(['status', '--work', 'started']).out, new RegExp(`^chat ${FIRST}$`, 'm'))
  assert.doesNotMatch(rig(['status', '--work', 'quiet']).out, /^chat /m)
})

test('rig chat --help and rig help --all carry its lines', () => {
  assert.match(rig(['chat', '--help']).out, /rig chat <link>/)
  assert.match(rig(['chat', '--help']).out, /rig chat --remove <link>/)
  const all = rig(['help', '--all']).out
  assert.match(all, /rig chat <link>/)
  assert.match(all, /--chat <link>/)
  // Each command's description starts in the same column.
  const column = line => line.indexOf(line.trim().split(/ {2,}/)[1])
  assert.equal(column(all.split('\n').find(l => l.startsWith('  rig use '))), column(all.split('\n').find(l => l.startsWith('  rig ticket <key> '))))
})
