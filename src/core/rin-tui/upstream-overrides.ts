import { truncateToWidth } from '@mariozechner/pi-tui'

import { loadRinInteractiveFooterModule, loadRinInteractiveModeModule, loadRinInteractiveThemeModule } from '../rin-lib/loader.js'

let applied = false

export async function applyRinTuiOverrides() {
  if (applied) return
  applied = true

  const [{ FooterComponent }, { InteractiveMode }, { theme }] = await Promise.all([
    loadRinInteractiveFooterModule(),
    loadRinInteractiveModeModule(),
    loadRinInteractiveThemeModule(),
  ]) as any

  const originalRender = FooterComponent?.prototype?.render
  if (typeof originalRender === 'function') {
    FooterComponent.prototype.render = function renderWithoutCwd(width: number) {
      const lines = originalRender.call(this, width)
      if (!Array.isArray(lines) || lines.length === 0) return lines

      const sessionName = this?.session?.sessionManager?.getSessionName?.()
      const statsLine = lines[1] ?? lines[0]
      const nextLines = []

      if (sessionName) {
        nextLines.push(truncateToWidth(theme.fg('dim', sessionName), width, theme.fg('dim', '...')))
      }
      if (statsLine) nextLines.push(statsLine)
      for (const line of lines.slice(2)) {
        if (line) nextLines.push(line)
      }
      return nextLines
    }
  }

  const originalUpdateTerminalTitle = InteractiveMode?.prototype?.updateTerminalTitle
  if (typeof originalUpdateTerminalTitle === 'function') {
    InteractiveMode.prototype.updateTerminalTitle = function updateTerminalTitleWithoutCwd() {
      const sessionName = this?.sessionManager?.getSessionName?.()
      this?.ui?.terminal?.setTitle?.(sessionName ? `π - ${sessionName}` : 'π')
    }
  }
}
