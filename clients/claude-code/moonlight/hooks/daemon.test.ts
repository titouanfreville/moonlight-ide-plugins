import { expect, test } from 'claude-code/testing'
import { controlUrl, countMisses, discoveryFile, hooksInstalled, isHealthy, nextGovernor } from './daemon'

test('discoveryFile: MOONLIGHT_HOME when absolute, else home', () => {
  expect(discoveryFile('/h', undefined)).toBe('/h/.moonlight/control.json')
  expect(discoveryFile('/h', '/m')).toBe('/m/.moonlight/control.json')
  expect(discoveryFile('/h', 'relative')).toBe('/h/.moonlight/control.json')
  expect(discoveryFile(undefined, undefined)).toBeUndefined()
})

test('controlUrl: a valid port on loopback, nothing else', () => {
  expect(controlUrl('{"port":4123}')).toBe('http://127.0.0.1:4123')
  expect(controlUrl('{"port":"4123"}')).toBeUndefined()
  expect(controlUrl('{"port":0}')).toBeUndefined()
  expect(controlUrl('{"port":70000}')).toBeUndefined()
  expect(controlUrl('not json')).toBeUndefined()
})

test('hooksInstalled: every entry installed, at least one', () => {
  expect(hooksInstalled('[{"event":"PreToolUse","installed":true}]')).toBe(true)
  expect(hooksInstalled('[{"installed":true},{"installed":false}]')).toBe(false)
  expect(hooksInstalled('[]')).toBe(false)
  expect(hooksInstalled('[null]')).toBe(false)
  expect(hooksInstalled('{}')).toBe(false)
  expect(hooksInstalled('oops')).toBe(false)
})

test('nextGovernor: the mod takes over and keeps the session', () => {
  expect(nextGovernor(undefined, true)).toBe('daemon')
  expect(nextGovernor(undefined, false)).toBe('mod')
  expect(nextGovernor('daemon', true)).toBe('daemon')
  expect(nextGovernor('daemon', false, 3)).toBe('mod')
  expect(nextGovernor('mod', true)).toBe('mod')
})

test('nextGovernor: a daemon restart does not flip the session', () => {
  expect(nextGovernor('daemon', false, 1)).toBe('daemon')
  expect(nextGovernor('daemon', false, 2)).toBe('daemon')
  expect(nextGovernor('daemon', false, 3)).toBe('mod')
  expect(countMisses(2, true)).toBe(0)
  expect(countMisses(2, false)).toBe(3)
})

test('isHealthy: the daemon health answer, nothing else', () => {
  expect(isHealthy('{"pid":1,"version":"0.1.5","api":1}')).toBe(true)
  expect(isHealthy('{"pid":1}')).toBe(false)
  expect(isHealthy('<html>')).toBe(false)
})
