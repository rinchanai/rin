# subagent

A simplified builtin extension based on the upstream pi example at `examples/extensions/subagent/`.

## Features

- `run_subagent`: run one subagent or multiple subagents in parallel
- `list_models`: list currently available models, plus the latest three per provider
- `list_subagent_sessions`: list saved subagent sessions so later runs can resume or fork them
- default subagent runs use isolated in-memory `AgentSession` context
- subagent runs can also use saved sessions:
  - `session.mode: "persist"` creates a new saved session
  - `session.mode: "resume"` continues an existing saved session
  - `session.mode: "fork"` branches from an existing saved session
- each task can specify:
  - `prompt`
  - `model` (exact `provider/model`)
  - `thinkingLevel`
  - `cwd`
  - `session`
- parallel tasks wait for all tasks to finish before returning; no background jobs
- reuses Rin's own session/runtime layer and works in both std mode and daemon/RPC mode
- does not support agent presets or prompt presets

## Parameters

### List models

```json
{}
```

### List saved sessions

```json
{
  "all": true,
  "query": "auth",
  "limit": 10
}
```

### Single task (default in-memory)

```json
{
  "prompt": "Summarize the auth architecture",
  "model": "anthropic/claude-sonnet-4-5",
  "thinkingLevel": "medium"
}
```

### Single task with a new saved session

```json
{
  "prompt": "Continue reviewing the auth architecture and keep notes for follow-up turns.",
  "model": "openai/gpt-5.4",
  "session": {
    "mode": "persist",
    "name": "auth-review"
  }
}
```

### Resume a saved session

```json
{
  "prompt": "Continue from the previous auth review and propose the next refactor.",
  "session": {
    "mode": "resume",
    "ref": "<session-id-or-path>"
  }
}
```

### Fork a saved session

```json
{
  "prompt": "Take the previous auth review in a different direction.",
  "session": {
    "mode": "fork",
    "ref": "<session-id-or-path>",
    "name": "auth-review-alt"
  }
}
```

### Parallel tasks

```json
{
  "tasks": [
    {
      "prompt": "Find the auth entry points",
      "model": "anthropic/claude-haiku-4-5",
      "thinkingLevel": "low"
    },
    {
      "prompt": "Continue the saved auth review session and compare with current code",
      "model": "openai/gpt-5.4",
      "thinkingLevel": "medium",
      "session": {
        "mode": "resume",
        "ref": "<session-id-or-path>"
      }
    }
  ]
}
```

## Notes

- single-task mode defaults to the current session model when `model` is omitted
- single-task mode defaults to the current session thinking level when `thinkingLevel` is omitted
- use `list_subagent_sessions` before `resume` or `fork` if you need to discover the saved session id or path
- by default `list_subagent_sessions` filters to the current cwd; set `all: true` to search across all saved sessions
- in parallel mode, it is recommended to call `list_models` first and then choose models
