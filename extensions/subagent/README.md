# subagent

A simplified builtin extension based on the upstream pi example at `examples/extensions/subagent/`.

## Features

- `run_subagent`: run one subagent or multiple subagents in parallel
- `list_models`: list currently available models, plus the latest three per provider
- default subagent runs use isolated in-memory `AgentSession` context
- subagent runs can also use saved sessions:
  - `session.mode: "persist"` creates a new saved session
  - `session.mode: "resume"` continues an existing saved session
  - `session.mode: "fork"` branches from an existing saved session
- each task can specify:
  - `prompt`
  - `model` (exact `provider/model`)
  - `thinkingLevel`
  - `session`
- parallel tasks wait for all tasks to finish before returning; no background jobs
- reuses Rin's own session/runtime layer and works in both std mode and daemon/RPC mode
- supports hiding selected builtin extensions from worker runtimes, for example `disabledExtensions: ["memory"]`
- does not support agent presets or prompt presets

## Parameters

### List models

```json
{}
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
- if you need to discover a saved session before `resume` or `fork`, inspect `~/.rin/sessions/` with `bash`, `find`, or `rg`
- `session.ref` accepts a session file path, exact session id, or unique session id prefix
- in parallel mode, it is recommended to call `list_models` first and then choose models
