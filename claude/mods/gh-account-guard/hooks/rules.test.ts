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

test('short and quoted switch flags are followed', () => {
  expect(mismatch('gh auth switch -u narsimha-j && git push', 'ljammula')).toBeDefined()
  expect(mismatch('gh auth switch -u narsimha-j && gh pr review 5 --approve', 'ljammula')).toBeUndefined()
  expect(mismatch('gh auth switch --user "narsimha-j" && gh pr review 5 --approve', 'ljammula')).toBeUndefined()
})

test('a bare switch leaves the account unknown, so a gated command is refused', () => {
  expect(mismatch('gh auth switch && git push', 'narsimha-j')).toBeDefined()
  expect(mismatch('gh auth switch && git push', 'ljammula')).toBeDefined()
})

test('rtk wrappers and git global options are still gated', () => {
  expect(mismatch('rtk git push', 'narsimha-j')).toBeDefined()
  expect(mismatch('rtk proxy gh pr merge 5', 'narsimha-j')).toBeDefined()
  expect(mismatch('git -c http.x=1 push', 'narsimha-j')).toBeDefined()
  expect(mismatch('git --no-pager push', 'narsimha-j')).toBeDefined()
})

test('ungated commands are not looked at', () => {
  expect(isGated('git status && gh pr view 5')).toBe(false)
  expect(isGated('gh pr checks 5; git push')).toBe(true)
})
