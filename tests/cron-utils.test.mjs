import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const cronUtils = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'rin-daemon', 'cron-utils.js')).href)

test('cron utils normalize iso and summarize text', () => {
  assert.ok(cronUtils.normalizeIso('2026-03-31T12:00:00Z', 'startAt').endsWith('Z'))
  assert.equal(cronUtils.summarizeText('  hello\r\nworld  ', 20), 'hello\nworld')
})

test('cron utils compute next run for once and interval triggers', () => {
  const once = cronUtils.computeNextRunAt({
    id: 'a', createdAt: '', updatedAt: '', enabled: true, cwd: '', chatKey: undefined,
    trigger: { kind: 'once', runAt: '2026-03-31T12:00:00.000Z' }, session: { mode: 'dedicated' }, target: { kind: 'shell_command', command: 'echo hi' }, runCount: 0, running: false,
  }, Date.parse('2026-03-31T11:59:00.000Z'))
  assert.equal(once, '2026-03-31T12:00:00.000Z')

  const interval = cronUtils.computeNextRunAt({
    id: 'b', createdAt: '', updatedAt: '', enabled: true, cwd: '', chatKey: undefined,
    trigger: { kind: 'interval', intervalMs: 60_000, startAt: '2026-03-31T12:00:00.000Z' }, session: { mode: 'dedicated' }, target: { kind: 'shell_command', command: 'echo hi' }, runCount: 0, running: false,
  }, Date.parse('2026-03-31T11:50:00.000Z'))
  assert.equal(interval, '2026-03-31T12:00:00.000Z')
})

test('cron utils compute next cron tick', () => {
  const next = cronUtils.nextCronAt('5 * * * *', Date.parse('2026-03-31T12:00:00.000Z'))
  assert.equal(next, '2026-03-31T12:05:00.000Z')
})
