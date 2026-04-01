import {
  CHRONICLE_TAG,
  EPISODE_TAG,
  MemoryDoc,
  MemoryEvent,
  MemoryRelationGraph,
  RESIDENT_SLOTS,
} from './core/types.js'
import { previewMemoryDoc } from './core/schema.js'
import { safeString, trimText } from './core/utils.js'
import { eventScore, excerptForRecall, lexicalScore, shouldInjectRecentHistory } from './relevance.js'

function residentPromptLine(slot: string, body: string): string {
  const text = safeString(body).trim()
  if (!text) return ''
  return `[${slot}] ${text}`
}

function progressiveIndexLine(doc: MemoryDoc): string {
  const desc = trimText(doc.summary || excerptForRecall(doc, '', 160) || 'Read this when relevant.', 180)
  return `- ${doc.title}: ${desc}`
}

function renderExpandedDoc(doc: MemoryDoc): string {
  return [`### ${doc.title}`, safeString(doc.content).trim()].filter(Boolean).join('\n\n')
}

function renderRecallContext(doc: MemoryDoc, query: string): string {
  const excerpt = excerptForRecall(doc, query, 260)
  const meta = [doc.scope, doc.kind].filter(Boolean).join(' • ')
  return [`- ${doc.title}${meta ? ` — ${meta}` : ''}`, excerpt].filter(Boolean).join('\n  ')
}

function renderRelatedContext(doc: MemoryDoc, reason: string, query: string): string {
  const excerpt = excerptForRecall(doc, query, 180)
  return [`- ${doc.title} (${reason || 'related'})`, excerpt].filter(Boolean).join('\n  ')
}

function renderHistoryEvent(event: MemoryEvent): string {
  return `- [${safeString(event.created_at).slice(0, 16).replace('T', ' ')}] ${event.summary}`
}

export function compileFromDocsAndEvents(docs: MemoryDoc[], events: MemoryEvent[], graph: MemoryRelationGraph, params: Record<string, any> = {}, root = '') {
  const query = safeString(params.query || '').trim()
  const resident = docs
    .filter((doc) => doc.exposure === 'resident' && doc.canonical && RESIDENT_SLOTS.includes(doc.resident_slot as any))
    .sort((a, b) => RESIDENT_SLOTS.indexOf(a.resident_slot as any) - RESIDENT_SLOTS.indexOf(b.resident_slot as any))
  const progressiveDocs = docs
    .filter((doc) => doc.exposure === 'progressive')
    .sort((a, b) => safeString(b.updated_at).localeCompare(safeString(a.updated_at)))
  const progressiveIndexLimit = Math.max(0, Number(params.progressiveLimit == null ? 12 : params.progressiveLimit) || 12)
  const expandedProgressiveLimit = Math.max(0, Number(params.expandedProgressiveLimit == null ? 2 : params.expandedProgressiveLimit) || 2)
  const recallLimit = Math.max(0, Number(params.recallLimit == null ? 3 : params.recallLimit) || 3)
  const historyLimit = Math.max(0, Number(params.historyLimit == null ? 3 : params.historyLimit) || 3)

  const expandedProgressives = !query ? [] : progressiveDocs
    .map((doc) => ({ doc, score: lexicalScore(query, doc) + (doc.scope === 'domain' ? 0.4 : 0) }))
    .filter((row) => row.score >= 0.9)
    .sort((a, b) => b.score - a.score || safeString(b.doc.updated_at).localeCompare(safeString(a.doc.updated_at)))
    .slice(0, expandedProgressiveLimit)
    .map((row) => row.doc)

  const episodeDocs = !query ? [] : docs
    .filter((doc) => doc.exposure === 'recall' && doc.tags.includes(EPISODE_TAG))
    .map((doc) => ({ doc, score: lexicalScore(query, doc) + 0.8 }))
    .filter((row) => row.score >= 1.1)
    .sort((a, b) => b.score - a.score || safeString(b.doc.updated_at).localeCompare(safeString(a.doc.updated_at)))
    .slice(0, 2)
    .map((row) => row.doc)

  const recallDocs = !query ? [] : docs
    .filter((doc) => doc.exposure === 'recall')
    .filter((doc) => !doc.tags.includes(EPISODE_TAG))
    .filter((doc) => episodeDocs.length === 0 || !doc.tags.includes(CHRONICLE_TAG))
    .filter((doc) => shouldInjectRecentHistory(query) || !doc.tags.includes(CHRONICLE_TAG))
    .map((doc) => ({ doc, score: lexicalScore(query, doc) }))
    .filter((row) => row.score >= 1.2)
    .sort((a, b) => b.score - a.score || safeString(b.doc.updated_at).localeCompare(safeString(a.doc.updated_at)))
    .slice(0, recallLimit)
    .map((row) => row.doc)

  const relatedDocs = (() => {
    if (!query) return [] as Array<{ reason: string, doc: MemoryDoc }>
    const seen = new Set<string>()
    const out: Array<{ reason: string, doc: MemoryDoc, score: number }> = []
    for (const edge of graph.edges) {
      if (![...expandedProgressives, ...recallDocs, ...episodeDocs].some((doc) => doc.id === edge.from)) continue
      const doc = docs.find((item) => item.id === edge.to)
      if (!doc) continue
      if (episodeDocs.length > 0 && doc.tags.includes(CHRONICLE_TAG)) continue
      if (recallDocs.some((item) => item.id === doc.id) || episodeDocs.some((item) => item.id === doc.id) || expandedProgressives.some((item) => item.id === doc.id)) continue
      if (seen.has(doc.id)) continue
      seen.add(doc.id)
      out.push({ reason: edge.reason, doc, score: edge.score })
      if (out.length >= 3) break
    }
    return out.sort((a, b) => b.score - a.score).map((row) => ({ reason: row.reason, doc: row.doc }))
  })()

  const history = !query || !shouldInjectRecentHistory(query) ? [] : events
    .map((event) => ({ event, score: eventScore(query, event) }))
    .filter((row) => row.score >= 1.2)
    .sort((a, b) => b.score - a.score || safeString(b.event.created_at).localeCompare(safeString(a.event.created_at)))
    .slice(0, historyLimit)
    .map((row) => row.event)

  return {
    root,
    query,
    resident_slots: RESIDENT_SLOTS,
    resident: resident.map((doc) => residentPromptLine(doc.resident_slot, doc.content)).filter(Boolean).join('\n'),
    progressive_index: progressiveDocs.slice(0, progressiveIndexLimit).map(progressiveIndexLine).join('\n'),
    progressive_expanded: expandedProgressives.map(renderExpandedDoc).join('\n\n'),
    episode_context: episodeDocs.map((doc) => renderExpandedDoc(doc)).join('\n\n'),
    recall_context: recallDocs.map((doc) => renderRecallContext(doc, query)).join('\n\n'),
    related_context: relatedDocs.map((row) => renderRelatedContext(row.doc, row.reason, query)).join('\n\n'),
    recent_history: history.map(renderHistoryEvent).join('\n'),
    resident_docs: resident.map(previewMemoryDoc),
    progressive_docs: progressiveDocs.slice(0, progressiveIndexLimit).map(previewMemoryDoc),
    expanded_progressives: expandedProgressives.map(previewMemoryDoc),
    episode_docs: episodeDocs.map(previewMemoryDoc),
    recall_docs: recallDocs.map(previewMemoryDoc),
    related_docs: relatedDocs.map((row) => ({ reason: row.reason, ...previewMemoryDoc(row.doc) })),
    history_events: history,
  }
}
