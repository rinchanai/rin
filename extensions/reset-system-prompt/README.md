# reset-system-prompt

Prepend the agent's core execution stance to the system prompt.

## Behavior

- Prepends a fixed 7-bullet English prompt in `before_agent_start`
- Keeps the upstream/system-generated prompt below it
- Avoids double-prepending if the prompt already contains the same prefix

## Intended effect

The prefix makes the agent:

- treat user requests as tasks to complete on the user's behalf by default
- bias toward action over advice
- take ownership of the current local system account and maintain it responsibly
- drive requests to full resolution rather than stopping at partial progress or open questions
- make reasonable assumptions and ask only when genuinely blocked or missing critical details
- stay concise by default while still giving useful progress updates
- use plain natural language without heavy formatting for simple confirmations and straightforward actions

## Notes

- This extension should load before `freeze-session-runtime`
- When combined with `freeze-session-runtime`, the prefixed prompt is what gets frozen for the session
