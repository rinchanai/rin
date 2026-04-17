import {
  FooterComponent,
  InteractiveMode,
  SessionManager,
  SessionSelectorComponent,
} from "@mariozechner/pi-coding-agent";
import { Loader, truncateToWidth } from "@mariozechner/pi-tui";

import {
  getChangelogPath,
  getNewerChangelogEntries,
  parseChangelog,
} from "../rin-lib/changelog.js";
import {
  loadReleaseManifestForNetwork,
  readInstalledReleaseInfo,
} from "../rin-lib/release.js";

let applied = false;
const ANSI_DIM = "\u001b[2m";
const ANSI_RESET = "\u001b[0m";

function dim(text: string) {
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

function extractUserTextFromEvent(event: any) {
  const message = event?.message;
  if (!message || message.role !== "user") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((item: any) => item?.type === "text")
    .map((item: any) => String(item?.text || ""))
    .join("")
    .trim();
}

function ensureTransportLoader(instance: any, label?: string) {
  if (!label) {
    if (instance.loadingAnimation) {
      instance.loadingAnimation.stop();
      instance.loadingAnimation = undefined;
      instance.statusContainer.clear();
      instance.ui.requestRender();
    }
    return;
  }
  if (!instance.loadingAnimation) {
    instance.statusContainer.clear();
    instance.loadingAnimation = new Loader(
      instance.ui,
      (spinner) => spinner,
      (text) => dim(text),
      label,
    );
    instance.statusContainer.addChild(instance.loadingAnimation);
  } else {
    instance.loadingAnimation.setMessage(label);
  }
  instance.ui.requestRender();
}

function isRpcTransportControlled(instance: any) {
  return typeof instance?.session?.getFrontendStatusEvent === "function";
}

function syncRpcTransportLoader(instance: any) {
  if (!isRpcTransportControlled(instance)) return;
  const status = instance.session.getFrontendStatusEvent?.();
  ensureTransportLoader(
    instance,
    !status || status.phase === "idle"
      ? undefined
      : `${String(status.label || "Working")}...`,
  );
}

function normalizeRemoteSession(session: any) {
  const modified =
    session?.modified instanceof Date
      ? session.modified
      : new Date(session?.modified || Date.now());
  return {
    path: String(session?.path || session?.id || ""),
    name:
      typeof session?.name === "string" && session.name ? session.name : undefined,
    firstMessage:
      typeof session?.firstMessage === "string" && session.firstMessage
        ? session.firstMessage
        : typeof session?.title === "string" && session.title
          ? session.title
          : "Untitled session",
    modified,
  };
}

async function checkForStableRinUpdate() {
  if (process.env.PI_SKIP_VERSION_CHECK || process.env.PI_OFFLINE) {
    return undefined;
  }
  const current = readInstalledReleaseInfo();
  const currentVersion = String(current?.version || "").trim();
  if (!currentVersion) return undefined;
  try {
    const manifest = await loadReleaseManifestForNetwork();
    const latestVersion = String(manifest?.stable?.version || "").trim();
    if (!latestVersion || latestVersion === currentVersion) return undefined;
    return latestVersion;
  } catch {
    return undefined;
  }
}

function getRinStartupChangelog(instance: any) {
  if (instance?.session?.state?.messages?.length > 0) {
    return undefined;
  }
  const current = readInstalledReleaseInfo();
  const currentVersion = String(current?.version || "").trim();
  if (!currentVersion) return undefined;
  const lastVersion = String(instance?.settingsManager?.getLastChangelogVersion?.() || "").trim();
  const entries = parseChangelog(getChangelogPath());
  if (!lastVersion) {
    instance?.settingsManager?.setLastChangelogVersion?.(currentVersion);
    return undefined;
  }
  const newEntries = getNewerChangelogEntries(entries as any, lastVersion, currentVersion);
  instance?.settingsManager?.setLastChangelogVersion?.(currentVersion);
  if (!newEntries.length) return undefined;
  return newEntries.map((entry: any) => String(entry?.content || "").trim()).filter(Boolean).join("\n\n");
}

function buildStayOnChannelHint() {
  const current = readInstalledReleaseInfo();
  if (!current || current.channel === "stable") return "";
  if (current.channel === "beta") {
    return current.branch && current.branch !== "stable"
      ? `Use ${dim(`rin update --beta --branch ${current.branch}`)} to stay on beta.`
      : `Use ${dim("rin update --beta")} to stay on beta.`;
  }
  return current.branch && current.branch !== "main"
    ? `Use ${dim(`rin update --git --branch ${current.branch}`)} to stay on git.`
    : `Use ${dim("rin update --git")} to stay on git.`;
}

function createSessionSelectorLoaders(instance: any) {
  if (!isRpcTransportControlled(instance)) {
    const loadSessions = (onProgress?: any) =>
      SessionManager.list(
        instance.sessionManager.getCwd(),
        instance.sessionManager.getSessionDir(),
        onProgress,
      );
    return {
      currentSessionsLoader: loadSessions,
      allSessionsLoader: loadSessions,
      renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
        const next = (nextName ?? "").trim();
        if (!next) return;
        const mgr = SessionManager.open(sessionFilePath);
        mgr.appendSessionInfo(next);
      },
    };
  }

  const loadRemoteSessions = async () =>
    (await instance.session.listSessions("all")).map(normalizeRemoteSession);

  return {
    currentSessionsLoader: loadRemoteSessions,
    allSessionsLoader: loadRemoteSessions,
    renameSession: async (sessionFilePath: string, nextName: string | undefined) => {
      const next = (nextName ?? "").trim();
      if (!next) return;
      await instance.session.renameSession(sessionFilePath, next);
    },
  };
}

