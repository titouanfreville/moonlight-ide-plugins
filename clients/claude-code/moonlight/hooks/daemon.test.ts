import { expect, test } from 'claude-code/testing'
import { controlUrl, countMisses, DAEMON_PHASE, discoveryFile, hooksInstalled, isHealthy, nextGovernor } from './daemon'
import { PHASES } from './policy'

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

test('nextGovernor: a mod that governed from the start keeps the session', () => {
  expect(nextGovernor(undefined, true)).toBe('daemon')
  expect(nextGovernor(undefined, false)).toBe('mod')
  expect(nextGovernor('daemon', true)).toBe('daemon')
  expect(nextGovernor('daemon', false, 3)).toBe('mod')
  expect(nextGovernor('mod', true)).toBe('mod')
})

test('nextGovernor: a mod standing in for the daemon hands the session back', () => {
  expect(nextGovernor('mod', true, 0, true)).toBe('daemon')
  expect(nextGovernor('mod', false, 0, true)).toBe('mod')
})

test('DAEMON_PHASE: every mod phase has its daemon name', () => {
  expect(PHASES.map(p => DAEMON_PHASE[p])).toEqual(['Plan', 'AutoImplement', 'Test', 'Review', 'Commit'])
})

test('isHealthy: the daemon health answer, nothing else', () => {
  expect(isHealthy('{"pid":1,"version":"0.1.5","api":1}')).toBe(true)
  expect(isHealthy('{"pid":1}')).toBe(false)
  expect(isHealthy('<html>')).toBe(false)
})
