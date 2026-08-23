# dsh-subagent-http

[English](README.md) | 中文

DeepSeek Harness HTTP 子智能体提供者 — 将一次性子智能体任务委派到远端 HTTP 端点，并以流式 `AssistantOutput`（`ContentBlock[]`）回传。

## 能力

`capabilities = { outputSchema:false, depthLimit:false, toolFilter:false, persona:false }`，`inheritsParentContext = false`，与 `subagent-acp` 等外置提供者一致。在 `ctx.subagents`（规范别名 `ctx.subagent`）注册 `http` 提供方，每次 `start()` 向 `endpoint` `POST { task, session }` 并按 `AssistantOutputFold` 折叠流式块。

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

`endpoint` 须为合法 `http(s)` URL，`timeoutMs` 须 `>=1`。

## 事件

`ctx.subagents.registerProvider` 触发生命周期事件 `subagent/provider-added` / `provider-removed`（effect 作用域）。运行期仍通过 `LifecycleEmitter` 发出 `subagent/start` / `subagent/end`。

## 安装

使用全新 profile `tmp` 验证（AGENTS.md:112），三条路径均通过 `prepare` 构建 `lib/`，无警告，`dsh --dump-config` 可见层。

```sh
# GitHub（拉源码，需首次 allowBuilds）
dsh plugin --profile tmp add github:Lin-A1/dsh-subagent-http
# 可信安装建议 pin commit
dsh plugin --profile tmp add github:Lin-A1/dsh-subagent-http#<sha>

# npm（已含 lib/，无需 allowBuilds）
dsh plugin --profile tmp add dsh-subagent-http

# 本地（从 dsh-hub 根执行）
dsh plugin --profile tmp add ./plugins/subagent/dsh-subagent-http
```

首次 GitHub 安装会打印精确的 `allowBuilds` key，复制到 `$DSH_HOME/profiles/tmp/pnpm-workspace.yaml`：

```yaml
allowBuilds:
  dsh-subagent-http: true
```

后重跑 `add`。

验证：

```sh
dsh --profile tmp --dump-config  # 须包含 "# == dsh-subagent-http" 层
```

## 版本

- deepseek-harness `0.1.0-rc.8`（`^0.1.0-rc.7` peer，亦兼容 `0.1.1-rc.2`）
- Node.js `>=22`
- `@deepseek-ai/cordis ^4.0.1`，`@deepseek-ai/schemastery ^3.18.1`

## 上游跟踪

- 缝：`deepseek-harness/packages/subagent/subagent`
- 插件仓库：`https://github.com/Lin-A1/dsh-subagent-http`（`master`，`dsh-hub` 中 `plugins/subagent/dsh-subagent-http` 子模块）
- Harness 上游：`https://github.com/deepseek-ai/deepseek-harness` `branch = master`
