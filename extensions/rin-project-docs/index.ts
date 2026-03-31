import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

function getAgentDir() {
  const envDir = String(process.env.PI_CODING_AGENT_DIR || process.env.RIN_DIR || '').trim()
  return envDir || path.join(os.homedir(), '.rin')
}

function repoRootFromHere() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
}

function collectExistingPaths(candidates: string[]) {
  const results: string[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    if (!candidate || seen.has(candidate)) continue
    if (!fs.existsSync(candidate)) continue
    seen.add(candidate)
    results.push(candidate)
  }
  return results
}

function collectRinDocPaths() {
  const agentDir = getAgentDir()
  const repoRoot = repoRootFromHere()
  return collectExistingPaths([
    path.join(agentDir, 'docs', 'rin', 'README.md'),
    path.join(agentDir, 'docs', 'rin', 'runtime-layout.md'),
    path.join(agentDir, 'docs', 'rin', 'builtin-extensions.md'),
    path.join(agentDir, 'docs', 'rin', 'capabilities.md'),
    path.join(repoRoot, 'docs', 'rin', 'README.md'),
    path.join(repoRoot, 'docs', 'rin', 'runtime-layout.md'),
    path.join(repoRoot, 'docs', 'rin', 'builtin-extensions.md'),
    path.join(repoRoot, 'docs', 'rin', 'capabilities.md'),
  ])
}

function collectPiDocPaths() {
  const agentDir = getAgentDir()
  const repoRoot = repoRootFromHere()
  return collectExistingPaths([
    path.join(agentDir, 'docs', 'pi', 'README.md'),
    path.join(agentDir, 'docs', 'pi', 'CHANGELOG.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'extensions.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'themes.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'skills.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'prompt-templates.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'tui.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'keybindings.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'sdk.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'custom-provider.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'models.md'),
    path.join(agentDir, 'docs', 'pi', 'docs', 'packages.md'),
    path.join(agentDir, 'docs', 'pi', 'examples', 'README.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'README.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'CHANGELOG.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'extensions.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'themes.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'skills.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'prompt-templates.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'tui.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'keybindings.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'sdk.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'custom-provider.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'models.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'docs', 'packages.md'),
    path.join(repoRoot, 'third_party', 'pi-coding-agent', 'examples', 'README.md'),
  ])
}

function buildPromptBlock() {
  const rinDocs = collectRinDocPaths()
  const piDocs = collectPiDocPaths()
  if (!rinDocs.length && !piDocs.length) return ''

  const piReadme = piDocs.find((item) => item.endsWith('/README.md')) || piDocs[0]
  const piDocsDir = piDocs.find((item) => item.includes('/docs/extensions.md'))?.replace(/\/extensions\.md$/, '') || piDocs[0]
  const piExamplesDir = piDocs.find((item) => item.endsWith('/examples/README.md'))?.replace(/\/README\.md$/, '') || piDocs[0]
  const rinReadme = rinDocs.find((item) => item.endsWith('/README.md')) || rinDocs[0]
  const rinRuntimeLayout = rinDocs.find((item) => item.endsWith('/runtime-layout.md')) || rinDocs[0]
  const rinBuiltinExtensions = rinDocs.find((item) => item.endsWith('/builtin-extensions.md')) || rinDocs[0]
  const rinCapabilities = rinDocs.find((item) => item.endsWith('/capabilities.md')) || rinDocs[0]

  const lines: string[] = []

  if (piDocs.length) {
    lines.push(
      'Pi documentation (read only when the user asks about pi itself, its SDK, extensions, themes, skills, or TUI):',
      `- Main documentation: ${piReadme}`,
      `- Additional docs: ${piDocsDir}`,
      `- Examples: ${piExamplesDir} (extensions, custom tools, SDK)`,
      '- When asked about: extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)',
    )
  }

  if (rinDocs.length) {
    lines.push(
      'Rin documentation (read only when the user asks about Rin-specific behavior):',
      `- Main overview: ${rinReadme}`,
      `- Runtime layout: ${rinRuntimeLayout}`,
      `- Builtin extensions: ${rinBuiltinExtensions}`,
      `- Capabilities: ${rinCapabilities}`,
      '- On Rin topics, read runtime-layout.md first and prefer Rin docs over upstream pi docs.',
    )
  }

  return lines.join('\n')
}

export default function rinProjectDocsExtension(pi: ExtensionAPI) {
  pi.on('before_agent_start', async (event) => {
    const block = buildPromptBlock()
    if (!block) return {}

    const current = String(event.systemPrompt || '')
    if (current.includes(block)) {
      return { systemPrompt: current }
    }

    return {
      systemPrompt: `${current.trimEnd()}\n\n${block}`.trimEnd(),
    }
  })
}
