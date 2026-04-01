import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const mod = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'rin-tui', 'model-settings.js')).href)

test('tui model settings update detached session state locally', async () => {
  const target = {
    detachedBlankSession: true,
    model: null,
    state: {},
    settingsManager: { setDefaultModelAndProvider(provider, id) { target.last = `${provider}/${id}` }, setSteeringMode() {}, setFollowUpMode() {} },
    client: { send: () => Promise.resolve() },
    scopedModels: [],
    thinkingLevel: 'medium',
  }
  await mod.setRpcModel(target, { provider: 'openai', id: 'gpt-5' }, async () => {})
  assert.equal(target.last, 'openai/gpt-5')
  assert.equal(target.state.model.id, 'gpt-5')
  mod.setRpcSteeringMode(target, 'one-at-a-time')
  assert.equal(target.steeringMode, 'one-at-a-time')
})
