// Node's built-in test runner — no dependencies. `node --test test/`.
import assert from 'node:assert/strict'
import test from 'node:test'

import { formatQuota, interpreterFor, probeIdFor, probeQuota, quotaLines, resetIn } from '../quota.mjs'

test('the Hermes venv interpreter wins over HERMES_PYTHON, and clears PYTHONPATH', () => {
  // The TUI exports HERMES_PYTHON as the bare tool interpreter, which has no
  // httpx of its own. Preferring it *and* clearing PYTHONPATH is the bug this
  // guards: the probe then dies with ModuleNotFoundError.
  const picked = interpreterFor(
    { HERMES_HOME: '/h/.hermes', HERMES_PYTHON: '/tools/python3' },
    path => path === '/h/.hermes/hermes-agent/venv/bin/python'
  )
  assert.deepEqual(picked, { cleanPythonPath: true, cmd: '/h/.hermes/hermes-agent/venv/bin/python' })
})

test('without a venv the fallback keeps PYTHONPATH, since that is what gives it httpx', () => {
  const picked = interpreterFor(
    { HERMES_HOME: '/h/.hermes', HERMES_PYTHON: '/tools/python3' },
    () => false
  )
  assert.deepEqual(picked, { cleanPythonPath: false, cmd: '/tools/python3' })
})

test('HERMES_QUOTA_PYTHON overrides everything and keeps the inherited environment', () => {
  const picked = interpreterFor({ HERMES_QUOTA_PYTHON: '/custom/python' }, () => true)
  assert.deepEqual(picked, { cleanPythonPath: false, cmd: '/custom/python' })
})

test('a missing interpreter is reported as such, not as a generic failure', async () => {
  await assert.rejects(
    probeQuota('commandcode', { HERMES_QUOTA_PYTHON: '/nonexistent/python' }),
    /python not found/
  )
})

const data = (windows, id = 'openai-codex') =>
  ({ providers: [{ id, accounts: [{ fp: 'a', windows }] }] })

const T = Date.now()
const iso = ms => new Date(ms).toISOString()
const min = m => m * 60_000
const hours = n => n * 3_600_000

test('reset countdowns read as minutes, hours, days, now, or —', () => {
  assert.equal(resetIn(iso(T + min(16)), T), '16m')
  assert.equal(resetIn(iso(T + hours(2) + min(15)), T), '2h 15m')
  assert.equal(resetIn(iso(T + hours(24 * 3 + 5)), T), '3d 5h')
  assert.equal(resetIn(iso(T - min(1)), T), 'now')
  assert.equal(resetIn(null, T), '—')
})

test('probe pct is USED percent, so the line reports what is LEFT — with resets', () => {
  const line = formatQuota(data([
    { k: 'session (5h)', pct: 91, reset: iso(T + hours(2) + min(15)) },
    { k: 'weekly', pct: 63, reset: iso(T + hours(24 * 3 + 5)) }
  ]), 'openai-codex', T)
  assert.equal(line, 'Codex · 5h 9% left · reset 2h 15m · week 37% left · reset 3d 5h')
})

test('a full window reads 0% left, never a negative', () => {
  const line = formatQuota(data([{ k: 'session (5h)', pct: 104 }, { k: 'weekly', pct: 100 }]), 'openai-codex', T)
  assert.equal(line, 'Codex · 5h 0% left · reset — · week 0% left · reset —')
})

test('missing window data stays unknown instead of a fake 0%', () => {
  const line = formatQuota(data([{ k: 'weekly', pct: 10, reset: iso(T + hours(4)) }]), 'openai-codex', T)
  assert.equal(line, 'Codex · 5h — left · reset — · week 90% left · reset 4h')
})

test('the most constrained account wins across a pool, countdown included', () => {
  const line = formatQuota({ providers: [{ id: 'openai-codex', accounts: [
    { fp: 'a', windows: [{ k: 'session (5h)', pct: 10, reset: iso(T + min(10)) }] },
    { fp: 'b', windows: [{ k: 'session (5h)', pct: 80, reset: iso(T + hours(1)) }] }
  ] }] }, 'openai-codex', T)
  assert.equal(line, 'Codex · 5h 20% left · reset 1h · week — left · reset —')
})

