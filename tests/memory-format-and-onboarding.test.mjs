import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const format = await import(pathToFileURL(path.join(rootDir, 'dist', 'extensions', 'memory', 'format.js')).href)
const onboarding = await import(pathToFileURL(path.join(rootDir, 'dist', 'extensions', 'memory', 'onboarding.js')).href)

test('memory format builds compact compiled prompt', () => {
  const text = format.buildCompiledMemoryPrompt({ resident: '[core_voice_style] 简洁', recall_context: '- search note' })
  assert.ok(text.includes('## Resident Memory'))
  assert.ok(text.includes('## Relevant Recall'))
})

test('memory onboarding helper keeps hidden instructions and pending state', () => {
  const prompt = onboarding.buildOnboardingPrompt('manual')
  assert.ok(prompt.includes('Do not mention, quote, summarize'))
  assert.ok(prompt.includes('preferred language'))
})
