import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Reuse the installed, read-only Quota Dashboard probe; do not handle credentials here.
const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
const python = process.env.HERMES_PYTHON || join(home, 'hermes-agent', 'venv', 'bin', 'python')
const probe = process.env.HERMES_QUOTA_PROBE || join(home, 'desktop-plugins', 'quota-dash', 'probe.py')
const names = { 'openai-codex': 'Codex', 'opencode-go': 'OpenCode Go', commandcode: 'CommandCode' }
const intervalMs = 5 * 60 * 1000

function probeQuota() {
  return new Promise((resolve, reject) => {
    execFile(python, [probe, '--provider', 'openai-codex', '--provider', 'opencode-go', '--provider', 'commandcode'],
      { timeout: 45000, maxBuffer: 1024 * 1024, env: { ...process.env, HERMES_HOME: home } },
      (error, stdout) => {
        if (error) return reject(new Error(error.killed ? 'probe timeout' : `probe failed (${error.code || 'unknown'})`))
        const line = stdout.split('\n').reverse().find(x => x.startsWith('@@QUOTA@@ '))
        if (!line) return reject(new Error('probe returned no quota data'))
        try { resolve(JSON.parse(line.slice('@@QUOTA@@ '.length))) }
        catch { reject(new Error('invalid quota data')) }
      })
  })
}

function summarize(data) {
  return (data.providers || []).map(provider => {
    const accounts = provider.accounts || []
    const unique = [...new Map(accounts.map(row => [row.acct || row.fp, row])).values()]
    const valid = unique.filter(row => !row.error && Array.isArray(row.windows) && row.windows.length)
    if (!accounts.length) return { name: names[provider.id] || provider.name, info: 'not configured', kind: 'muted' }
    if (!valid.length) return { name: names[provider.id] || provider.name, info: 'unavailable', kind: 'error' }
    const worst = label => {
      const vals = valid.flatMap(row => row.windows.filter(w => label.test(w.k)).map(w => Number(w.pct)))
        .filter(Number.isFinite)
      return vals.length ? `${Math.max(...vals).toFixed(0)}%` : '—'
    }
    const count = unique.length > 1 ? ` (${unique.length})` : ''
    const errors = valid.length < unique.length ? '*' : ''
    return { name: `${names[provider.id] || provider.name}${count}`,
      info: `5h ${worst(/5h|session/i)}  W ${worst(/week/i)}${errors}`, kind: errors ? 'error' : 'ok' }
  })
}

export default function register(sdk) {
  const { defineWidgetApp, h, Text, Box, React } = sdk
  let app
  let pending = false
  const refresh = () => {
    if (pending) return
    pending = true
    probeQuota().then(data => {
      sdk.updateWidget(app, state => ({ ...state, phase: 'ready', rows: summarize(data), at: data.fetchedAt }))
    }, error => {
      sdk.updateWidget(app, state => ({ ...state, phase: 'error', error: error.message }))
    }).finally(() => { pending = false })
  }
  function Body({ state, t }) {
    React.useEffect(() => {
      const timer = setInterval(refresh, intervalMs)
      return () => clearInterval(timer)
    }, [])
    if (state.phase === 'loading') return h(sdk.ShimmerRows, { rows: 3, color: t.color.muted, highlight: t.color.label })
    if (state.phase === 'error') return h(Text, { color: t.color.error, wrap: 'truncate-end' }, 'Quota unavailable')
    return h(Box, { flexDirection: 'column' },
      ...state.rows.map((row, i) => h(Text, { key: i, color: t.color[row.kind] || t.color.muted, wrap: 'truncate-end' }, `${row.name} ${row.info}`)))
  }
  app = defineWidgetApp({
    id: 'quota', help: 'live provider quota (Codex, OpenCode Go, CommandCode)',
    mode: 'ambient', zone: 'top-right', width: 0,
    init() { queueMicrotask(refresh); return { phase: 'loading', rows: [], at: null, error: '' } },
    reduce: state => state,
    render: ({ state, t, cols }) => h(Box, { position: 'absolute', top: 1, right: 1, width: Math.min(32, cols - 4) },
      h(Box, { borderStyle: 'round', borderColor: t.color.muted, flexDirection: 'column',
        opaque: true, paddingX: 1, width: Math.min(32, cols - 4) }, h(Body, { state, t })))
  })
  sdk.openWidget(app, app.init(''))
}
