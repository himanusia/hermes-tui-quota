// Node's built-in test runner — no dependencies. `node --test test/`.
import assert from 'node:assert/strict'
import test from 'node:test'

import { formatQuota, interpreterFor, probeQuota } from '../quota.mjs'

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

const data = (windows) => ({ providers: [{ id: 'openai-codex', accounts: [{ fp: 'a', windows }] }] })

test('probe pct is USED percent, so the line reports what is LEFT', () => {
  const line = formatQuota(data([{ k: 'session (5h)', pct: 91 }, { k: 'weekly', pct: 63 }]), 'openai-codex')
  assert.equal(line, 'Codex · 5h 9% left · week 37% left')
})

test('a full window reads 0% left, never a negative', () => {
  const line = formatQuota(data([{ k: 'session (5h)', pct: 104 }, { k: 'weekly', pct: 100 }]), 'openai-codex')
  assert.equal(line, 'Codex · 5h 0% left · week 0% left')
})

test('missing window data stays unknown instead of a fake 0%', () => {
  const line = formatQuota(data([{ k: 'weekly', pct: 10 }]), 'openai-codex')
  assert.equal(line, 'Codex · 5h — left · week 90% left')
})

test('the most constrained account wins across a pool', () => {
  const line = formatQuota({ providers: [{ id: 'openai-codex', accounts: [
    { fp: 'a', windows: [{ k: 'session (5h)', pct: 10 }] },
    { fp: 'b', windows: [{ k: 'session (5h)', pct: 80 }] }
  ] }] }, 'openai-codex')
  assert.equal(line, 'Codex · 5h 20% left · week — left')
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
