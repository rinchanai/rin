# subagent

A simplified builtin extension based on the upstream pi example at `examples/extensions/subagent/`.

## Features

- `run_subagent`: run one subagent or multiple subagents in parallel
- `list_models`: list currently available models, plus the latest three per provider
- each subagent runs in its own in-memory `AgentSession` with isolated context
- each task can specify:
  - `prompt`
  - `model` (exact `provider/model`)
  - `thinkingLevel`
  - `cwd`
- parallel tasks wait for all tasks to finish before returning; no background jobs
- reuses Rin's own session/runtime layer and works in both std mode and daemon/RPC mode
- does not support agent presets or prompt presets

## Parameters

### List models

```json
{}
```

### Single task

```json
{
  "action": "run",
  "prompt": "Summarize the auth architecture",
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "medium"
}
```

### Parallel tasks

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

## Notes

- single-task mode defaults to the current session model when `model` is omitted
- single-task mode defaults to the current session thinking level when `thinkingLevel` is omitted
- in parallel mode, it is recommended to call `list_models` first and then choose models
