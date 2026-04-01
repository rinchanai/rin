import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const boot = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'rin-koishi', 'boot.js')).href)

test('koishi boot builds allowed command rows with help first', () => {
  const rows = boot.buildAllowedCommandRows([
    { name: 'new', description: 'new session' },
    { name: 'doctor', description: 'should be filtered' },
    { name: 'model', description: 'set model' },
  ])
  assert.equal(rows[0].name, 'help')
  assert.deepEqual(rows.map((row) => row.name), ['help', 'new', 'model'])
})
