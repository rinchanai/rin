import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const rootDir = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const relevance = await import(pathToFileURL(path.join(rootDir, 'dist', 'extensions', 'memory', 'relevance.js')).href)
const compile = await import(pathToFileURL(path.join(rootDir, 'dist', 'extensions', 'memory', 'compile.js')).href)

test('memory relevance scores docs and relations', () => {
  const docA = {
    id: 'a', title: 'SearXNG search', summary: 'search stack', content: 'Use SearXNG search adapter', resident_slot: '',
    scope: 'project', kind: 'knowledge', tags: ['search'], aliases: [], triggers: ['searxng'], exposure: 'recall', status: 'active', canonical: false,
  }
  const docB = {
    ...docA,
    id: 'b',
    title: 'Search notes',
    content: 'SearXNG tuning notes',
    triggers: ['search'],
  }
  assert.ok(relevance.lexicalScore('searxng', docA) > 0)
  assert.ok(relevance.relationScore(docA, docB).score > 0)
  assert.equal(relevance.shouldInjectRecentHistory('最近发生了什么'), true)
})

test('memory compile renders resident and recall context', () => {
  const docs = [
    {
      id: 'voice', title: 'Voice', summary: '', content: '简洁自然', resident_slot: 'core_voice_style', scope: 'global', kind: 'preference', tags: [], aliases: [], triggers: [],
      exposure: 'resident', fidelity: 'exact', status: 'active', canonical: true, updated_at: '2026-01-01T00:00:00.000Z',
    },
    {
      id: 'search-note', title: 'Search note', summary: 'Use SearXNG', content: 'Keep SearXNG design.', resident_slot: '', scope: 'project', kind: 'knowledge', tags: ['search'], aliases: [], triggers: ['searxng'],
      exposure: 'recall', fidelity: 'fuzzy', status: 'active', canonical: false, updated_at: '2026-01-01T00:00:00.000Z',
    },
  ]
  const out = compile.compileFromDocsAndEvents(docs, [], { updated_at: '', edges: [] }, { query: 'searxng' }, '/tmp/memory')
  assert.ok(out.resident.includes('[core_voice_style] 简洁自然'))
  assert.ok(out.recall_context.includes('Search note'))
})
