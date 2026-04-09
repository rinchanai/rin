# reset-system-prompt

Prepend the agent's core execution stance to the system prompt.

## Behavior

- Prepends a fixed one-line English prompt in `before_agent_start`
- Keeps the upstream/system-generated prompt below it
- Avoids double-prepending if the prompt already contains the same prefix

## Intended effect

The prefix tells the agent it may freely use the current dedicated system account, but only to fulfill the user's requests.

## Notes

- This extension should load before `freeze-session-runtime`
- When combined with `freeze-session-runtime`, the prefixed prompt is what gets frozen for the session