test('unconfigured and errored providers are named, not rendered as zero', () => {
  assert.equal(formatQuota({ providers: [{ id: 'openai-codex', accounts: [] }] }, 'openai-codex'),
    'Codex · not configured')
  assert.equal(formatQuota({ providers: [{ id: 'openai-codex', accounts: [{ fp: 'a', error: 'x', windows: [] }] }] }, 'openai-codex'),
    'Codex · no quota window')
})

test('an unknown provider id is still named', () => {
  assert.equal(formatQuota({ providers: [] }, 'brand-new'), 'brand-new · not configured')
})

test('register auto-docks on launch once per process, and rescans never re-dock', async () => {
  const key = '__hermesQuotaWidgetAutoOpened'
  const url = new URL('../quota.mjs', import.meta.url)
  const opened = []
  const mockSdk = {
    defineWidgetApp: def => ({ ...def }),
    h: () => null,
    Text: () => null,
    React: { useEffect: () => {} },
    openWidget: app => opened.push(app.id),
    updateWidget: () => {},
    useSessionProvider: () => null
  }
  const register = async tag => (await import(`${url.href}?t=${tag}`)).default

  delete globalThis[key]
  await (await register('boot'))(mockSdk)
  assert.deepEqual(opened, ['quota'], 'the launch scan docks the line exactly once')

  await (await register('rescan'))(mockSdk)
  assert.deepEqual(opened, ['quota'], 'a rescan must not undo a /quota close')

  delete globalThis[key]
  await (await register('relaunch'))(mockSdk)
  assert.deepEqual(opened, ['quota', 'quota'], 'the next TUI launch docks again')
})

test('a monthly provider wraps onto two lines, so the month is never truncated', () => {
  // CommandCode: fiveHour + weekly are rate-limit windows, "monthly" is the
  // $ credit budget the probe synthesizes from the plan total. Three segments
  // do not fit a narrow dock, and the tail is what gets cut — so the monthly
  // case wraps: line 1 = provider + 5h, line 2 = week + month.
  const now = new Date('2026-10-02T01:00:00+07:00').getTime()
  const text = formatQuota(data([
    { k: '5h', pct: 7.2, reset: '2026-10-02T03:15+07:00' },
    { k: 'weekly', pct: 46.6, reset: '2026-10-02T19:18+07:00' },
    { k: 'monthly', pct: 80.2, reset: '2026-10-11T19:03+07:00' }
  ], 'commandcode'), 'commandcode', now)
  assert.deepEqual(quotaLines(text), [
    'CommandCode · 5h 93% left · reset 2h 15m',
    'week 53% left · reset 18h 18m · month 20% left · reset 9d 18h'
  ])
})

test('the monthly wrap never costs a two-window provider its single line', () => {
  const line = formatQuota(data([{ k: 'session (5h)', pct: 91 }, { k: 'weekly', pct: 63 }]), 'openai-codex')
  assert.ok(!/month/i.test(line), 'no monthly window means no monthly segment')
  assert.deepEqual(quotaLines(line), ['Codex · 5h 9% left · reset — · week 37% left · reset —'])
})

test('a monthly window without a reset still reports the remaining share', () => {
  const now = new Date('2026-10-02T01:00:00+07:00').getTime()
  const text = formatQuota(data([{ k: 'monthly', pct: 80.2 }], 'commandcode'), 'commandcode', now)
  assert.deepEqual(quotaLines(text), [
    'CommandCode · 5h — left · reset —',
    'week — left · reset — · month 20% left · reset —'
  ])
})

test('the Claude DirectSDK session provider is metered as the Claude subscription', () => {
  assert.equal(probeIdFor('claude-subscription-directsdk-experimental'), 'claude-subscription')
  assert.equal(probeIdFor('claude-subscription'), 'claude-subscription')
  assert.equal(probeIdFor('openai-codex'), 'openai-codex')
  assert.equal(probeIdFor('brand-new'), null)
  assert.equal(probeIdFor(null), null)
})

test('Claude headlines the all-models weekly window, not a per-model one', () => {
  const now = new Date('2026-10-03T16:00:00+07:00').getTime()
  const text = formatQuota(data([
    { k: 'session (5h)', pct: 13, reset: '2026-10-03T20:49+07:00' },
    { k: 'weekly sonnet', pct: 90, reset: '2026-10-05T07:00+07:00' },
    { k: 'weekly', pct: 2, reset: '2026-10-03T20:59+07:00' }
  ], 'claude-subscription'), 'claude-subscription', now)
  assert.equal(text, 'Claude · 5h 87% left · reset 4h 49m · week 98% left · reset 4h 59m')
})
