import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const transport = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'rin-koishi', 'transport.js')).href)

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rin-transport-test-'))
  try {
    await fn(dir)
  } finally {
    await fs.rm(dir, { recursive: true, force: true })
  }
}

test('koishi transport buildPromptText appends file attachments only', () => {
  const result = transport.buildPromptText('hello', [
    { kind: 'file', path: '/tmp/a.txt', name: 'a.txt' },
    { kind: 'image', path: '/tmp/b.png', name: 'b.png' },
  ])
  assert.ok(result.includes('Attached files saved locally'))
  assert.ok(result.includes('a.txt: /tmp/a.txt'))
  assert.ok(!result.includes('b.png: /tmp/b.png'))
})

test('koishi transport restorePromptParts rebuilds image payloads from disk', async () => {
  await withTempDir(async (dir) => {
    const imagePath = path.join(dir, 'demo.png')
    await fs.writeFile(imagePath, Buffer.from('abc'))
    const restored = await transport.restorePromptParts({
      text: 'hi',
      startedAt: Date.now(),
      attachments: [{ kind: 'image', path: imagePath, name: 'demo.png', mimeType: 'image/png' }],
    })
    assert.equal(restored.text, 'hi')
    assert.equal(restored.images.length, 1)
    assert.equal(restored.images[0].mimeType, 'image/png')
  })
})
