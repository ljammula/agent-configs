import { expect, test } from 'claude-code/testing'

import { commitFile, segments, verdict } from './rules'

const denies = (cmd: string) => verdict(segments(cmd)) !== undefined

test('inline commit messages are refused', () => {
  expect(denies('git commit -m "fix"')).toBe(true)
  expect(denies('git add . && git commit -am wip')).toBe(true)
  expect(denies('git -C repo commit --message=x')).toBe(true)
})

test('file-based and unrelated commands pass', () => {
  expect(denies('git commit -F /tmp/msg.txt')).toBe(false)
  expect(denies('git commit --amend --no-edit')).toBe(false)
  expect(denies('git log -m')).toBe(false)
  expect(denies('gh pr create --title t --body-file b.md')).toBe(false)
})

test('inline gh bodies are refused', () => {
  expect(denies('gh pr create --title t --body "hi"')).toBe(true)
  expect(denies('gh pr review 3 --approve -b ok')).toBe(true)
})

test('the -F file is found, quotes stripped, stdin ignored', () => {
  expect(commitFile('git commit -F "/tmp/a b.txt"')).toBe('/tmp/a b.txt')
  expect(commitFile('git commit --file=msg.txt')).toBe('msg.txt')
  expect(commitFile('git commit -F -')).toBe(undefined)
  expect(commitFile('git push')).toBe(undefined)
})
