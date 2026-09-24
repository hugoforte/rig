import { test } from 'node:test'
test('this shard must fail, to prove the gate', () => { throw new Error('on purpose') })
