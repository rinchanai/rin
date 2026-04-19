# fetch

Inject a narrow `fetch` tool for direct URL retrieval.

## Why it exists

`web_search` is good when the agent needs to find sources.

`fetch` is for the different case where the user already has a concrete URL and wants Rin to read it directly.

## Tool shape

- required: `url`

## Output

- returns concise metadata plus readable page/body text
- pretty-prints JSON and normalizes plain-text responses when possible
- rejects non-text responses instead of downloading files
- when truncation happens, saves the full response to a temp file and surfaces that path in the tool result

Text output is truncated to the normal tool limits, with the full response saved to a temp file when needed.
