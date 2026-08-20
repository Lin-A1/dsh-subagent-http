# dsh-subagent-http

[English](README.md) | 中文

DeepSeek Harness HTTP 子智能体提供者 — 将一次性子智能体任务委派到远端 HTTP 端点，并以流式 `AssistantOutput`（`ContentBlock[]`）回传。

## 安装

```sh
# 本地（无需 allowlist）
dsh plugin --profile <name> add ./plugins/subagent/dsh-subagent-http

# GitHub 源码（需 allowBuilds）
dsh plugin --profile <name> add github:<owner>/dsh-subagent-http
# 首次会打印精确的 allow key，复制到 $DSH_HOME/profiles/<name>/pnpm-workspace.yaml:
# allowBuilds:
#   dsh-subagent-http: true

# npm 预构建
dsh plugin --profile <name> add dsh-subagent-http
```

验证：

```sh
dsh --profile <name> --dump-config  # 显示 "# == dsh-subagent-http" 层
```

## 工作原理

在 `ctx.subagents`（规范别名 `ctx.subagent`）注册 `SubagentProvider` 名为 `http`，每次 `start()` 向 `endpoint` `POST { task, session }`：

- `task`: 由 `request.prompt`（`ContentBlock[]`）拼接的文本
- `session`: `{ id, cwd, label, descriptor, maxDepth?, outputSchema? }`

请求头：`content-type: application/json`、`accept: text/event-stream, ...`，有 `token` 时带 `Authorization: Bearer <token>`。

流式处理（对齐 `packages/subagent/subagent/src/assistant-output.ts:AssistantOutputFold`）：
- `application/json` 非流：解析 `{ content | message.content | output | result }` 为 `ContentBlock[]`
- `text/event-stream` / `x-ndjson` / `text/plain`：按行 `data:` 解析 `{ text | delta | chunk.text }` 并折叠

`result` 永不 `reject`，子失败以 `stopReason: 'error'` 返回，父 `signal` 中断为 `aborted`，`dispose()` 中断 `fetch`。

## 配置

| 键 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `endpoint` | `string` | 必填 | `http(s)` URL，`POST {task, session}` |
| `token` | `string?` | 无 | Bearer 令牌 |
| `timeoutMs` | `number` | `60000` | 单次请求超时 ms |

`cordis.patch.yml` 默认：

```yaml
- insert:
    - id: dsh-subagent-http
      name: dsh-subagent-http
      config:
        endpoint: http://127.0.0.1:8080/run
        timeoutMs: 60000
```

## 能力

`capabilities = { outputSchema:false, depthLimit:false, toolFilter:false, persona:false }`，`inheritsParentContext = false`，与 `subagent-acp` 等外置提供者一致。

## 上游跟踪

缝参考：`deepseek-harness/packages/subagent/subagent/src/index.ts:SubagentRuntime`。版本 `0.1.0-rc.8`，Node `>=22`。
