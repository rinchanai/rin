import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const query = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'rin-web-search', 'query.js')).href)
const paths = await import(pathToFileURL(path.join(rootDir, 'dist', 'core', 'rin-web-search', 'paths.js')).href)

test('web search query helpers normalize request', () => {
  const req = query.normalizeSearchRequest({ q: '  hello ', limit: 99, domains: ['a.com', 'a.com', 'b.com'] })
  assert.equal(req.q, 'hello')
  assert.equal(req.limit, 8)
  assert.deepEqual(req.domains, ['a.com', 'b.com'])
  assert.equal(query.buildSearchQuery(req), 'hello site:a.com site:b.com')
})

test('web search paths derive runtime locations', () => {
  const root = '/tmp/demo'
  assert.ok(paths.runtimeRootForState(root).endsWith(path.join('data', 'web-search', 'runtime')))
  assert.ok(paths.instanceStateFileForState(root, 'abc').endsWith(path.join('instances', 'abc', 'state.json')))
})
