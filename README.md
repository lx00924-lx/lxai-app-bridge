# lxai-app-bridge

English | [中文](README.zh.md)

Local HTTP bridge plugin for a **local agent host**: it registers a small REST surface on the host's own web server (default `127.0.0.1:3080`) so that an external controller — the [LxAI](https://github.com/lx00924-lx/flutter-app) App and its PC-side bridge script — can drive the local agent over plain HTTP, **without exposing anything to the public network**.

No second port, no second process: the routes live on the existing web server, use the same sessions as the host UI, and everything you do through them is visible in that UI.

## Install

Copy the plugin into the host's user-plugin directory (the way the LxAI App does it):

```powershell
$dst = "$env:USERPROFILE\.dsh\user-plugins-group\plugins\lxai-app-bridge\lib"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item .\lib\index.js $dst -Force
# restart the host's web service afterwards — plugin modules are loaded at boot
```

Or add it as a bundle patch (if your host supports `plugin add`):

```powershell
dsh plugin --profile web add github:lx00924-lx/lxai-app-bridge
```

Verify: `GET /health` answers with the endpoint roster.

## Endpoints (`http://127.0.0.1:3080`)

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | liveness probe + endpoint roster |
| GET | `/v1/models` | model catalog with reasoning-effort levels |
| GET | `/v1/sessions` | session list, each row carrying the **real** model / effort / permission state |
| GET | `/v1/session/state?sessionId=` | that state for one session |
| POST | `/v1/sessions` | create a session |
| PATCH | `/v1/sessions/:id` | rename |
| DELETE | `/v1/sessions/:id` | archive |
| POST | `/v1/sessions/:id/abort` | abort the running turn |
| POST | `/v1/sessions/:id/approve` | answer a held approval |
| POST | `/v1/agent/prompt` | run one turn, return the final text |
| POST | `/v1/agent/prompt/stream` | run one turn, stream it as SSE |
| POST | `/v1/agent/abort` | abort (`{sessionId}`) |
| POST | `/v1/agent/approve` | answer an approval (`{approvalId, action}`) |
| GET | `/v1/user-questions/pending` | choice boxes waiting for an answer (polled by the bridge, 1 Hz) |
| POST | `/v1/user-questions/answer` | answer a choice box (`{questionId, answers}`) |
| POST | `/v1/user-questions/decline` | hand a choice box back to the host UI |
| GET | `/v1/agent/approvals/pending` | approvals waiting for a decision (polled at 1 Hz, includes `reason`) |
| GET | `/v1/plugins` | installed plugin roster |

Ask/approval states are reported as `pending` → `waiting` (still blocked, the turn is **not** handed to the model) → `orphaned` (the turn was aborted after a long wait; a late answer resumes it as a new turn).

## SSE events

`reasoning{content}` · `content{content}` · `tool_start{id,tool,input}` · `tool_end{id,tool,output,status}` · `waiting_approval{approvalId,tool}` · `approval_resolved{approvalId,outcome}` · `done{sessionId,status,title?}` · `error{message}`

## Security

These routes sit behind the host's browser-trust fence (Host must be loopback) but carry **no extra authentication**: any local process that can reach port 3080 can drive the agent. Never bind the host web service to `0.0.0.0` or expose it to a LAN.

## License

GNU Affero General Public License v3.0 (`AGPL-3.0-only`) — see [LICENSE](LICENSE) and [NOTICE](NOTICE).

Use, modify and self-host it freely, including commercially. Two obligations apply when you pass it on:

- **Publish the source** — if you distribute a modified version, or expose it as a network service, you must make the complete corresponding source available under the same license.
- **Keep the attribution** — under AGPL-3.0 section 7(b), every distributed or network-served derivative must keep the following notice in its about / legal-notices surface or accompanying documentation:
  `lxai-app-bridge - by lx00924-lx - https://github.com/lx00924-lx/lxai-app-bridge`

## Third-party names

This is an **independent third-party plugin**. It contains no code copied from any host project; it only calls the services a host exposes at runtime (`webServer`, sessions, approvals, user questions, plugins). Product names of any host it is used with belong to their respective owners and are used, if at all, only to describe interoperability.
