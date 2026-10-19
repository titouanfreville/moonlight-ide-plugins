import { expect, test } from 'claude-code/testing'
import { startGate } from './gate-kit'

// The IDE's review panel over the mod: the files under review and their
// baselines are published; comments, per-file accept, findings and submit
// come back through the inbox.
test('Bridge: the review for the IDE, and its decisions', async ($, on) => {
  const world = await startGate($ as never, on as never, { bridge: true })
  const clock = world.clock!
  const dir = '/h/.moonlight/mod/sessions/s1'
  const blob = `${dir}/baseline/blobs/abc`
  world.files[`${dir}/baseline/index.json`] = JSON.stringify({ '/p/src/a.ts': { kind: 'copy', blob } })
  world.files[blob] = 'before\n'
  world.files['/p/src/a.ts'] = 'after\n'
  const review = () => JSON.parse(world.files[`${dir}/state.json`] ?? 'null')?.review
  const send = async (name: string, entry: Record<string, unknown>) => {
    world.files[`${dir}/inbox/${name}.json`] = JSON.stringify({ v: 1, ...entry })
    await clock.advance(2000)
    return JSON.parse(world.files[`${dir}/outbox/${name}.json`] ?? 'null')
  }

  await clock.advance(2000)
  expect(review()).toMatchObject({
    scope: 'session',
    files: [{ path: 'src/a.ts', absolute: '/p/src/a.ts', status: 'M', added: 1, removed: 1, baseline: blob }],
    comments: [],
    findings: [],
    run: null,
  })

  // A line comment from the IDE, and one on a file not under review.
  const added = await send('1-comment', { kind: 'review-comment', path: 'src/a.ts', side: 'after', start: 1, end: 1, body: 'why?' })
  expect(added).toMatchObject({ ok: true })
  await clock.advance(2000)
  expect(review().comments).toEqual([{ path: 'src/a.ts', side: 'after', start: 1, end: 1, body: 'why?', id: added.message }])
  expect(await send('2-comment', { kind: 'review-comment', path: 'nope.ts', side: 'after', start: 1, end: 1, body: 'x' })).toMatchObject({ ok: false })
  expect(await send('3-edit', { kind: 'review-comment-edit', id: added.message, body: 'why this?' })).toMatchObject({ ok: true })
  await clock.advance(2000)
  expect(review().comments[0].body).toBe('why this?')

  // No finding to triage, and an unknown skill to run.
  expect(await send('4-finding', { kind: 'finding', id: 'H1-1-0', decision: 'dismiss' })).toMatchObject({ ok: false })
  expect(await send('5-run', { kind: 'review-run', skill: 'not-installed' })).toMatchObject({ ok: false })

  // Not while its comment is unsent: the operator's words are never dropped unasked.
  expect(await send('6-accept', { kind: 'review-accept-file', path: 'src/a.ts' })).toMatchObject({ ok: false })
  expect(await send('6b-uncomment', { kind: 'review-uncomment', id: added.message })).toMatchObject({ ok: true })
  // Mark the file reviewed: it is kept as it is now.
  expect(await send('6c-accept', { kind: 'review-accept-file', path: 'src/a.ts' })).toMatchObject({ ok: true })
  expect(Object.values(JSON.parse(world.files[`${dir}/baseline/index.json`]!) as Record<string, { kind: string }>)).toMatchObject([{ kind: 'copy' }])
  await clock.advance(2000)
  expect(review()).toMatchObject({ files: [], comments: [] })

  // Nothing left to send.
  expect(await send('7-submit', { kind: 'review-submit' })).toMatchObject({ ok: false })
})
