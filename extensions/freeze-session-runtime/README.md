# freeze-session-runtime

Freeze the effective system prompt of a session.

## Purpose

When developing prompts, resources, or extensions, the effective system prompt can change frequently.
That causes cache-prefix churn and increases token usage for long-running sessions.

This extension makes the session's system prompt stable by freezing the first effective system prompt it sees for that session branch.

## Behavior

- On the first real agent turn, the extension captures `event.systemPrompt` from `before_agent_start`.
- It stores that value in the session as a custom entry:
  - `frozen-system-prompt`
- On later turns, it always returns the frozen value instead of the newly computed prompt.
- When resuming, switching, navigating the tree, or forking, it restores the latest frozen prompt from the current branch.
- After `/reload`, the frozen prompt is cleared for the current process/session instance, and the next turn captures a fresh system prompt.
- After session compaction, the frozen prompt is also cleared so the next turn captures a fresh prompt instead of preserving the old cache prefix.

## Scope

This extension intentionally freezes only the system prompt.

It does **not** try to freeze:

- active tools
- provider request payloads
- tool schemas
- model settings
- UI settings

The goal is to keep behavior simple and predictable.

## Why it is implemented as a standard extension

This extension is written as a normal pi extension so it can:

- run on a regular pi installation
- be bundled as a builtin extension in this app
- stay independent from the RPC runtime implementation

## Session persistence

The frozen prompt is persisted into the session history as a custom entry.
That means an existing session keeps using the same frozen prompt after resume, unless `/reload` is used to refresh it.

## Notes

- If other extensions also modify the system prompt in `before_agent_start`, this extension should be loaded late so it freezes the final effective prompt.
- `/reload` is the explicit escape hatch when you want the current session to adopt a newly generated prompt.
