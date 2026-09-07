# dsh-rest-adapter

[English](README.md) | 中文

[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（DSH）的本地 HTTP REST 桥接插件：给外部应用（手机 App、Python 桥接脚本、调度器）提供一套标准 HTTP 控制面来驱动本地 DSH 智能体——**全程不出公网**。路由挂在现有 Web 服务器端口上（默认 `127.0.0.1:3080`），并经由浏览器同款 API 网关应答，因此 REST 所做的一切都会出现在 DSH 网页界面里，且共享同一批会话。

## 安装

需要 DSH `0.1.x` + `web` profile。

```powershell
# 从 GitHub 安装（推荐）
dsh plugin --profile web add github:<owner>/dsh-rest-adapter

# 或本地克隆安装
dsh plugin --profile web add link:D:\path\to\dsh-rest-adapter
```

然后重启 `dsh web` 并刷新浏览器。插件会出现在「设置 → 插件」列表里，`GET /health` 会返回端点清单。

> 如果你的 DSH 已内置本插件，请勿重复安装——重复注册路由会导致启动失败。

## 端点（`http://127.0.0.1:3080`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 存活探针 + 端点清单 |
| POST | `/v1/chat/completions` | OpenAI 兼容对话（非流式） |
| POST | `/v1/agent/prompt` | 跑一轮，返回最终文本（同步） |
| POST | `/v1/agent/prompt/stream` | **SSE 流式轮**：思考/回答增量、工具卡片、审批、心跳 |
| POST | `/v1/agent/abort` | 按 `{ sessionId }` 中断 |
| GET | `/v1/models` | 模型目录 + 思考档位（`?sessionId=` 附带该会话当前选择） |
| GET | `/v1/sessions` | 会话列表 |
| PATCH | `/v1/sessions/:id` | 重命名会话 `{ title }` |
| DELETE | `/v1/sessions/:id` | 从工作区归档会话 |
| GET | `/v1/sessions/:id/tools` | 工具执行状态（`?limit=N`） |
| POST | `/v1/sessions/:id/abort` | 停止当前轮 |
| POST | `/v1/sessions/:id/approve` | 答复挂起的审批 `{ approvalId, action: "allow" | "deny" }` |
| GET | `/v1/plugins` | 插件清单 |

所有路由带 `Access-Control-Allow-Origin: *`，`OPTIONS` 返回 204。

## 发消息的请求字段

```json
{
  "sessionId": "可选，不传自动新建（响应中返回）",
  "prompt": "让智能体做什么",
  "model": "deepseek-v4-flash",
  "reasoningEffort": "high",
  "permission": "workspace-write"
}
```

- `model` / `reasoningEffort` —— 轮次开始前经网关 `session.selectModel` 生效；蛇形 `reasoning_effort` 同样接受。
- `permission` —— `read-only` | `workspace-write` | `danger-full-access`（`/permission` 预设；常见别名自动归一化）。切换预设会注入一条「策略已变更」提示，模型可能先回应它——建议在新会话的第一条消息就带上。
- `sessionId` 复用 = 续聊既有会话（绝不重建）。

## SSE 事件

`event: reasoning` → `{content}`（思考增量）· `event: content` → `{content}`（回答增量）· `event: tool_start` → `{id, tool, input}` · `event: tool_end` → `{id, tool, output, status}` · `event: waiting_approval` → `{approvalId, tool}` · `event: approval_resolved` → `{approvalId, outcome}` · `event: done` → `{sessionId, status, title?}` · `event: error` → `{message}`。空闲时每 5 秒发一次 `: keep-alive`；连接断开会按「取消」处理该会话挂起的审批。

## 配置

可选插件配置（放在后续 patch 层）：`turnTimeoutMs`（600000）、`pollIntervalMs`（500）、`maxBodyBytes`（10485760）、`defaultToolLimit`（50）、`maxToolLimit`（500）、`maxToolResultChars`（2000）。

## 构建

随包发布的 `lib/index.js` 是自包含 bundle；源码来自 DSH 工作区（`packages/host/rest-adapter`）。独立重构建时，用你顺手的打包器把外部导入（`@deepseek-ai/dsh-host-apiproxy` 的 `toFetchHandler`、`@deepseek-ai/schemastery` 的 `z`）内联进产物即可。
