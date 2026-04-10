import { truncateToWidth } from "@mariozechner/pi-tui";

import {
  loadRinInteractiveFooterModule,
  loadRinInteractiveModeModule,
  loadRinInteractiveThemeModule,
  loadRinSessionManagerModule,
  loadRinSessionSelectorModule,
} from "../rin-lib/loader.js";

const SESSION_STARTING_MESSAGE = "Creating session...";
const SESSION_RESUMING_MESSAGE = "Resuming session...";
const DAEMON_WAITING_MESSAGE = "Waiting daemon...";

function stopPendingToolTimers(target: any) {
  const pendingTools = target?.pendingTools;
  if (!pendingTools || typeof pendingTools.values !== "function") return;
  for (const component of pendingTools.values()) {
    const state = component?.rendererState;
    if (!state?.interval) continue;
    clearInterval(state.interval);
    state.interval = undefined;
    state.endedAt ??= Date.now();
    component.invalidate?.();
  }
}

let applied = false;

export async function applyRinTuiOverrides() {
  if (applied) return;
  applied = true;

  const [
    { FooterComponent },
    { InteractiveMode },
    { theme },
    { SessionManager },
    { SessionSelectorComponent },
  ] = (await Promise.all([
    loadRinInteractiveFooterModule(),
    loadRinInteractiveModeModule(),
    loadRinInteractiveThemeModule(),
    loadRinSessionManagerModule(),
    loadRinSessionSelectorModule(),
  ])) as any;

  const originalRender = FooterComponent?.prototype?.render;
  if (typeof originalRender === "function") {
    FooterComponent.prototype.render = function renderWithoutCwd(
      width: number,
    ) {
      const lines = originalRender.call(this, width);
      if (!Array.isArray(lines) || lines.length === 0) return lines;

      const sessionName = this?.session?.sessionManager?.getSessionName?.();
      const statsLine = lines[1] ?? lines[0];
      const nextLines = [];

      if (sessionName) {
        nextLines.push(
          truncateToWidth(
            theme.fg("dim", sessionName),
            width,
            theme.fg("dim", "..."),
          ),
        );
      }
      if (statsLine) nextLines.push(statsLine);
      for (const line of lines.slice(2)) {
        if (line) nextLines.push(line);
      }
      return nextLines;
    };
  }

  const originalUpdateTerminalTitle =
    InteractiveMode?.prototype?.updateTerminalTitle;
  if (typeof originalUpdateTerminalTitle === "function") {
    InteractiveMode.prototype.updateTerminalTitle =
      function updateTerminalTitleWithoutCwd() {
        const sessionName = this?.sessionManager?.getSessionName?.();
        this?.ui?.terminal?.setTitle?.(
          sessionName ? `π - ${sessionName}` : "π",
        );
      };
  }

  const originalShowSessionSelector =
    InteractiveMode?.prototype?.showSessionSelector;
  if (typeof originalShowSessionSelector === "function") {
    InteractiveMode.prototype.showSessionSelector =
      function showSessionSelectorFromRootSessionDir() {
        this.showSelector((done: any) => {
          const loadSessions = (onProgress?: any) =>
            SessionManager.list(
              this.sessionManager.getCwd(),
              this.sessionManager.getSessionDir(),
              onProgress,
            );
          const selector = new SessionSelectorComponent(
            loadSessions,
            loadSessions,
            async (sessionPath: string) => {
              done();
              await this.handleResumeSession(sessionPath);
            },
            () => {
              done();
              this.ui.requestRender();
            },
            () => {
              void this.shutdown();
            },
            () => this.ui.requestRender(),
            {
              renameSession: async (
                sessionFilePath: string,
                nextName: string | undefined,
              ) => {
                const next = (nextName ?? "").trim();
                if (!next) return;
                const mgr = SessionManager.open(sessionFilePath);
                mgr.appendSessionInfo(next);
              },
              showRenameHint: true,
              keybindings: this.keybindings,
            },
            this.sessionManager.getSessionFile(),
          );
          return { component: selector, focus: selector };
        });
      };
  }

  const originalStartWorkingAnimation =
    InteractiveMode?.prototype?.startWorkingAnimation;
  if (typeof originalStartWorkingAnimation === "function") {
    InteractiveMode.prototype.startWorkingAnimation =
      function startWorkingAnimationWithSessionBootHint(message?: string) {
        const isDefaultWorkingMessage =
          message == null || message === this?.defaultWorkingMessage;
        const hasAttachedSession = Boolean(
          this?.session?.sessionManager?.getSessionFile?.(),
        );
        const isHandlingRealAgentStart = Boolean(this?.__rinHandlingAgentStart);
        const nextMessage =
          isDefaultWorkingMessage &&
          !hasAttachedSession &&
          !isHandlingRealAgentStart
            ? SESSION_STARTING_MESSAGE
            : message;
        return originalStartWorkingAnimation.call(this, nextMessage);
      };
  }

  const originalHandleEvent = InteractiveMode?.prototype?.handleEvent;
  if (typeof originalHandleEvent === "function") {
    InteractiveMode.prototype.handleEvent =
      async function handleEventWithSessionBootState(event: any) {
        if (event?.type === "rin_status") {
          stopPendingToolTimers(this);
          const message =
            typeof event.message === "string" && event.message.trim()
              ? event.message.trim()
              : "";
          const hasActiveWork = Boolean(
            this?.session?.isStreaming || this?.session?.isCompacting,
          );
          const daemonUnavailable = Boolean(this?.session?.daemonUnavailable);
          const isSessionStatus =
            message === SESSION_STARTING_MESSAGE ||
            message === SESSION_RESUMING_MESSAGE;
          const shouldShowWaiting =
            event.phase !== "end" &&
            (daemonUnavailable || hasActiveWork) &&
            message === DAEMON_WAITING_MESSAGE;
          const shouldShowSessionStatus =
            event.phase !== "end" && isSessionStatus;

          if (shouldShowWaiting || shouldShowSessionStatus) {
            this.startWorkingAnimation?.(message);
          } else if (event.phase === "end") {
            if (daemonUnavailable) {
              this.startWorkingAnimation?.(DAEMON_WAITING_MESSAGE);
            } else if (hasActiveWork) {
              this.startWorkingAnimation?.(this?.defaultWorkingMessage);
            } else {
              this.stopWorkingAnimation?.();
            }
          }

          this.ui?.requestRender?.();
          return;
        }

        const isAgentStart = event?.type === "agent_start";
        this.__rinHandlingAgentStart = isAgentStart;
        try {
          return await originalHandleEvent.call(this, event);
        } finally {
          this.__rinHandlingAgentStart = false;
        }
      };
  }
}
