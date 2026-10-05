import { expect, test } from 'claude-code/testing'
import {
  allowWriteBreach,
  allowsNotes,
  allowsWrites,
  checkSandbox,
  gateFailure,
  isAllowedInPlan,
  nextPhase,
  phaseFromToken,
  phaseLabel,
  PHASES,
  phaseRule,
  isUnder,
  mergeOwned,
  newRootEntries,
  parsePhase,
  parseSettings,
  projectKey,
  sandboxListsFor,
} from './policy'

test('projectKey encodes a root like Claude Code project folders', () => {
  expect(projectKey('/Users/me/perso/moonlight-ide-plugins')).toBe('-Users-me-perso-moonlight-ide-plugins')
  expect(projectKey('/a/b.c')).toBe('-a-b-c')
})

test('Plan allows listed tools only (deny by default)', () => {
  expect(isAllowedInPlan('Read')).toBe(true)
  expect(isAllowedInPlan('Bash')).toBe(true)
  expect(isAllowedInPlan('mcp__moonlightcode__present_plan')).toBe(true)
  // Plans go through present_plan: Claude Code's plan mode would leave auto mode.
  expect(isAllowedInPlan('EnterPlanMode')).toBe(false)
  expect(isAllowedInPlan('ExitPlanMode')).toBe(false)
  expect(isAllowedInPlan('mcp__codegraph__codegraph_explore')).toBe(true)
  expect(isAllowedInPlan('mcp__github__get_file_contents')).toBe(true)
  expect(isAllowedInPlan('mcp__github__create_or_update_file')).toBe(false)
  expect(isAllowedInPlan('mcp__github__push_files')).toBe(false)
  expect(isAllowedInPlan('SendMessage')).toBe(false)
  expect(isAllowedInPlan('RemoteTrigger')).toBe(false)
  expect(isAllowedInPlan('CronCreate')).toBe(false)
  expect(isAllowedInPlan('mcp__some_server__anything')).toBe(false)
  expect(isAllowedInPlan('mcp__notion__search', ['mcp__notion__search'])).toBe(true)
  expect(isAllowedInPlan('mcp__notion__search_all', ['mcp__notion__search'])).toBe(false)
})

test('phase defaults to plan', () => {
  expect(parsePhase(undefined)).toBe('plan')
  expect(parsePhase('garbage')).toBe('plan')
  expect(parsePhase(' Auto\n')).toBe('auto')
  expect(parsePhase('commit\n')).toBe('commit')
})

test('the five phases, in the daemon order; next is cyclic', () => {
  expect(PHASES).toEqual(['plan', 'auto', 'test', 'review', 'commit'])
  expect(PHASES.map(nextPhase)).toEqual(['auto', 'test', 'review', 'commit', 'plan'])
})

test('writes in auto, test and review; notes in every phase but commit', () => {
  expect(PHASES.filter(allowsWrites)).toEqual(['auto', 'test', 'review'])
  expect(PHASES.filter(allowsNotes)).toEqual(['plan', 'auto', 'test', 'review'])
})

test('phaseFromToken: labels and the daemon aliases, case-insensitive', () => {
  expect(phaseFromToken('Plan')).toBe('plan')
  expect(phaseFromToken('discovery')).toBe('plan')
  expect(phaseFromToken('Discover')).toBe('plan')
  expect(phaseFromToken(' implement ')).toBe('auto')
  expect(phaseFromToken('AutoImplement')).toBe('auto')
  expect(phaseFromToken('auto-implement')).toBe('auto')
  expect(phaseFromToken('REVIEW')).toBe('review')
  expect(phaseFromToken('test')).toBe('test')
  expect(phaseFromToken('commit')).toBe('commit')
  expect(phaseFromToken('next')).toBeUndefined()
  expect(phaseFromToken('nonsense')).toBeUndefined()
  expect(phaseFromToken(undefined)).toBeUndefined()
  for (const phase of PHASES) expect(phaseFromToken(phaseLabel(phase))).toBe(phase)
})

test('phaseRule names what each phase allows', () => {
  expect(phaseRule('plan')).toBe('project read-only')
  expect(phaseRule('auto')).toBe('project writable')
  expect(phaseRule('test')).toBe('project writable')
  expect(phaseRule('review')).toBe('project writable')
  expect(phaseRule('commit')).toBe('everything frozen until you commit')
})

test('plan denies every top-level entry except the writable folders', () => {
  expect(sandboxListsFor('plan', ['.ai', '.bmad-output'], ['.ai', '.git', 'README.md', 'src'])).toEqual({
    denyWrite: ['./.moonlight', './.claude/settings.json', './.claude/settings.local.json', './.git', './README.md', './src'],
    allowWrite: [],
  })
})

