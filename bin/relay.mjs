// Runs one catalogue command and copies what it prints to rig's own streams, so that a reader
// who stops early — `rig check --run | head` — loses the rest of the output and nothing else.
// Given rig's stdio itself, the command would meet the closed pipe, fail on it, and its failure
// would be taken for the check's verdict (hugoforte/rig#353, DESIGN.md decision 216).
//
// Only a stream that is not a terminal is copied: a terminal cannot close under a run, and a
// command handed one keeps its colour and its progress lines. Stdin is the command's own.
import { spawn } from 'node:child_process'

const command = process.argv[2]
const ours = [process.stdout, process.stderr]
const child = spawn(command, { shell: true, stdio: ['inherit', ...ours.map(s => s.isTTY ? 'inherit' : 'pipe')] })

ours.forEach((to, i) => {
  const from = child.stdio[i + 1]
  if (!from) return
  // Once the reader is gone every write fails; the command's output is still read, so it never
  // blocks on a full pipe, and dropped.
  let open = true
  to.on('error', () => { open = false })
  from.on('data', chunk => { if (open) to.write(chunk) })
})

child.on('error', e => {
  process.stderr.write(`${e.message}\n`)
  process.exitCode = 1
})

// A command killed by a signal ends this process by the same one, so rig still reads a run that
// never finished as no verdict. Node ignores SIGPIPE, which would leave this one alive; it exits 1.
child.on('close', (code, signal) => {
  if (signal) {
    process.exitCode = 1
    process.kill(process.pid, signal)
    return
  }
  process.exitCode = code
})
