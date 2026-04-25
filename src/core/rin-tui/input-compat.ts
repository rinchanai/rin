import type { BuiltinModuleApi } from "../builtins/host.js";
import { CustomEditor } from "@mariozechner/pi-coding-agent";
import { matchesKey } from "@mariozechner/pi-tui";

class TuiInputCompatEditor extends CustomEditor {
  handleInput(data: string): void {
    // Compatibility alias for terminals / transport stacks that surface
    // Ctrl+J as the most reliable explicit newline shortcut.
    if (matchesKey(data, "ctrl+j")) {
      this.insertTextAtCursor("\n");
      return;
    }

    super.handleInput(data);
  }
}

export default function (pi: BuiltinModuleApi) {
  pi.on("session_start", (_event, ctx) => {
    ctx.ui.setEditorComponent(
      (tui, theme, keybindings) =>
        new TuiInputCompatEditor(tui, theme, keybindings),
    );
  });
}
