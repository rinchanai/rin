# discover-attention-resources

Lists prompt-relevant local resource paths for a target directory.

## Purpose

When the agent shifts attention to a new directory, it may need to know which local prompt/context resources become relevant there.
This tool returns absolute paths only, so the agent can decide which files to read.

## Returned paths

This tool currently returns:

- ancestor `AGENTS.md`
- ancestor `CLAUDE.md`
- skill root directories under `<target>/.agents/skills/**` that contain `SKILL.md`

## Not returned

This tool intentionally does not return:

- global resources already injected into the session
- prompts
- themes
- extensions

## Output

The tool returns a JSON object like:

```json
{
  "paths": [
    "/abs/path/to/AGENTS.md",
    "/abs/path/to/.agents/skills/foo"
  ]
}
```
