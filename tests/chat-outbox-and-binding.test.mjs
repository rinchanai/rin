import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const outbox = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'rin-lib', 'chat-outbox.js')).href)
const binding = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'chat-bridge', 'session-binding.js')).href)

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rin-outbox-test-'))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('chat outbox enqueues payload on disk', async () => {
  await withTempDir(async (dir) => {
    const filePath = outbox.enqueueChatOutboxPayload(dir, { type: 'text_delivery', createdAt: new Date().toISOString(), chatKey: 'telegram:1', text: 'hello' })
    const stat = await fs.stat(filePath)
    assert.ok(stat.isFile())
  })
})

test('chat bridge session binding paths are stable', () => {
  const statePath = binding.chatStatePath('/tmp/rin-data', 'telegram:1')
  assert.ok(statePath.endsWith(path.join('chats', 'telegram', '1', 'state.json')))
})
