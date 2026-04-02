# subagent

参考 pi 官方 `examples/extensions/subagent/` 做的简化版内置扩展。

## 功能

- `run_subagent`：运行单个或多个并行 subagent
- `list_models`：列出当前可用模型，并按 provider 给出“最新的 3 个”
- 每个 subagent 都用独立的 in-memory AgentSession 执行，隔离上下文
- 支持为每个任务分别指定：
  - `prompt`
  - `model`（精确使用 `provider/model`）
  - `thinkingLevel`
  - `cwd`
- 并行任务会全部执行完再返回，没有后台任务
- 底层复用 rin 自己的 session/runtime，兼容 std 模式和 daemon/RPC 模式
- 不支持 agent preset / prompt preset

## 参数

### 查看模型

```json
{}
```

### 单任务

```json
{
  "action": "run",
  "prompt": "Summarize the auth architecture",
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "medium"
}
```

### 并行任务

```json
{
  "action": "run",
  "tasks": [
    {
      "prompt": "Find the auth entry points",
      "model": "anthropic/claude-haiku-4-5",
      "thinkingLevel": "low"
    },
    {
      "prompt": "Review the API surface",
      "model": "openai/gpt-5.4",
      "thinkingLevel": "medium"
    }
  ]
}
```

## 说明

- 单任务模式如果不传 `model`，会默认使用当前会话模型
- 单任务模式如果不传 `thinkingLevel`，会默认使用当前会话 thinking level
- 并行模式建议先调用 `list_models` 再选模型
