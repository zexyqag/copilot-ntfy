# Copilot Ntfy — Project Guidelines

VS Code extension (`MrCarrotLabs.copilot-ntfy`) that sends [ntfy.sh](https://ntfy.sh) push notifications when a GitHub Copilot agent job finishes or appears to be waiting on the user. Works by **tailing the Copilot Chat log file** — no Copilot API calls.

## Build and Test

```bash
npm install          # install devDependencies (typescript, @types/*, @vscode/vsce)
npm run compile      # tsc -p ./ → out/
npm run watch        # incremental compile
npm test             # compile + node --test out/test/utils.test.js
npm run package      # vsce package
npm run publish      # vsce publish
```

Tests use Node's built-in `node:test` runner — no Jest/Mocha. Always run `npm run compile` before running tests manually; `npm test` does this automatically.

## Architecture

```
src/
  extension.ts   # VS Code host: activation, commands, poll loop, ntfy HTTP POST
  utils.ts       # Pure, VS Code-free helpers: log parsing, formatDuration(), parseJobInfo()
  test/
    utils.test.ts  # Unit tests for utils.ts only (node:test + node:assert)
```

**`activate(context)`** — entry point:

1. Derives `windowExtHostLogDir` from `context.logUri` (per-window; critical for finding the correct log).
2. Sets up status bar, six commands, ntfy auth secret storage, and cross-window state sync via `watchState.json` in `globalStorageUri`.

**Poll loop (`pollLog`)** — runs on `setInterval` (default 5 000 ms):

- Log path: `<windowExtHostLogDir>/GitHub.copilot-chat/GitHub Copilot Chat.log`
- Reads only **new bytes** each tick via `lastByteOffset` (tail-style, no re-scan).
- Pre-compiled module-level regexes detect `ccreq` success/failed/timeout/empty lines, unresolved wait-state handoffs, and `ToolCallingLoop` stop hooks.

**Pending state machine** — module-level vars track one in-flight job plus delayed wait-state notifications (`pendingCcreqLine`, `pendingTurnCount`, `pendingJobStartMs`, `pendingPromptFiltered`, question-wait state, terminal-wait state).

**`sendNtfy`** — raw `http`/`https` POST (no fetch/axios) with duplicate-send guard (`lastNotifKey` + `lastNotifTs` in `watchState.json`, 5 s window) and optional `Authorization` header loaded from VS Code `SecretStorage`.

## Conventions

- **Cross-window IPC**: file-system-based (`watchState.json` + `fs.watchFile` polling at 500 ms) — no VS Code messaging APIs.
- **Zero runtime dependencies**: only Node built-ins (`fs`, `path`, `http`, `https`) and the VS Code API.
- **Secrets live in `SecretStorage`**: ntfy credentials must never be stored in settings, shared state, or logs.
- **All regexes pre-compiled** at module load — never use `new RegExp(...)` per line.
- **`utils.ts` must stay VS Code-free** so it can be tested with plain `node --test`.
- **BYOK model alias**: `gpt-4o->gpt-4o-2024` is normalised to `gpt-4o` (take the part before `->`) in `parseJobInfo`.
- Target: `ES2020`, module: `commonjs`, strict mode on.

## Key Pitfalls

- **Log path is per-window**: `windowExtHostLogDir` is `parent(context.logUri)`. Breaking this derivation silently tails the wrong (or nonexistent) log.
- **`promptFiltered` ordering**: the content-safety event fires in a _different log context_ before the `editAgent failed` line — tracked with a boolean flag, not by timestamp correlation.
- **Wait-state detection is heuristic**: bare `tool_calls` and `copilotLanguageModelWrapper` successes can appear in normal runs, so unresolved wait notifications must be delayed and cleared as soon as the agent resumes. Wrapper successes paired with an explicit finish reason such as `[stop]` are normal terminal-command flow, while an unresolved `tool_calls` wait can legitimately survive a later `[stop]` because that stop may be the assistant's follow-up prompt. If a terminal wrapper handoff is later detected, it should take precedence over the generic unresolved-input wait. If a wait state is still pending, suppress the normal completion notification for that same stop-hook sequence.
- **Tests import from `out/`**: `import { ... } from "../utils"` resolves to `out/utils.js`. Running the test source directly without compiling first will fail.
- **No redirect following in `sendNtfy`**: if your ntfy server issues a redirect, it is silently dropped.
- **Cancelled jobs are intentionally ignored**: do not add cancellation handling without also resetting pending state.
