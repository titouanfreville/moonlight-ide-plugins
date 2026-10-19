import { expect, test } from 'claude-code/testing'
import { countColors, isColorBlindOption, PHASE_GLYPH, phaseBadge, phaseColor, severityLabel } from './palette'
import { PHASES } from './policy'

test('palette: every phase has its own symbol, in every mode', () => {
  expect(new Set(PHASES.map(p => PHASE_GLYPH[p])).size).toBe(PHASES.length)
  expect(phaseBadge('auto')).toBe(' ▶ AUTO ')
  expect(severityLabel('high')).toBe('!!! high')
  expect(severityLabel('low')).toBe('! low')
})

test('palette: the colour-blind mode swaps the colours for Okabe-Ito', () => {
  expect(phaseColor('auto', false)).toBe('green')
  expect(phaseColor('auto', true)).toBe('#0072B2')
  expect(phaseColor('commit', true)).toBe('#D55E00')
  expect(new Set(PHASES.map(p => phaseColor(p, true))).size).toBe(PHASES.length)
  expect(countColors(true)).toEqual({ added: '#0072B2', removed: '#E69F00' })
  expect(isColorBlindOption(true)).toBe(true)
  expect(isColorBlindOption('true')).toBe(true)
  expect(isColorBlindOption(undefined)).toBe(false)
})
