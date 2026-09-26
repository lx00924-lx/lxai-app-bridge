# dsh-rest-adapter

English | [Chinese](README.zh.md)

Local HTTP REST bridge plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): a control plane for external apps (phone apps, Python bridges, schedulers) to drive the local DSH agent over standard HTTP, with **no public exposure**. Routes mount on the existing web server port (`127.0.0.1:3080` by default) and answer through the same API gateway the browser uses, so everything you do through the REST API is visible in the DSH Web UI and shares its sessions.

## Install

Requires DSH `0.1.x` with a `web` profile.

```powershell
# from GitHub (recommended)
dsh plugin --profile web add github:lx00924-lx/DeepSeekREST

# or from a local clone
dsh plugin --profile web add link:D:\path\to\dsh-rest-adapter
```

Then restart `dsh web` and refresh the browser. The plugin appears in the plugin list (Settings -> Plugins) and `GET /health` answers with the endpoint roster.

> If this plugin is already built into your DSH bundle, do NOT install it again; duplicate route registration fails on boot.

## Endpoints (`http://127.0.0.1:3080`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness probe + endpoint roster |
| POST | `/v1/chat/completions` | OpenAI-compatible completion (non-streaming) |
| POST | `/v1/agent/prompt` | run one turn, return the final text (sync) |
| POST | `/v1/agent/prompt/stream` | SSE turn stream: reasoning/content deltas, tool cards, approvals, heartbeat |
| POST | `/v1/agent/abort` | abort by body `{ sessionId }` |
| GET | `/v1/models` | model catalog with reasoning-effort levels (`?sessionId=` adds the session's current selection) |
| GET | `/v1/sessions` | session roster |
| PATCH | `/v1/sessions/:id` | rename session `{ title }` |
| DELETE | `/v1/sessions/:id` | archive session from its workspace |
| GET | `/v1/sessions/:id/tools` | tool execution status (`?limit=N`) |
| POST | `/v1/sessions/:id/abort` | stop the active turn |
| POST | `/v1/sessions/:id/approve` | answer a held approval `{ approvalId, action: "allow" | "deny" }` |
| GET | `/v1/plugins` | plugin roster |

All routes send `Access-Control-Allow-Origin: *` and answer `OPTIONS` with 204.

## Prompt request fields

```json
{
  "sessionId": "optional - omitted creates a new session (returned in the response)",
  "prompt": "what the agent should do",
  "model": "deepseek-v4-flash",
  "reasoningEffort": "high",
  "permission": "workspace-write"
}
```

- `model` / `reasoningEffort` - selected before the turn via the gateway's `session.selectModel`; snake_case `reasoning_effort` is also accepted.
- `permission` - `read-only` | `workspace-write` | `danger-full-access` (the `/permission` preset; common aliases are normalized). Switching presets injects a policy-change notice the model may address first; set it on the first message of a new session.
- `sessionId` reuse continues the existing session (never re-created).

## SSE events

`event: reasoning` -> `{content}` (thinking delta) | `event: content` -> `{content}` (answer delta) | `event: tool_start` -> `{id, tool, input}` | `event: tool_end` -> `{id, tool, output, status}` | `event: waiting_approval` -> `{approvalId, tool}` | `event: approval_resolved` -> `{approvalId, outcome}` | `event: done` -> `{sessionId, status, title?}` | `event: error` -> `{message}`. Idle keep-alive comments arrive every 5 s; disconnecting cancels held approvals for that session.

## Config

Optional plugin config (in a later patch layer): `turnTimeoutMs` (600000), `pollIntervalMs` (500), `maxBodyBytes` (10485760), `defaultToolLimit` (50), `maxToolLimit` (500), `maxToolResultChars` (2000).

## Build

The shipped `lib/index.js` is a self-contained bundle; rebuild from the source checkout with the workspace host-face build. For a standalone rebuild, inline the external imports (`toFetchHandler` from `@deepseek-ai/dsh-host-apiproxy`, `z` from `@deepseek-ai/schemastery`) with your bundler of choice.

## License

GNU Affero General Public License v3.0 (`AGPL-3.0-only`) - see [LICENSE](LICENSE) and [NOTICE](NOTICE).

You may use, modify and self-host this plugin freely, including commercially. Two obligations apply if you pass it on:

- **Publish the source.** If you distribute a modified version - or expose it as a network service - you must make the complete corresponding source of your modified version available under the same license.
- **Keep the attribution.** Under AGPL-3.0 section 7(b), every distributed or network-served derivative must keep the following notice in its about / legal-notices surface or accompanying documentation:
  `dsh-rest-adapter (DeepSeekREST) - by lx00924-lx - https://github.com/lx00924-lx/DeepSeekREST`

## Trademarks and disclaimer

This is an **independent third-party plugin**. It is **not affiliated with, endorsed by, sponsored by, or connected to DeepSeek** (Hangzhou DeepSeek Artificial Intelligence Basic Technology Research Co., Ltd.) or the DeepSeek Harness project.

"DeepSeek", "DeepSeek Harness" and related names and marks belong to their respective owners. They are used here only to **describe interoperability** (nominative use) - no official certification, partnership or endorsement is implied.

This plugin contains **no code copied from DeepSeek Harness**; it calls the runtime services the host exposes (`webServer`, `apiProxy`, `approval`, ...). The host itself is MIT-licensed by its own authors.

