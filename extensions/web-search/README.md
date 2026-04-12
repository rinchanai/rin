# web-search

Inject a `web_search` tool backed by a local SearXNG sidecar.

## Architecture

- Each daemon or std TUI runtime starts its own sidecar instance on a random local port
- All runtimes share the same installed SearXNG source and virtualenv under `~/.rin/data/web-search/runtime/`
- The tool itself does not start the sidecar; if the sidecar is unavailable, the tool returns an error
- Search tries `google` first, then falls back to `bing`, then `duckduckgo`
- There is no user-facing web-search configuration surface

## Tool shape

The tool is intentionally narrow:

- required: `q`
- optional: `limit`, `domains`, `freshness`, `language`

## Output

- concise fresh-result text for the model
- structured normalized rows in `details`
