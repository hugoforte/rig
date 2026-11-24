// Which pushes run a repo's push-triggered workflows: the branch filters read out of
// `.github/workflows/*.yml`, matched the way GitHub matches them, and the prefixes a work could
// have been cut on instead. Pure, so every form of `on:` is asserted without a checkout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushBranches, branchMatches, pushTriggers, quieterPrefixes, pushTriggersLabel } from '../bin/deploys.mjs'

// The shape that cost a UAT build (hugoforte/rig#386): a deploy on push to the hotfix family.
const imDeploy = `name: Backend - Build Images & Deploy

on:
  push:
    branches:
      - "main"
      - "develop"
      - "release/**"
      - "fix/**"
    paths-ignore:
      - "InformationManager.Ui/**"
  workflow_dispatch:
    inputs:
      branch:
        default: "develop"
`

test('a block list of branch filters under on.push is read, quotes and all', () => {
  assert.deepEqual(pushBranches(imDeploy), ['main', 'develop', 'release/**', 'fix/**'])
})

test('a flow list is read, and a single scalar is one filter', () => {
  assert.deepEqual(pushBranches("on:\n  push:\n    branches: [main, 'fix/**', \"hotfix/*\"]\n"), ['main', 'fix/**', 'hotfix/*'])
  assert.deepEqual(pushBranches('on:\n  push:\n    branches: develop\n'), ['develop'])
  assert.deepEqual(pushBranches('on:\n  push:\n    branches: [main,\n      "fix/**"]\n  pull_request:\n'), ['main', 'fix/**'], 'a flow list may span lines')
})

test('a list item may sit at the key\'s own indent, as YAML allows', () => {
  assert.deepEqual(pushBranches('on:\n  push:\n    branches:\n    - main\n    - fix/**\n  pull_request:\n'), ['main', 'fix/**'])
})

test('comments are no part of a filter', () => {
  assert.deepEqual(pushBranches('on: # triggers\n  push:\n    branches:\n      - main # prod\n      # - fix/**\n'), ['main'])
})

test('a push trigger with no branch filter is not narrowed to any branch family, so nothing is read', () => {
  for (const text of [
    'on: push\n',
    'on: [push, pull_request]\n',
    'on:\n  push:\n  pull_request:\n',
    'on:\n  push:\n    tags: [v*]\n',
    'on:\n  push:\n    branches-ignore: [main]\n',
    "on:\n  push:\n    branches: ['**']\n",
    'on:\n  pull_request:\n    branches: [fix/**]\n',
    'name: no trigger at all\n',
  ]) assert.equal(pushBranches(text), null, text)
})

test('the key may be quoted, as YAML 1.1 readers want it', () => {
  assert.deepEqual(pushBranches('"on":\n  push:\n    branches: [fix/**]\n'), ['fix/**'])
})

test('a filter matches the way GitHub matches: * stops at a slash, ** does not', () => {
  assert.equal(branchMatches(['fix/**'], 'fix/KTLO-2028-im-reports-deep-link'), true)
  assert.equal(branchMatches(['fix/*'], 'fix/a/b'), false)
  assert.equal(branchMatches(['fix/**'], 'feat/KTLO-2028-im-reports-deep-link'), false)
  assert.equal(branchMatches(['main'], 'main-ish'), false)
  assert.equal(branchMatches(['release/[0-9]+.x'], 'release/12.x'), true, 'a class and its + as GitHub reads them, the dot literal')
  assert.equal(branchMatches(['release/[0-9]+.x'], 'release/12ax'), false)
})

test('a later negated filter takes a branch back out, and a later positive one puts it back', () => {
  assert.equal(branchMatches(['fix/**', '!fix/docs-*'], 'fix/docs-typo'), false)
  assert.equal(branchMatches(['fix/**', '!fix/docs-*', 'fix/docs-urgent'], 'fix/docs-urgent'), true)
})

const workflows = [
  { file: 'backend-deploy.yml', text: imDeploy },
  { file: 'frontend-deploy.yml', text: 'on:\n  push:\n    branches: [main, develop, "release/**", "fix/**"]\n' },
  { file: 'run-tests.yml', text: 'on:\n  pull_request:\n    branches: [develop, main]\n' },
  { file: 'ci.yml', text: 'on: push\n' },
]

test('a branch is matched against every workflow, naming the file and the filter that took it', () => {
  assert.deepEqual(pushTriggers(workflows, 'fix/KTLO-2028-im-reports-deep-link'), [
    { file: 'backend-deploy.yml', pattern: 'fix/**' },
    { file: 'frontend-deploy.yml', pattern: 'fix/**' },
  ])
  assert.deepEqual(pushTriggers(workflows, 'feat/KTLO-2028-im-reports-deep-link'), [])
})

test('the prefixes offered instead are the ones no workflow would run on', () => {
  assert.deepEqual(quieterPrefixes(workflows, 'fix/KTLO-2028-x', ['feat', 'fix', 'chore']), ['feat', 'chore'])
  assert.deepEqual(quieterPrefixes([{ file: 'a.yml', text: 'on:\n  push:\n    branches: ["*/**"]\n' }], 'fix/x', ['feat', 'fix']), [])
  assert.deepEqual(quieterPrefixes(workflows, 'my-own-branch', ['feat', 'fix']), [], 'a branch with no prefix has none to swap')
  assert.deepEqual(quieterPrefixes(workflows, 'release/1.31.0', ['feat', 'fix', 'chore']), [], 'a branch named by hand for what it deploys is offered no type')
})

test('the label names each workflow once, with its filter, and at most two prefixes that would be quiet', () => {
  const hits = pushTriggers(workflows, 'fix/KTLO-2028-x')
  assert.equal(pushTriggersLabel(hits, ['feat', 'chore', 'docs']),
    'a push runs backend-deploy.yml (fix/**), frontend-deploy.yml (fix/**) — `--type feat` or `chore` would not')
  assert.equal(pushTriggersLabel(hits, ['chore']),
    'a push runs backend-deploy.yml (fix/**), frontend-deploy.yml (fix/**) — `--type chore` would not')
  assert.equal(pushTriggersLabel(hits, []), 'a push runs backend-deploy.yml (fix/**), frontend-deploy.yml (fix/**)')
})
