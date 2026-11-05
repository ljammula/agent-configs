import { expect, test } from 'claude-code/testing'

import { isGated, mismatch } from './rules'

test('owner-only commands need ljammula', () => {
  expect(mismatch('git push origin main', 'narsimha-j')).toBeDefined()
  expect(mismatch('gh pr merge 5 --squash', 'narsimha-j')).toBeDefined()
  expect(mismatch('git push -u origin x', 'ljammula')).toBeUndefined()
})

test('reviews need narsimha-j', () => {
  expect(mismatch('gh pr review 5 --approve --body-file r.md', 'ljammula')).toBeDefined()
  expect(mismatch('gh pr review 5 --approve', 'narsimha-j')).toBeUndefined()
})

test('a switch earlier in the command counts', () => {
  expect(mismatch('gh auth switch --user narsimha-j && gh pr review 5 --approve && gh auth switch --user ljammula', 'ljammula')).toBeUndefined()
  expect(mismatch('gh auth switch --user narsimha-j && git push', 'ljammula')).toBeDefined()
})

test('ungated commands are not looked at', () => {
  expect(isGated('git status && gh pr view 5')).toBe(false)
  expect(isGated('gh pr checks 5; git push')).toBe(true)
})
