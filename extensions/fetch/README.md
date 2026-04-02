# fetch

Inject a narrow `fetch` tool for direct URL retrieval.

## Why it exists

`web_search` is good when the agent needs to find sources.

`fetch` is for the different case where the user already has a concrete URL and wants Rin to read or download it directly.

## Tool shape

- required: `url`
- optional: `mode`
  - `text`: fetch and extract readable text from pages
  - `raw`: fetch and return raw response text
  - `file`: download to disk
- optional: `outputPath` only for `mode="file"`

## Output

- `text` mode returns concise metadata plus readable page/body text
- `raw` mode returns concise metadata plus raw decoded response text
- `file` mode saves the resource locally and returns the saved path, mime type, and byte size

Text output is truncated to the normal tool limits, with the full response saved to a temp file when needed.
