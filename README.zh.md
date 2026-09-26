# lxai-app-bridge

[English](README.md) | 中文

给**本地 Agent 宿主**用的 HTTP 接口插件：在宿主自己的 web 服务端口（默认 `127.0.0.1:3080`）上注册一组 REST 接口，让外部控制端 —— [LxAI](https://github.com/lx00924-lx/flutter-app) App 及其电脑端桥接脚本 —— 用标准 HTTP 驱动本地智能体，**全程不出公网**。

不额外开端口、不起第二个进程：路由挂在现有 web 服务上，和宿主界面共用同一批会话，所以通过 REST 做的一切都会出现在宿主界面里。

## 安装

把插件复制进宿主的用户插件目录（LxAI App 就是这么装的）：

```powershell
$dst = "$env:USERPROFILE\.dsh\user-plugins-group\plugins\lxai-app-bridge\lib"
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item .\lib\index.js $dst -Force
# 然后重启宿主的 web 服务（插件模块只在启动时加载）
```

或者按 bundle patch 安装（宿主支持 `plugin add` 时）：

```powershell
dsh plugin --profile web add github:lx00924-lx/lxai-app-bridge
```

自检：`GET /health` 会返回存活状态与端点清单。

## 接口一览（`http://127.0.0.1:3080`）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | `/health` | 存活探测 + 端点清单 |
| GET | `/v1/models` | 模型目录（含各模型支持的思考档位） |
| GET | `/v1/sessions` | 会话列表，每行带**真实生效**的模型 / 档位 / 权限 |
| GET | `/v1/session/state?sessionId=` | 单个会话的上述真实状态 |
| POST | `/v1/sessions` | 新建会话 |
| PATCH | `/v1/sessions/:id` | 重命名 |
| DELETE | `/v1/sessions/:id` | 归档 |
| POST | `/v1/sessions/:id/abort` | 中止当前轮次 |
| POST | `/v1/sessions/:id/approve` | 答复挂起的审批 |
| POST | `/v1/agent/prompt` | 跑一轮，同步返回最终文本 |
| POST | `/v1/agent/prompt/stream` | 跑一轮，SSE 流式返回 |
| POST | `/v1/agent/abort` | 中止（`{sessionId}`） |
| POST | `/v1/agent/approve` | 答复审批（`{approvalId, action}`） |
| GET | `/v1/user-questions/pending` | 挂起中的选择框（桥接 1 秒轮询一次） |
| POST | `/v1/user-questions/answer` | 答复选择框（`{questionId, answers}`） |
| POST | `/v1/user-questions/decline` | 把选择框交回宿主界面 |
| GET | `/v1/agent/approvals/pending` | 挂起中的审批（1 秒轮询，含 `reason`） |
| GET | `/v1/plugins` | 已装插件清单 |

选择框 / 审批的状态会依次上报为：`pending`（刚提出）→ `waiting`（等久了但**仍在等**，这一轮不会交给模型）→ `orphaned`（等太久已中止本轮，此时补答会以「续跑」方式重新起一轮）。

## SSE 事件

`reasoning{content}` · `content{content}` · `tool_start{id,tool,input}` · `tool_end{id,tool,output,status}` · `waiting_approval{approvalId,tool}` · `approval_resolved{approvalId,outcome}` · `done{sessionId,status,title?}` · `error{message}`

## 安全提醒

这些路由与宿主官方 `/api` 通道一样位于浏览器信任栅栏之内（Host 必须是回环地址），但**没有额外的鉴权**：任何能访问 3080 的本机进程都能驱动智能体。不要把宿主 web 服务绑定到 `0.0.0.0`，也不要通过 `--trusted-host` 暴露到局域网。

## 开源许可

以 **Apache License 2.0** 发布，全文见 [LICENSE](LICENSE)，第三方名称说明见 [NOTICE](NOTICE)。

你可以自由使用、修改、分发，**包括闭源与商业用途**。义务只有 Apache-2.0 的常规几条：保留版权与许可声明；修改过要说明。第 6 条明确：**本许可不授予任何商标权**，不得用本项目名称做背书。

**没有任何担保**：本插件按"现状"提供，不附带明示或默示担保，作者不对任何损害承担责任。请只对自己拥有所有权或已获明确授权的设备使用，且不要把宿主的本地端口暴露到公网。

## 第三方名称

本插件为**独立第三方项目**：不含任何宿主项目的源码，只在运行时调用宿主对外暴露的服务（`webServer`、会话、审批、提问、插件清单等）。若在使用中提及宿主或其它产品的名称，仅用于说明兼容性，相关名称归其各自权利人所有。
