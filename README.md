# dsh-rest-adapter

English | [中文](README.zh.md)

Local HTTP REST bridge plugin for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): a control plane for external apps (phone apps, Python bridges, schedulers) to drive the local DSH agent over standard HTTP — **no public exposure**. Routes mount on the existing web server port (`127.0.0.1:3080` by default) and answer through the same API gateway the browser uses, so everything you do through the REST API is visible in the DSH Web UI and shares its sessions.

## Install

Requires DSH `0.1.x` with a `web` profile.

```powershell
# from GitHub (recommended)
dsh plugin --profile web add github:<owner>/dsh-rest-adapter

# or from a local clone
dsh plugin --profile web add link:D:\path\to\dsh-rest-adapter
```

Then restart `dsh web` and refresh the browser. The plugin appears in the plugin list (Settings → Plugins) and `GET /health` answers with the endpoint roster.

> If this plugin is already built into your DSH bundle, do NOT install it again — duplicate route registration fails on boot.

## Endpoints (`http://127.0.0.1:3080`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness probe + endpoint roster |
| POST | `/v1/chat/completions` | OpenAI-compatible completion (non-streaming) |
| POST | `/v1/agent/prompt` | run one turn, return the final text (sync) |
| POST | `/v1/agent/prompt/stream` | **SSE turn stream**: reasoning/content deltas, tool cards, approvals, heartbeat |
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
  "sessionId": "optional — omitted creates a new session (returned in the response)",
  "prompt": "what the agent should do",
  "model": "deepseek-v4-flash",
  "reasoningEffort": "high",
  "permission": "workspace-write"
}
```

- `model` / `reasoningEffort` — selected before the turn via the gateway's `session.selectModel`; snake_case `reasoning_effort` is also accepted.
- `permission` — `read-only` | `workspace-write` | `danger-full-access` (the `/permission` preset; common aliases are normalized). Switching presets injects a policy-change notice the model may address first — set it on the first message of a new session.
- `sessionId` reuse continues the existing session (never re-created).

## SSE events

`event: reasoning` → `{content}` (thinking delta) · `event: content` → `{content}` (answer delta) · `event: tool_start` → `{id, tool, input}` · `event: tool_end` → `{id, tool, output, status}` · `event: waiting_approval` → `{approvalId, tool}` · `event: approval_resolved` → `{approvalId, outcome}` · `event: done` → `{sessionId, status, title?}` · `event: error` → `{message}`. Idle keep-alive comments arrive every 5 s; disconnecting cancels held approvals for that session.

## Config

Optional plugin config (in a later patch layer): `turnTimeoutMs` (600000), `pollIntervalMs` (500), `maxBodyBytes` (10485760), `defaultToolLimit` (50), `maxToolLimit` (500), `maxToolResultChars` (2000).

## Build

The shipped `lib/index.js` is a self-contained bundle; rebuild from the source checkout with the workspace host-face build. For a standalone rebuild, inline the external imports (`toFetchHandler` from `@deepseek-ai/dsh-host-apiproxy`, `z` from `@deepseek-ai/schemastery`) with your bundler of choice.
