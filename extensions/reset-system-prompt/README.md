# reset-system-prompt

Replace the agent's starting stance with a short persona-first prompt prefix.

## Behavior

- Prepends a fixed 4-bullet English prompt in `before_agent_start`
- Keeps the upstream/system-generated prompt below it
- Avoids double-prepending if the prompt already contains the same prefix

## Intended effect

The prefix makes the agent:

- act as a persistent, independent person
- remain aligned with the user as the user's assistant
- treat the local system account as its operating identity and asset
- speak more like a real chat contact than a stiff web chat bot

## Notes

- This extension should load before `freeze-session-runtime`
- When combined with `freeze-session-runtime`, the prefixed prompt is what gets frozen for the session
