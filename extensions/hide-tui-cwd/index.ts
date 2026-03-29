import { truncateToWidth, visibleWidth, type Component } from '@mariozechner/pi-tui'
import type { ExtensionAPI, ExtensionContext } from '@mariozechner/pi-coding-agent'

function sanitizeStatusText(text: string): string {
  return String(text || '').replace(/[\r\n\t]/g, ' ').replace(/ +/g, ' ').trim()
}

function formatTokens(count: number): string {
  if (count < 1000) return count.toString()
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`
  if (count < 1000000) return `${Math.round(count / 1000)}k`
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`
  return `${Math.round(count / 1000000)}M`
}

function titleForContext(ctx: ExtensionContext) {
  const sessionName = ctx.sessionManager.getSessionName()
  return sessionName ? `π - ${sessionName}` : 'π'
}

function footerFactory(ctx: ExtensionContext) {
  return (tui: any, theme: any, footerData: any): Component & { dispose?(): void } => {
    const onBranchChange = typeof footerData?.onBranchChange === 'function'
      ? footerData.onBranchChange(() => tui.requestRender())
      : undefined

    return {
      dispose() {
        try { onBranchChange?.() } catch {}
      },
      invalidate() {},
      render(width: number): string[] {
        let totalInput = 0
        let totalOutput = 0
        let totalCacheRead = 0
        let totalCacheWrite = 0
        let totalCost = 0

        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === 'message' && entry.message.role === 'assistant') {
            totalInput += Number(entry.message.usage?.input || 0)
            totalOutput += Number(entry.message.usage?.output || 0)
            totalCacheRead += Number(entry.message.usage?.cacheRead || 0)
            totalCacheWrite += Number(entry.message.usage?.cacheWrite || 0)
            totalCost += Number(entry.message.usage?.cost?.total || 0)
          }
        }

        const contextUsage = ctx.getContextUsage()
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0
        const contextPercentValue = Number(contextUsage?.percent || 0)
        const contextPercent = contextUsage?.percent !== null && contextUsage?.percent !== undefined
          ? contextPercentValue.toFixed(1)
          : '?'

        const sessionName = ctx.sessionManager.getSessionName()
        const statsParts: string[] = []
        if (totalInput) statsParts.push(`↑${formatTokens(totalInput)}`)
        if (totalOutput) statsParts.push(`↓${formatTokens(totalOutput)}`)
        if (totalCacheRead) statsParts.push(`R${formatTokens(totalCacheRead)}`)
        if (totalCacheWrite) statsParts.push(`W${formatTokens(totalCacheWrite)}`)

        const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false
        if (totalCost || usingSubscription) {
          statsParts.push(`$${totalCost.toFixed(3)}${usingSubscription ? ' (sub)' : ''}`)
        }

        const autoIndicator = ' (auto)'
        const contextPercentDisplay = contextPercent === '?'
          ? `?/${formatTokens(contextWindow)}${autoIndicator}`
          : `${contextPercent}%/${formatTokens(contextWindow)}${autoIndicator}`

        let contextPercentStr = contextPercentDisplay
        if (contextPercentValue > 90) contextPercentStr = theme.fg('error', contextPercentDisplay)
        else if (contextPercentValue > 70) contextPercentStr = theme.fg('warning', contextPercentDisplay)

        statsParts.push(contextPercentStr)
        let statsLeft = statsParts.join(' ')
        const modelName = ctx.model?.id || 'no-model'
        let statsLeftWidth = visibleWidth(statsLeft)
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, '...')
          statsLeftWidth = visibleWidth(statsLeft)
        }

        const minPadding = 2
        let rightSide = modelName
        if (ctx.model?.reasoning) {
          rightSide = `${modelName} • thinking`
        }
        if (footerData?.getAvailableProviderCount?.() > 1 && ctx.model) {
          const withProvider = `(${ctx.model.provider}) ${rightSide}`
          if (statsLeftWidth + minPadding + visibleWidth(withProvider) <= width) rightSide = withProvider
        }

        const rightSideWidth = visibleWidth(rightSide)
        const totalNeeded = statsLeftWidth + minPadding + rightSideWidth
        let statsLine: string
        if (totalNeeded <= width) {
          const padding = ' '.repeat(width - statsLeftWidth - rightSideWidth)
          statsLine = statsLeft + padding + rightSide
        } else {
          const availableForRight = width - statsLeftWidth - minPadding
          if (availableForRight > 0) {
            const truncatedRight = truncateToWidth(rightSide, availableForRight, '')
            const truncatedRightWidth = visibleWidth(truncatedRight)
            const padding = ' '.repeat(Math.max(0, width - statsLeftWidth - truncatedRightWidth))
            statsLine = statsLeft + padding + truncatedRight
          } else {
            statsLine = statsLeft
          }
        }

        const lines: string[] = []
        if (sessionName) {
          lines.push(truncateToWidth(theme.fg('dim', sessionName), width, theme.fg('dim', '...')))
        }

        const dimStatsLeft = theme.fg('dim', statsLeft)
        const remainder = statsLine.slice(statsLeft.length)
        const dimRemainder = theme.fg('dim', remainder)
        lines.push(dimStatsLeft + dimRemainder)

        const extensionStatuses = footerData?.getExtensionStatuses?.()
        if (extensionStatuses?.size) {
          const statusLine = Array.from(extensionStatuses.entries())
            .sort(([a]: any, [b]: any) => String(a).localeCompare(String(b)))
            .map(([, text]: any) => sanitizeStatusText(String(text || '')))
            .filter(Boolean)
            .join(' ')
          if (statusLine) lines.push(truncateToWidth(statusLine, width, theme.fg('dim', '...')))
        }

        return lines
      },
    }
  }
}

export default function hideTuiCwdExtension(pi: ExtensionAPI) {
  function apply(ctx: ExtensionContext) {
    if (!ctx.hasUI) return
    ctx.ui.setTitle(titleForContext(ctx))
    ctx.ui.setFooter(footerFactory(ctx))
  }

  pi.on('session_start', async (_event, ctx) => apply(ctx))
  pi.on('session_switch', async (_event, ctx) => apply(ctx))
}
