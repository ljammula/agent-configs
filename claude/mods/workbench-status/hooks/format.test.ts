import { expect, test } from 'claude-code/testing'

import { line, modelState } from './format'

test('slots are read as idle, busy or down', () => {
  expect(modelState('[{"id":0,"is_processing":false}]')).toBe('idle')
  expect(modelState('[{"id":0,"is_processing":false},{"id":1,"is_processing":true}]')).toBe('busy')
  expect(modelState(undefined)).toBe('down')
  expect(modelState('<html>')).toBe('down')
})

test('the line names all three', () => {
  expect(line({ account: 'ljammula', model: 'busy', search: true })).toBe('gh:ljammula  8080:busy  searx:up')
  expect(line({ account: undefined, model: 'down', search: false })).toBe('gh:?  8080:down  searx:down')
})
