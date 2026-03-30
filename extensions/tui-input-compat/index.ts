import { Editor, matchesKey, type EditorTheme, type TUI } from '@mariozechner/pi-tui'
import type { ExtensionAPI } from '@mariozechner/pi-coding-agent'

class TuiInputCompatEditor extends Editor {
  actionHandlers = new Map<string, () => void>()
  onEscape?: () => void
  onCtrlD?: () => void
  onPasteImage?: () => void
  onExtensionShortcut?: (data: string) => boolean

  constructor(
    tui: TUI,
    theme: EditorTheme,
    private keybindings: { matches(data: string, action: string): boolean },
  ) {
    super(tui, theme)
  }

  onAction(action: string, handler: () => void): void {
    this.actionHandlers.set(action, handler)
  }

  handleInput(data: string): void {
    if (this.onExtensionShortcut?.(data)) return

    // Builtin compatibility aliases shared by std/rpc TUI through a forced extension.
    if (matchesKey(data, 'ctrl+j')) {
      this.insertTextAtCursor('\n')
      return
    }

    if (matchesKey(data, 'ctrl+m')) {
      if (!this.disableSubmit && this.onSubmit) {
        this.onSubmit(this.getText())
        return
      }
    }

    if (this.keybindings.matches(data, 'app.clipboard.pasteImage')) {
      this.onPasteImage?.()
      return
    }

    if (this.keybindings.matches(data, 'app.interrupt')) {
      if (!(this as any).isShowingAutocomplete?.()) {
        const handler = this.onEscape ?? this.actionHandlers.get('app.interrupt')
        if (handler) {
          handler()
          return
        }
      }
      super.handleInput(data)
      return
    }

    if (this.keybindings.matches(data, 'app.exit')) {
      if (this.getText().length === 0) {
        const handler = this.onCtrlD ?? this.actionHandlers.get('app.exit')
        if (handler) {
          handler()
          return
        }
      }
    }

    for (const [action, handler] of this.actionHandlers) {
      if (action !== 'app.interrupt' && action !== 'app.exit' && this.keybindings.matches(data, action)) {
        handler()
        return
      }
    }

    super.handleInput(data)
  }
}

export default function (pi: ExtensionAPI) {
  pi.on('session_start', (_event, ctx) => {
    ctx.ui.setEditorComponent((tui, theme, keybindings) => new TuiInputCompatEditor(tui, theme, keybindings as any))
  })
}
