import { execFile } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
const python = process.env.HERMES_PYTHON || join(home, 'hermes-agent', 'venv', 'bin', 'python')
const probe = process.env.HERMES_QUOTA_PROBE || join(home, 'desktop-plugins', 'quota-dash', 'probe.py')
const providers = {
  'openai-codex': 'Codex',
  'opencode-go': 'OpenCode Go',
  commandcode: 'CommandCode'
}
const intervalMs = 60_000

export function formatQuota(data, providerId) {
  const name = providers[providerId] || providerId || 'Unknown provider'
  const accounts = data.providers?.find(row => row.id === providerId)?.accounts || []
  if (!accounts.length) return `${name} · not configured`
  // Probe pct means USED. Display REMAINING explicitly; missing is never 0%.
  const valid = [...new Map(accounts.map(row => [row.acct || row.fp, row])).values()]
    .filter(row => !row.error && Array.isArray(row.windows) && row.windows.length)
  if (!valid.length) return `${name} · quota unavailable`
  const remaining = label => {
    const used = valid.flatMap(row => row.windows.filter(w => label.test(w.k)).map(w => Number(w.pct)))
      .filter(Number.isFinite)
    return used.length ? `${Math.max(0, Math.min(100, 100 - Math.max(...used))).toFixed(0)}%` : '—'
  }
  return `${name} · 5h ${remaining(/5h|session/i)} left · week ${remaining(/week/i)} left`
}

function probeQuota(providerId) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, HERMES_HOME: home }
    delete env.PYTHONPATH
    execFile(python, [probe, '--provider', providerId], { timeout: 45_000, maxBuffer: 1024 * 1024, env },
      (error, stdout) => {
        if (error) return reject(new Error('quota probe failed'))
        const line = stdout.split('\n').find(x => x.startsWith('@@QUOTA@@ '))
        if (!line) return reject(new Error('quota data missing'))
        try { resolve(JSON.parse(line.slice('@@QUOTA@@ '.length))) }
        catch { reject(new Error('quota data invalid')) }
      })
  })
}

export default function register(sdk) {
  const { defineWidgetApp, h, Text, React } = sdk
  let app
  function Body({ state, t }) {
    // Provider awareness comes from the TUI SDK hook (session.info.provider),
    // never from the configured default or a model-name guess.
    const hasProviderHook = typeof sdk.useSessionProvider === 'function'
    const providerId = hasProviderHook ? sdk.useSessionProvider() : null
    React.useEffect(() => {
      if (!providerId || !Object.hasOwn(providers, providerId)) return
      let alive = true
      const refresh = () => {
        probeQuota(providerId).then(data => {
          if (alive) sdk.updateWidget(app, s => ({ ...s, provider: providerId, text: formatQuota(data, providerId) }))
        }, () => {
          if (alive) sdk.updateWidget(app, s => ({ ...s, provider: providerId, text: `${providers[providerId]} · quota unavailable` }))
        })
      }
      refresh()
      const timer = setInterval(refresh, intervalMs)
      return () => { alive = false; clearInterval(timer) }
    }, [providerId])
    const text = !hasProviderHook ? 'Quota · needs Hermes SDK hook'
      : !providerId ? 'Quota · provider unavailable'
        : !Object.hasOwn(providers, providerId) ? `${providerId} · quota unsupported`
          : state.provider === providerId ? state.text : `${providers[providerId]} · loading…`
    return h(Text, { color: t.color.muted, wrap: 'truncate-end' }, text)
  }
  app = defineWidgetApp({
    id: 'quota', help: 'toggle quota for the active provider',
    mode: 'ambient', zone: 'dock-top',
    init: () => ({ provider: null, text: '' }),
    reduce: state => state,
    render: ({ state, t }) => h(Body, { state, t })
  })
}
