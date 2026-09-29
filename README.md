# Hermes TUI Quota

A single plain-text line in the Hermes TUI showing how much quota is **left** on the provider the current chat actually runs on.

```
Codex · 5h 9% left · week 37% left
```

No border, no panel — it sits in the composer dock above the input, next to the `Ready · model` rule.

## How it reads the provider

Provider awareness comes from the live session (`session.info.provider`), never from the configured default model and never from a guess based on the model name. Switching model or session re-targets the line.

That fact is not reachable from a user widget in stock Hermes, so this widget needs one SDK hook:

```ts
// ui-tui/src/sdk/userWidgets.ts — add to widgetSdk
useSessionProvider: () => useStore($uiState).info?.provider ?? null,
```

Without it the widget renders `Quota · needs Hermes SDK hook` instead of a wrong number.

`patches/0001-tui-sdk-expose-session-provider.patch` carries that hook as a one-commit patch (with its test). Apply it in a Hermes checkout, then rebuild:

```
git am patches/0001-tui-sdk-expose-session-provider.patch
cd ui-tui && npm run build
```

It is a patch file rather than a branch because a Hermes fork here has a truncated history — pushing the 38k-commit ancestry is not viable, while a 4-line change is.

## How it reads the quota

It shells out to the read-only probe shipped with the [Hermes Provider Quota Dashboard](https://github.com/himanusia/hermes-provider-quota-dashboard) — the same file the desktop pane uses. This repository holds no credentials; the probe reads the local credential pool itself and prints one JSON line.

The probe's `pct` is **used**, not remaining. This widget displays `100 - pct` and says `left`, so the number means what it looks like. Missing windows stay `—` and are never turned into a fake `0%`.

## Install

1. Copy `quota.mjs` to `~/.hermes/tui-widgets/quota.mjs`.
2. Add the SDK hook above to your Hermes checkout and rebuild the TUI (`npm run build` in `ui-tui`), then restart the TUI.
3. `/quota` toggles the line. It is not auto-opened, so it stays off until you ask for it.
4. `/widgets-reload` picks up edits to the widget file without a restart.

Requires `probe.py` at `~/.hermes/desktop-plugins/quota-dash/probe.py`; override with `HERMES_QUOTA_PROBE` (and `HERMES_PYTHON` for the interpreter).

## Refresh

Re-probes every 60 seconds while the line is open, and immediately when the provider changes. The probe runs with `PYTHONPATH` cleared, since the global value shadows the Hermes venv.

## Test

```
node --test test/widget.test.mjs
```

Covers the used→remaining inversion, clamping, pooled accounts taking the most constrained value, and the not-configured/unavailable/unknown-provider labels.

## Limits

- Codex, OpenCode Go, and CommandCode only — an unknown provider id renders `<id> · quota unsupported` rather than an invented figure.
- The probe reads the local credential pool, so a provider you are not authenticated against reads as `not configured`.
