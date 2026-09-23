// Throwaway, for hugoforte/rig#155: a shard that fails, to see the gate fail with it.
import { test } from 'node:test'
test('this shard fails on purpose', () => { throw new Error('on purpose') })