test('writable phases deny only the gate config; commit denies the notes folders too', () => {
  for (const phase of ['auto', 'test', 'review'] as const)
    expect(sandboxListsFor(phase, ['.ai'], ['.ai', 'src'])).toEqual({ denyWrite: ['./.moonlight', './.claude/settings.json', './.claude/settings.local.json'], allowWrite: [] })
  expect(sandboxListsFor('commit', ['.ai', '.bmad-output'], ['.ai', '.git', 'src']).denyWrite).toEqual([
    './.moonlight',
    './.claude/settings.json',
    './.claude/settings.local.json',
    './.ai',
    './.git',
    './src',
  ])
})

test('the gate config stays write-denied in every phase', () => {
  expect(sandboxListsFor('auto', ['.ai'], ['src'])).toEqual({ denyWrite: ['./.moonlight', './.claude/settings.json', './.claude/settings.local.json'], allowWrite: [] })
  expect(sandboxListsFor('plan', ['.ai'], ['.moonlight', 'src']).denyWrite).toEqual(['./.moonlight', './.claude/settings.json', './.claude/settings.local.json', './src'])
})

test('newRootEntries finds what appeared since the deny list was built', () => {
  expect(newRootEntries(['.ai', 'src', 'oops.txt'], ['./src'], ['.ai'])).toEqual(['oops.txt'])
  expect(newRootEntries(['.ai', 'src'], ['./src'], ['.ai'])).toEqual([])
})

test('mergeOwned keeps the user entries and swaps ours', () => {
  expect(mergeOwned(['~/.kube', '.'], ['.'], [])).toEqual(['~/.kube'])
  expect(mergeOwned(['~/.kube'], [], ['.'])).toEqual(['~/.kube', '.'])
})

test('isUnder does not match a sibling with the same prefix', () => {
  expect(isUnder('/p/.ai/x.md', '/p/.ai')).toBe(true)
  expect(isUnder('/p/.ai', '/p/.ai')).toBe(true)
  expect(isUnder('/p/.aiX/x.md', '/p/.ai')).toBe(false)
})

test('checkSandbox fails closed', () => {
  expect(checkSandbox({}).isSafe).toBe(false)
  expect(checkSandbox({ sandbox: { enabled: true } }).isSafe).toBe(false)
  expect(checkSandbox({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }).isSafe).toBe(true)
  expect(
    checkSandbox({ sandbox: { enabled: true, allowUnsandboxedCommands: false, excludedCommands: ['docker *'] } })
      .isSafe,
  ).toBe(false)
  expect(
    checkSandbox({ sandbox: { enabled: true, allowUnsandboxedCommands: false, filesystem: { disabled: true } } })
      .isSafe,
  ).toBe(false)
})

test('parseSettings fails closed on anything the gate would misread', () => {
  expect(parseSettings('')).toEqual({ settings: {} })
  expect(parseSettings('{"sandbox":{"filesystem":{"denyWrite":["./src"]}}}')).toEqual({
    settings: { sandbox: { filesystem: { denyWrite: ['./src'] } } },
  })
  expect('error' in parseSettings('{"a": 1,}')).toBe(true)
  expect('error' in parseSettings('[]')).toBe(true)
  expect('error' in parseSettings('{"sandbox": true}')).toBe(true)
  expect('error' in parseSettings('{"sandbox": {"filesystem": "x"}}')).toBe(true)
  expect('error' in parseSettings('{"sandbox": {"filesystem": {"denyWrite": "./src"}}}')).toBe(true)
  expect('error' in parseSettings('{"sandbox": {"filesystem": {"allowWrite": [1]}}}')).toBe(true)
})

test('gateFailure names why the call is refused', () => {
  expect(gateFailure({ kind: 'throw', message: 'boom' })).toContain('(boom), so it is refused')
  expect(gateFailure({ kind: 'timeout' })).toContain('ran out of time')
})

test('allowWriteBreach finds an allowWrite entry that opens a protected folder', () => {
  const roots = ['/home/me/.moonlight', '/p/.moonlight']
  expect(allowWriteBreach(['~/.moonlight'], '/home/me', '/p', roots)).toBe('~/.moonlight')
  expect(allowWriteBreach(['~/'], '/home/me', '/p', roots)).toBe('~/')
  expect(allowWriteBreach(['/'], '/home/me', '/p', roots)).toBe('/')
  expect(allowWriteBreach(['./.moonlight/x'], '/home/me', '/p', roots)).toBe('./.moonlight/x')
  expect(allowWriteBreach(['~/.kube', './build', '/tmp'], '/home/me', '/p', roots)).toBeUndefined()
})
