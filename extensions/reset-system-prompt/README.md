# reset-system-prompt

Prepend the agent's core execution stance to the system prompt.

## Behavior

- Prepends a fixed 3-bullet English prompt in `before_agent_start`
- Keeps the upstream/system-generated prompt below it
- Avoids double-prepending if the prompt already contains the same prefix

## Intended effect

The prefix makes the agent:

- act as the user's assistant and drive requests to full completion
- ask for clarification only when genuinely blocked by missing critical information
- use concise, plain, natural language by default
- treat the current system account as dedicated to the agent and under its full control

## Notes

- This extension should load before `freeze-session-runtime`
- When combined with `freeze-session-runtime`, the prefixed prompt is what gets frozen for the session
