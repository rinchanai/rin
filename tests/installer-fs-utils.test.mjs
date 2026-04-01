import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const fsUtils = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'rin-install', 'fs-utils.js')).href)

test('installer fs utils compute launcher targets and script', () => {
  const targets = fsUtils.launcherTargetsForInstallDir('/tmp/rin')
  assert.ok(targets.rin[0].endsWith(path.join('dist', 'app', 'rin', 'main.js')))
  const script = fsUtils.launcherScript(['/tmp/a.js', '/tmp/b.js'])
  assert.ok(script.includes('installed runtime entry not found'))
  assert.ok(script.includes('/tmp/a.js'))
})
