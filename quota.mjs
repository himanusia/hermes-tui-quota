import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const home = process.env.HERMES_HOME || join(homedir(), '.hermes')
const probe = process.env.HERMES_QUOTA_PROBE || join(home, 'desktop-plugins', 'quota-dash', 'probe.py')
const providers = {
  'openai-codex': 'Codex',
  'opencode-go': 'OpenCode Go',
  commandcode: 'CommandCode'
}
const intervalMs = 60_000

/**
 * Which interpreter runs the probe, and whether PYTHONPATH must be cleared.
 *
 * The probe imports httpx. Inside the TUI, HERMES_PYTHON points at the bare
 * tool interpreter, which only has httpx via the inherited PYTHONPATH — so
 * preferring HERMES_PYTHON *and* clearing PYTHONPATH leaves no httpx at all
 * (`ModuleNotFoundError`, probe exits 1). The Hermes venv carries its own
 * httpx, so it goes first and is safe to run with a clean PYTHONPATH (the
 * global value would otherwise shadow the venv). A non-venv fallback keeps
 * PYTHONPATH, because that is the only thing giving it dependencies.
 */
export function interpreterFor(env = process.env, has = existsSync) {
  if (env.HERMES_QUOTA_PYTHON) return { cleanPythonPath: false, cmd: env.HERMES_QUOTA_PYTHON }
  const venv = join(env.HERMES_HOME || join(homedir(), '.hermes'), 'hermes-agent', 'venv', 'bin', 'python')
  if (has(venv)) return { cleanPythonPath: true, cmd: venv }
  return { cleanPythonPath: false, cmd: env.HERMES_PYTHON || 'python3' }
}

export function formatQuota(data, providerId) {
  const name = providers[providerId] || providerId || 'Unknown provider'
  const accounts = data.providers?.find(row => row.id === providerId)?.accounts || []
  if (!accounts.length) return `${name} · not configured`
  // Probe pct means USED. Display REMAINING explicitly; missing is never 0%.
  const valid = [...new Map(accounts.map(row => [row.acct || row.fp, row])).values()]
    .filter(row => !row.error && Array.isArray(row.windows) && row.windows.length)
  if (!valid.length) return `${name} · no quota window`
  const remaining = label => {
    const used = valid.flatMap(row => row.windows.filter(w => label.test(w.k)).map(w => Number(w.pct)))
      .filter(Number.isFinite)
    return used.length ? `${Math.max(0, Math.min(100, 100 - Math.max(...used))).toFixed(0)}%` : '—'
  }
  return `${name} · 5h ${remaining(/5h|session/i)} left · week ${remaining(/week/i)} left`
}

/** Rejects with a short reason that is safe to put on the status line. */
export function probeQuota(providerId, env = process.env) {
  const { cleanPythonPath, cmd } = interpreterFor(env)
  const childEnv = { ...env, HERMES_HOME: env.HERMES_HOME || home }
  if (cleanPythonPath) delete childEnv.PYTHONPATH
  return new Promise((resolve, reject) => {
    execFile(cmd, [probe, '--provider', providerId], { timeout: 45_000, maxBuffer: 1024 * 1024, env: childEnv },
      (error, stdout, stderr) => {
        if (error) {
          const reason = error.killed ? 'probe timeout'
            : /ENOENT/.test(String(error.message)) ? 'python not found'
              : /ModuleNotFoundError/.test(String(stderr)) ? 'probe missing deps'
                : 'probe failed'
          return reject(new Error(reason))
        }
        const line = stdout.split('\n').find(x => x.startsWith('@@QUOTA@@ '))
        if (!line) return reject(new Error('probe returned no data'))
        try { resolve(JSON.parse(line.slice('@@QUOTA@@ '.length))) }
        catch { reject(new Error('probe returned bad data')) }
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
      const name = providers[providerId]
      const refresh = () => {
        probeQuota(providerId).then(data => {
          if (alive) sdk.updateWidget(app, s => ({ ...s, provider: providerId, text: formatQuota(data, providerId) }))
        }, error => {
          if (alive) sdk.updateWidget(app, s => ({ ...s, provider: providerId, text: `${name} · ${error.message}` }))
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