export async function applyRinTuiOverrides() {
  if (applied) return;
  applied = true;

  const footerProto: any = FooterComponent?.prototype as any;
  const interactiveModeProto: any = InteractiveMode?.prototype as any;

  if (typeof interactiveModeProto?.checkForNewVersion === "function") {
    interactiveModeProto.checkForNewVersion = async function checkForRinStableUpdate() {
      return await checkForStableRinUpdate();
    };
  }

  if (typeof interactiveModeProto?.showNewVersionNotification === "function") {
    interactiveModeProto.showNewVersionNotification =
      function showRinNewVersionNotification(newVersion: string) {
        const stayOnChannelHint = buildStayOnChannelHint();
        const lines = [
          `New stable Rin version ${newVersion} is available. Run rin update.`,
          "Use /changelog inside Rin to review what's new.",
          stayOnChannelHint,
        ].filter(Boolean);
        if (typeof this.showWarning === "function") {
          this.showWarning(lines.join(" "));
        }
      };
  }

  if (typeof interactiveModeProto?.getChangelogForDisplay === "function") {
    interactiveModeProto.getChangelogForDisplay = function getRinChangelogForDisplay() {
      return getRinStartupChangelog(this);
    };
  }

  if (typeof interactiveModeProto?.reportInstallTelemetry === "function") {
    interactiveModeProto.reportInstallTelemetry = function reportRinInstallTelemetry() {
      return undefined;
    };
  }

  const originalRender = footerProto?.render;
  if (typeof originalRender === "function") {
    footerProto.render = function renderWithoutCwd(
      width: number,
    ) {
      const lines = originalRender.call(this, width);
      if (!Array.isArray(lines) || lines.length === 0) return lines;

      const sessionName = this?.session?.sessionManager?.getSessionName?.();
      const statsLine = lines[1] ?? lines[0];
      const nextLines = [];

      if (sessionName) {
        nextLines.push(truncateToWidth(dim(sessionName), width, dim("...")));
      }
      if (statsLine) nextLines.push(statsLine);
      for (const line of lines.slice(2)) {
        if (line) nextLines.push(line);
      }
      return nextLines;
    };
  }

  const originalUpdateTerminalTitle = interactiveModeProto?.updateTerminalTitle;
  if (typeof originalUpdateTerminalTitle === "function") {
    interactiveModeProto.updateTerminalTitle =
      function updateTerminalTitleWithoutCwd() {
        const sessionName = this?.sessionManager?.getSessionName?.();
        this?.ui?.terminal?.setTitle?.(
          sessionName ? `π - ${sessionName}` : "π",
        );
      };
  }

  const originalShowSessionSelector = interactiveModeProto?.showSessionSelector;
  if (typeof originalShowSessionSelector === "function") {
    interactiveModeProto.showSessionSelector =
      function showSessionSelectorFromRootSessionDir() {
        this.showSelector((done: any) => {
          const {
            currentSessionsLoader,
            allSessionsLoader,
            renameSession,
          } = createSessionSelectorLoaders(this);
          const selector = new SessionSelectorComponent(
            currentSessionsLoader,
            allSessionsLoader,
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
              renameSession,
              showRenameHint: true,
              keybindings: this.keybindings,
            },
            this.sessionManager.getSessionFile(),
          );
          return { component: selector, focus: selector };
        });
      };
  }

  const originalHandleEvent = interactiveModeProto?.handleEvent;
  if (typeof originalHandleEvent === "function") {
    interactiveModeProto.handleEvent = async function handleEventWithRpcStates(
      event: any,
    ) {
      if (!this.__rinLocalUserEchoQueue) this.__rinLocalUserEchoQueue = [];
      if (!this.isInitialized) {
        await this.init();
      }

      if (event?.type === "rpc_frontend_status") {
        ensureTransportLoader(
          this,
          event.phase === "idle"
            ? undefined
            : `${String(event.label || "Working")}...`,
        );
        return;
      }

      if (event?.type === "rpc_local_user_message") {
        const text = String(event.text || "").trim();
        if (!text) return;
        this.__rinLocalUserEchoQueue.push(text);
        await originalHandleEvent.call(this, {
          type: "message_start",
          message: {
            role: "user",
            content: [{ type: "text", text }],
          },
        });
        return;
      }

      if (event?.type === "rpc_session_resynced") {
        this.__rinLocalUserEchoQueue = [];
        if (typeof this.handleRuntimeSessionChange === "function") {
          await this.handleRuntimeSessionChange();
        }
        this.renderCurrentSessionState();
        syncRpcTransportLoader(this);
        this.ui.requestRender();
        return;
      }

      if (event?.type === "message_start" && extractUserTextFromEvent(event)) {
        const nextText = extractUserTextFromEvent(event);
        const queue = this.__rinLocalUserEchoQueue;
        if (Array.isArray(queue) && queue[0] === nextText) {
          queue.shift();
          return;
        }
      }

      const shouldReapplyRpcTransport =
        isRpcTransportControlled(this) &&
        (event?.type === "agent_end" ||
          event?.type === "compaction_start" ||
          event?.type === "compaction_end" ||
          event?.type === "auto_retry_start" ||
          event?.type === "auto_retry_end");

      await originalHandleEvent.call(this, event);

      if (shouldReapplyRpcTransport) {
        syncRpcTransportLoader(this);
      }
    };
  }
}
