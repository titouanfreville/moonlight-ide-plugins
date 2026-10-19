// How phases, diff counts and severities are drawn. Colour never carries a
// meaning alone: each phase has its own symbol and each severity its own mark,
// in every mode. The colour-blind mode swaps the colours for the Okabe–Ito
// palette, which stays distinct for red-green and blue-yellow colour blindness
// alike.

import type { Phase } from './policy'

export type Severity = 'high' | 'medium' | 'low'

// One shape per phase: told apart without colour, and in a monochrome terminal.
export const PHASE_GLYPH: Readonly<Record<Phase, string>> = {
  plan: '◐',
  auto: '▶',
  test: '✓',
  review: '◎',
  commit: '■',
}

const STANDARD_PHASE: Readonly<Record<Phase, string>> = {
  plan: 'yellow',
  auto: 'green',
  test: 'cyan',
  review: 'blue',
  commit: 'red',
}

// Okabe–Ito: orange, blue, sky blue, yellow, vermilion.
const COLOR_BLIND_PHASE: Readonly<Record<Phase, string>> = {
  plan: '#E69F00',
  auto: '#0072B2',
  test: '#56B4E9',
  review: '#F0E442',
  commit: '#D55E00',
}

export const phaseBadge = (phase: Phase): string => ` ${PHASE_GLYPH[phase]} ${phase.toUpperCase()} `

export const phaseColor = (phase: Phase, isColorBlind: boolean): string =>
  (isColorBlind ? COLOR_BLIND_PHASE : STANDARD_PHASE)[phase]

// Lines added and removed: blue and orange in the colour-blind mode, as the
// colour-blind diff themes do; the `+` and `-` say it in every mode.
export const countColors = (isColorBlind: boolean): { added: string; removed: string } =>
  isColorBlind ? { added: '#0072B2', removed: '#E69F00' } : { added: 'green', removed: 'red' }

// A mark ahead of the word, so the worst stand out at a glance without colour.
export const SEVERITY_MARK: Readonly<Record<Severity, string>> = { high: '!!!', medium: '!!', low: '!' }

export const severityLabel = (severity: Severity): string => `${SEVERITY_MARK[severity]} ${severity}`

// The plugin option, as settings give it: a boolean, or its text.
export const isColorBlindOption = (value: unknown): boolean => value === true || value === 'true'
