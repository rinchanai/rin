import os from "node:os";
import path from "node:path";

import { isContextOverflow } from "@mariozechner/pi-ai";

import { buildSystemPrompt } from "../../../third_party/pi-coding-agent/dist/core/system-prompt.js";
import { loadRinCodingAgent } from "./loader.js";
import {
  clearCompactionContinuationMarker,
  consumeCompactionContinuationMarker,
  getCompactionContinuationMarkerPath,
  writeCompactionContinuationMarker,
} from "./compaction-continuation.js";

function escapeXml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function formatSkillsForPrompt(skills: any[]) {
  const visibleSkills = (Array.isArray(skills) ? skills : []).filter(
    (skill) => skill && !skill.disableModelInvocation,
  );
  if (!visibleSkills.length) return "";
  const lines = [
    "Available skills provide specialized instructions for specific tasks.",
    "",
    "<available_skills>",
  ];
  for (const skill of visibleSkills) {
    lines.push("  <skill>");
    lines.push(`    <name>${escapeXml(String(skill.name || ""))}</name>`);
    lines.push(
      `    <description>${escapeXml(String(skill.description || ""))}</description>`,
    );
    lines.push("  </skill>");
  }
  lines.push("</available_skills>");
  return lines.join("\n");
}

function buildRinDocsBlock(agentDir: string) {
  const rinRoot = path.join(agentDir, "docs", "rin");
  const rinDocsRoot = path.join(rinRoot, "docs");
  const piRoot = path.join(agentDir, "docs", "pi");
  return [
    "Rin and Pi documentation:",
    `- Main Rin documentation: ${path.join(rinRoot, "README.md")}`,
    `- Additional Rin docs: ${rinDocsRoot}`,
    `- Main Pi documentation: ${path.join(piRoot, "README.md")}`,
    `- Additional Pi docs: ${path.join(piRoot, "docs")}`,
    "- Read documentation whenever the task needs details about the runtime this agent is currently running in, including operations, configuration, behavior, capabilities, layout, or other agent-operated details.",
    "- Rin is built on top of Pi. Use Pi docs as the base reference, then apply Rin docs as overrides or additions where Rin differs.",
    `- Topic map: Rin overrides (docs/pi-overrides.md), runtime layout (docs/runtime-layout.md), builtin extensions (docs/builtin-extensions.md), capabilities (docs/capabilities.md); Pi examples (${path.join(piRoot, "examples")}: extensions, custom tools, SDK), extensions (docs/extensions.md, examples/extensions/), themes (docs/themes.md), skills (docs/skills.md), prompt templates (docs/prompt-templates.md), TUI components (docs/tui.md), keybindings (docs/keybindings.md), SDK integrations (docs/sdk.md), custom providers (docs/custom-provider.md), adding models (docs/models.md), pi packages (docs/packages.md)`,
  ].join("\n");
}

function formatAgentsFilesForPrompt(
  agentsFiles: Array<{ path: string; content: string }>,
) {
  const rows = Array.isArray(agentsFiles) ? agentsFiles : [];
  if (!rows.length) return "";
  const lines = [
    "# Project Context",
    "",
    "Project-specific instructions and guidelines:",
    "",
  ];
  for (const { path: filePath, content } of rows) {
    lines.push(`## ${filePath}`);
    lines.push("");
    lines.push(String(content || "").trim());
    lines.push("");
  }
  return lines.join("\n").trim();
}

export function getManagedSkillPaths(agentDir: string): string[] {
  const root = String(agentDir || "").trim() || path.join(os.homedir(), ".rin");
  return [
    path.join(root, "self_improve", "skills"),
    path.join(root, "docs", "rin", "builtin-skills"),
  ];
}

function extractPiGuidelinesBlock(prompt: string) {
  const text = String(prompt || "");
  const startMarker = "Guidelines:\n";
  const endMarker = "\n\nPi documentation";
  const start = text.indexOf(startMarker);
  if (start < 0) return [] as string[];
  const afterStart = start + startMarker.length;
  const end = text.indexOf(endMarker, afterStart);
  const block = end >= 0 ? text.slice(afterStart, end) : text.slice(afterStart);
  return block
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

function buildRinSystemPrompt(session: any, toolNames: string[]) {
  const validToolNames = toolNames.filter((name) =>
    session._toolRegistry.has(name),
  );
  const toolSnippets: Record<string, string> = {};
  const promptGuidelines: string[] = [];
  for (const name of validToolNames) {
    const snippet = session._toolPromptSnippets.get(name);
    if (snippet) toolSnippets[name] = snippet;
    const toolGuidelineSet = session._toolPromptGuidelines.get(name);
    if (toolGuidelineSet) promptGuidelines.push(...toolGuidelineSet);
  }

  const promptAgentDir =
    session._resourceLoader.agentDir ||
    process.env.RIN_DIR ||
    path.join(os.homedir(), ".rin");
  const managedSkillPaths = getManagedSkillPaths(promptAgentDir);

  const uniqueGuidelines: string[] = [];
  const seen = new Set<string>();
  const addGuideline = (value: string) => {
    const normalized = String(value || "")
      .trim()
      .replace(/\.$/, "");
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    uniqueGuidelines.push(normalized);
  };

  const hasRead = validToolNames.includes("read");

  const piGuidelines = extractPiGuidelinesBlock(
    buildSystemPrompt({
      selectedTools: validToolNames,
      toolSnippets,
      promptGuidelines,
      skills: [],
      contextFiles: [],
    }),
  );
  for (const guideline of piGuidelines) {
    addGuideline(guideline);
  }

  const skillGuidanceBlock = [
    "Self improve skills guidance:",
    `- Save reusable procedures, workflows, checklists, and playbooks as skills under ${managedSkillPaths[0]} instead of save_prompts content`,
    "- If a prompt slot accumulates extensive detail on a single topic, extract it into a self improve skill and leave only a compact reference in save_prompts",
    "- When creating or substantially revising a skill, use the skill-creator skill if it is available",
  ].join("\n");

  const toolsList =
    validToolNames.length > 0
      ? validToolNames
          .filter((name) => Boolean(toolSnippets[name]))
          .map((name) => `- ${name}: ${toolSnippets[name]}`)
          .join("\n") || "(none)"
      : "(none)";

  const guidelines = uniqueGuidelines.map((g) => `- ${g}`).join("\n");
  const loaderSystemPrompt = session._resourceLoader.getSystemPrompt();
  const appendSystemPromptList =
    session._resourceLoader.getAppendSystemPrompt();
  const appendSystemPrompt =
    appendSystemPromptList.length > 0
      ? appendSystemPromptList.join("\n\n")
      : "";
  const loadedSkills = session._resourceLoader.getSkills().skills;
  const loadedContextFiles =
    session._resourceLoader.getAgentsFiles().agentsFiles;
  const docsBlock = buildRinDocsBlock(promptAgentDir);

  let prompt = String(loaderSystemPrompt || "").trim();
  if (!prompt) {
    prompt = [
      "Available tools:",
      toolsList,
      "",
      "In addition to the tools above, you may have access to other custom tools depending on the project.",
      "",
      "Guidelines:",
      guidelines,
      "",
      skillGuidanceBlock,
      "",
      docsBlock,
    ].join("\n");
  } else {
    prompt = [prompt, docsBlock].filter(Boolean).join("\n\n");
  }

  if (appendSystemPrompt) prompt += `\n\n${appendSystemPrompt}`;

  const agentsBlock = formatAgentsFilesForPrompt(loadedContextFiles);
  if (agentsBlock) {
    prompt += `\n\n${agentsBlock}`;
  }
  if (hasRead && loadedSkills.length > 0) {
    prompt += `\n\n${formatSkillsForPrompt(loadedSkills)}`;
  }
  return prompt.trimEnd();
}

function applyRinPromptBuilder(session: any) {
  if (!session || typeof session !== "object") return;
  const originalRebuild =
    typeof session._rebuildSystemPrompt === "function"
      ? session._rebuildSystemPrompt.bind(session)
      : null;
  if (!originalRebuild) return;

  session._rebuildSystemPrompt = (toolNames: string[]) => {
    try {
      return buildRinSystemPrompt(
        session,
        Array.isArray(toolNames) ? toolNames : [],
      );
    } catch {
      return originalRebuild(toolNames);
    }
  };

  let activeToolNames: string[] = [];
  try {
    if (typeof session.getActiveToolNames === "function") {
      activeToolNames = session.getActiveToolNames();
    }
  } catch {}

  try {
    const next = session._rebuildSystemPrompt(activeToolNames);
    if (String(next || "").trim()) {
      session._baseSystemPrompt = next;
      if (session.agent?.state && typeof session.agent.state === "object") {
        session.agent.state.systemPrompt = next;
      }
      if (typeof session.agent?.setSystemPrompt === "function") {
        session.agent.setSystemPrompt(next);
      }
    }
  } catch {}
}

const AUTO_RELOAD_AFTER_COMPACTION_KEY = Symbol.for(
  "rin.autoReloadAfterCompaction",
);
const OVERFLOW_CONTINUATION_PROMPT_KEY = Symbol.for(
  "rin.overflowContinuationPrompt",
);
const MID_TURN_COMPACTION_KEY = Symbol.for("rin.midTurnCompaction");
const DISABLE_END_TURN_THRESHOLD_KEY = Symbol.for(
  "rin.disableEndTurnThresholdCompaction",
);
const TERMINAL_STATE_CONFIRMATION_KEY = Symbol.for(
  "rin.terminalStateConfirmation",
);
const TERMINATION_PROBE_FINAL_TOKEN = "__RIN_FINAL__";
const TERMINATION_PROBE_PROMPT =
  "Determine whether the current task has truly reached a terminal state. Reply with exactly one token only: __RIN_FINAL__ or __RIN_CONTINUE__. Return __RIN_FINAL__ only if the task is actually complete or genuinely blocked waiting for the user. Otherwise return __RIN_CONTINUE__.";
const HIDDEN_CONTINUE_NUDGE = "Continue working on the current task.";
const DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT = 88;
const MID_TURN_CONTINUATION_BLOCK = [
  "Context compacted; treat this as a routine internal checkpoint.",
  "Resume the current task immediately from its current state.",
  "Execute the next concrete step directly without narration.",
  "If work remains, keep doing it.",
].join("\n");

function getTerminalStatePatch(session: any) {
  let patch = session?.[TERMINAL_STATE_CONFIRMATION_KEY];
  if (patch) return patch;
  patch = {
    promise: undefined as Promise<void> | undefined,
    resolve: undefined as (() => void) | undefined,
    hiddenUserMessageTimestamps: new Set<number>(),
    suppressNextAgentStart: false,
    pendingAgentEndEvent: undefined as any,
    bufferedAssistantMessageEndEvent: undefined as any,
  };
  session[TERMINAL_STATE_CONFIRMATION_KEY] = patch;
  return patch;
}

function createTerminalStatePromiseIfNeeded(session: any, event: any) {
  const patch = getTerminalStatePatch(session);
  if (
    event?.type !== "agent_end" ||
    patch.promise ||
    !shouldConfirmTerminalState(session, event)
  ) {
    return;
  }
  patch.promise = new Promise<void>((resolve) => {
    patch.resolve = resolve;
  });
}

function resolveTerminalStatePromise(session: any) {
  const patch = getTerminalStatePatch(session);
  if (patch.resolve) {
    patch.resolve();
  }
  patch.resolve = undefined;
  patch.promise = undefined;
  patch.pendingAgentEndEvent = undefined;
}

async function waitForTerminalStatePromise(session: any) {
  const patch = getTerminalStatePatch(session);
  if (!patch.promise) return;
  await patch.promise;
  await session.agent.waitForIdle();
}

function findLastAssistantInMessages(messages: any[]) {
  for (let i = (Array.isArray(messages) ? messages : []).length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === "assistant") return message;
  }
  return undefined;
}

function shouldConfirmTerminalState(_session: any, event: any) {
  if (event?.type !== "agent_end") return false;
  const lastAssistant = findLastAssistantInMessages(event.messages);
  if (!lastAssistant) return false;
  return (
    lastAssistant.stopReason !== "error" &&
    lastAssistant.stopReason !== "aborted"
  );
}

function createHiddenUserMessage(text: string) {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

function isHiddenUserMessage(session: any, message: any) {
  const patch = getTerminalStatePatch(session);
  return (
    message?.role === "user" &&
    patch.hiddenUserMessageTimestamps.has(Number(message.timestamp))
  );
}

function isHiddenUserLifecycleEvent(session: any, event: any) {
  return (
    (event?.type === "message_start" || event?.type === "message_end") &&
    isHiddenUserMessage(session, event?.message)
  );
}

function removeHiddenUserMessageFromState(session: any, timestamp: number) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  session.agent.state.messages = messages.filter(
    (message: any) =>
      !(message?.role === "user" && Number(message.timestamp) === timestamp),
  );
}

function sanitizeAgentEndEvent(session: any, event: any) {
  if (event?.type !== "agent_end") return event;
  const patch = getTerminalStatePatch(session);
  const rawMessages = Array.isArray(event.messages) ? event.messages : [];
  const bufferedTimestamp = Number(
    patch.bufferedAssistantMessageEndEvent?.message?.timestamp,
  );
  const messages = rawMessages.filter((message) => {
    if (isHiddenUserMessage(session, message)) {
      return false;
    }
    if (
      Number.isFinite(bufferedTimestamp) &&
      message?.role === "assistant" &&
      Number(message?.timestamp) === bufferedTimestamp
    ) {
      return false;
    }
    return true;
  });
  for (const message of rawMessages) {
    if (isHiddenUserMessage(session, message)) {
      patch.hiddenUserMessageTimestamps.delete(Number(message?.timestamp));
    }
  }
  return messages.length === rawMessages.length ? event : { ...event, messages };
}

function extractAssistantText(message: any) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((part) => part?.type === "text")
    .map((part) => String(part.text || ""))
    .join("")
    .trim();
}

function parseAssistantTextPhase(signature: unknown) {
  if (typeof signature !== "string" || !signature.startsWith("{")) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(signature) as { phase?: unknown };
    return parsed.phase === "commentary" || parsed.phase === "final_answer"
      ? parsed.phase
      : undefined;
  } catch {
    return undefined;
  }
}

function buildVisibleAssistantMessageUpdateEvent(event: any) {
  if (event?.type !== "message_update" || event?.message?.role !== "assistant") {
    return event;
  }
  const content = Array.isArray(event.message.content) ? event.message.content : [];
  let sawPhasedText = false;
  const visibleContent = content.filter((part: any) => {
    if (part?.type !== "text") {
      return false;
    }
    const phase = parseAssistantTextPhase(part.textSignature);
    if (phase != null) {
      sawPhasedText = true;
    }
    return phase === "commentary";
  });
  if (visibleContent.length > 0) {
    return {
      ...event,
      message: {
        ...event.message,
        content: visibleContent,
      },
    };
  }
  if (sawPhasedText) {
    return null;
  }
  return null;
}

function removeAssistantMessageFromState(session: any, timestamp: number) {
  const messages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  session.agent.state.messages = messages.filter(
    (message: any) =>
      !(message?.role === "assistant" && Number(message.timestamp) === timestamp),
  );
}

async function flushBufferedAssistantMessageEnd(
  session: any,
  originalProcessAgentEvent: (event: any) => Promise<void>,
) {
  const patch = getTerminalStatePatch(session);
  const event = patch.bufferedAssistantMessageEndEvent;
  if (!event) {
    return;
  }
  patch.bufferedAssistantMessageEndEvent = undefined;
  await originalProcessAgentEvent(event);
}

function discardBufferedAssistantMessageEnd(session: any) {
  const patch = getTerminalStatePatch(session);
  const event = patch.bufferedAssistantMessageEndEvent;
  if (!event) {
    return;
  }
  patch.bufferedAssistantMessageEndEvent = undefined;
  removeAssistantMessageFromState(session, Number(event.message?.timestamp));
}

async function runTerminalStateProbe(session: any) {
  const snapshotMessages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages.slice()
    : [];
  const snapshotTools = Array.isArray(session?.agent?.state?.tools)
    ? session.agent.state.tools.slice()
    : [];
  const probeMessage = createHiddenUserMessage(TERMINATION_PROBE_PROMPT);

  session._disconnectFromAgent?.();
  try {
    session.agent.state.tools = [];
    await session.agent.prompt(probeMessage);
    const lastAssistant = findLastAssistantInMessages(session.agent.state.messages);
    if (
      !lastAssistant ||
      lastAssistant.stopReason === "error" ||
      lastAssistant.stopReason === "aborted"
    ) {
      return true;
    }
    return extractAssistantText(lastAssistant) === TERMINATION_PROBE_FINAL_TOKEN;
  } catch {
    return true;
  } finally {
    session.agent.state.messages = snapshotMessages;
    session.agent.state.tools = snapshotTools;
    session._reconnectToAgent?.();
  }
}

async function resolveTerminalStateForAgentEnd(
  session: any,
  originalProcessAgentEvent: (event: any) => Promise<void>,
  event: any,
) {
  const patch = getTerminalStatePatch(session);
  try {
    if (patch.pendingAgentEndEvent !== event) return;

    const shouldStop = await runTerminalStateProbe(session);
    if (patch.pendingAgentEndEvent !== event) return;

    patch.pendingAgentEndEvent = undefined;
    if (shouldStop) {
      await flushBufferedAssistantMessageEnd(session, originalProcessAgentEvent);
      await originalProcessAgentEvent(sanitizeAgentEndEvent(session, event));
      resolveTerminalStatePromise(session);
      return;
    }

    discardBufferedAssistantMessageEnd(session);
    const continueMessage = createHiddenUserMessage(HIDDEN_CONTINUE_NUDGE);
    patch.hiddenUserMessageTimestamps.add(Number(continueMessage.timestamp));
    patch.suppressNextAgentStart = true;
    await session.agent.prompt(continueMessage);
  } catch {
    if (patch.pendingAgentEndEvent !== event) return;
    patch.pendingAgentEndEvent = undefined;
    await flushBufferedAssistantMessageEnd(session, originalProcessAgentEvent);
    await originalProcessAgentEvent(sanitizeAgentEndEvent(session, event));
    resolveTerminalStatePromise(session);
  }
}

export function applyTerminalStateConfirmation(session: any) {
  if (!session || typeof session !== "object") return;
  if (session[TERMINAL_STATE_CONFIRMATION_KEY]?.applied) return;

  const originalHandleAgentEvent =
    typeof session._handleAgentEvent === "function"
      ? session._handleAgentEvent.bind(session)
      : null;
  const originalProcessAgentEvent =
    typeof session._processAgentEvent === "function"
      ? session._processAgentEvent.bind(session)
      : null;
  const originalPrompt =
    typeof session.prompt === "function" ? session.prompt.bind(session) : null;
  const originalSendCustomMessage =
    typeof session.sendCustomMessage === "function"
      ? session.sendCustomMessage.bind(session)
      : null;
  const originalAbort =
    typeof session.abort === "function" ? session.abort.bind(session) : null;

  if (
    !originalHandleAgentEvent ||
    !originalProcessAgentEvent ||
    !originalPrompt ||
    !originalAbort
  ) {
    return;
  }

  const patch = getTerminalStatePatch(session);
  patch.applied = true;

  session._handleAgentEvent = (event: any) => {
    createTerminalStatePromiseIfNeeded(session, event);
    return originalHandleAgentEvent(event);
  };

  session._processAgentEvent = async (event: any) => {
    if (isHiddenUserLifecycleEvent(session, event)) {
      if (event?.type === "message_end" && event?.message?.role === "user") {
        removeHiddenUserMessageFromState(session, Number(event.message.timestamp));
      }
      return;
    }

    if (event?.type === "message_update" && event?.message?.role === "assistant") {
      const visibleEvent = buildVisibleAssistantMessageUpdateEvent(event);
      if (!visibleEvent) {
        return;
      }
      await originalProcessAgentEvent(visibleEvent);
      return;
    }

    if (
      event?.type === "message_end" &&
      event?.message?.role === "assistant"
    ) {
      patch.bufferedAssistantMessageEndEvent = event;
      return;
    }

    if (event?.type === "agent_start" && patch.suppressNextAgentStart) {
      patch.suppressNextAgentStart = false;
      return;
    }

    if (event?.type === "agent_end" && shouldConfirmTerminalState(session, event)) {
      patch.pendingAgentEndEvent = event;
      setTimeout(() => {
        void resolveTerminalStateForAgentEnd(
          session,
          originalProcessAgentEvent,
          event,
        );
      }, 0);
      return;
    }

    if (patch.bufferedAssistantMessageEndEvent) {
      await flushBufferedAssistantMessageEnd(session, originalProcessAgentEvent);
    }

    if (event?.type === "agent_end") {
      await originalProcessAgentEvent(sanitizeAgentEndEvent(session, event));
      if (patch.promise) {
        resolveTerminalStatePromise(session);
      }
      return;
    }

    await originalProcessAgentEvent(event);
  };

  session.prompt = async (...args: any[]) => {
    await originalPrompt(...args);
    await waitForTerminalStatePromise(session);
  };

  if (originalSendCustomMessage) {
    session.sendCustomMessage = async (...args: any[]) => {
      await originalSendCustomMessage(...args);
      const options = args[1];
      if (options?.triggerTurn) {
        await waitForTerminalStatePromise(session);
      }
    };
  }

  session.abort = async (...args: any[]) => {
    patch.pendingAgentEndEvent = undefined;
    patch.suppressNextAgentStart = false;
    discardBufferedAssistantMessageEnd(session);
    resolveTerminalStatePromise(session);
    await originalAbort(...args);
  };

  session._disconnectFromAgent?.();
  session._reconnectToAgent?.();
}

function estimateLlmContextTokens(messages: any[]) {
  let chars = 0;
  for (const message of Array.isArray(messages) ? messages : []) {
    const content = Array.isArray(message?.content) ? message.content : [];
    for (const part of content) {
      if (part?.type === "text") chars += String(part.text || "").length;
      else if (part?.type === "image") chars += 4800;
      else chars += JSON.stringify(part || "").length;
    }
    chars += 32;
  }
  return Math.ceil(chars / 4);
}

function mutateMessageArray(target: any[], source: any[]) {
  if (!Array.isArray(target)) return;
  target.length = 0;
  for (const item of Array.isArray(source) ? source : []) target.push(item);
}

function buildMidTurnLlmContext(session: any, systemPrompt: string, tools: any[]) {
  const rawMessages = Array.isArray(session?.agent?.state?.messages)
    ? session.agent.state.messages
    : [];
  const converted = session?.agent?.convertToLlm
    ? session.agent.convertToLlm(rawMessages)
    : rawMessages;
  return Promise.resolve(converted).then((messages: any[]) => ({
    systemPrompt: systemPrompt
      ? `${systemPrompt}\n\n${MID_TURN_CONTINUATION_BLOCK}`
      : MID_TURN_CONTINUATION_BLOCK,
    messages,
    tools,
  }));
}

export function applyOverflowContinuationPrompt(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[OVERFLOW_CONTINUATION_PROMPT_KEY]) return;
  if (typeof session.subscribe !== "function") return;

  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type !== "compaction_end") return;
    if (event?.aborted || !event?.result) return;
    if (String(event?.reason || "").trim() !== "overflow") return;
    writeCompactionContinuationMarker(session, {
      reason: "overflow",
    });
  });

  (session as any)[OVERFLOW_CONTINUATION_PROMPT_KEY] = { unsubscribe };
}

export function applyDisableEndTurnThresholdCompaction(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[DISABLE_END_TURN_THRESHOLD_KEY]) return;
  const original =
    typeof session._checkCompaction === "function"
      ? session._checkCompaction.bind(session)
      : null;
  if (!original) return;

  session._checkCompaction = async function patchedCheckCompaction(
    assistantMessage: any,
    skipAbortedCheck = true,
  ) {
    const contextWindow = Number(session.model?.contextWindow || 0);
    if (isContextOverflow(assistantMessage, contextWindow)) {
      return await original(assistantMessage, skipAbortedCheck);
    }
    return;
  };

  (session as any)[DISABLE_END_TURN_THRESHOLD_KEY] = { original };
}

export function applyMidTurnCompaction(
  session: any,
  thresholdPercent = DEFAULT_AUTO_COMPACTION_THRESHOLD_PERCENT,
) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[MID_TURN_COMPACTION_KEY]) return;
  const agent = session.agent;
  if (!agent || typeof agent.streamFn !== "function") return;

  const originalStreamFn = agent.streamFn.bind(agent);
  const originalTransformContext =
    typeof agent.transformContext === "function"
      ? agent.transformContext.bind(agent)
      : null;

  let inPreflight = false;
  let injectCueForCurrentCall = false;

  agent.transformContext = async (messages: any[], signal?: AbortSignal) => {
    const transformed = originalTransformContext
      ? await originalTransformContext(messages, signal)
      : messages;

    if (inPreflight) return transformed;
    const contextWindow = Number(session.model?.contextWindow || 0);
    if (contextWindow <= 0) return transformed;

    const convertedForEstimate = agent?.convertToLlm
      ? await Promise.resolve(agent.convertToLlm(transformed))
      : transformed;
    const usageTokens = estimateLlmContextTokens(convertedForEstimate);
    const usagePercent = (usageTokens / contextWindow) * 100;
    if (usagePercent < thresholdPercent) return transformed;

    inPreflight = true;
    try {
      await session._runAutoCompaction?.("threshold", false);
      const compactedMessages = Array.isArray(session?.agent?.state?.messages)
        ? session.agent.state.messages
        : transformed;
      mutateMessageArray(messages, compactedMessages);
      injectCueForCurrentCall = true;
      return compactedMessages;
    } finally {
      inPreflight = false;
    }
  };

  agent.streamFn = async (model: any, context: any, options: any) => {
    if (!injectCueForCurrentCall) {
      return await originalStreamFn(model, context, options);
    }
    injectCueForCurrentCall = false;
    const nextContext = await buildMidTurnLlmContext(
      session,
      String(context?.systemPrompt || ""),
      context?.tools,
    );
    return await originalStreamFn(model, nextContext, options);
  };

  (session as any)[MID_TURN_COMPACTION_KEY] = {
    thresholdPercent,
    originalStreamFn,
    originalTransformContext,
  };
}

export function applyAutoReloadAfterCompaction(session: any) {
  if (!session || typeof session !== "object") return;
  if ((session as any)[AUTO_RELOAD_AFTER_COMPACTION_KEY]) return;
  if (typeof session.subscribe !== "function") return;
  if (typeof session.reload !== "function") return;

  let reloadInFlight: Promise<void> | null = null;
  let reloadQueued = false;

  const runReload = () => {
    if (reloadInFlight) {
      reloadQueued = true;
      return reloadInFlight;
    }

    reloadInFlight = (async () => {
      try {
        await session.reload();
      } catch {}
    })().finally(() => {
      reloadInFlight = null;
      if (!reloadQueued) return;
      reloadQueued = false;
      setTimeout(() => {
        void runReload();
      }, 0);
    });

    return reloadInFlight;
  };

  const unsubscribe = session.subscribe((event: any) => {
    if (event?.type !== "compaction_end") return;
    if (event?.aborted || !event?.result) return;
    setTimeout(() => {
      void runReload();
    }, 0);
  });

  (session as any)[AUTO_RELOAD_AFTER_COMPACTION_KEY] = { unsubscribe };
}

export {
  clearCompactionContinuationMarker,
  consumeCompactionContinuationMarker,
  getCompactionContinuationMarkerPath,
  writeCompactionContinuationMarker,
};

export const RIN_DIR_ENV = "RIN_DIR";
export const PI_AGENT_DIR_ENV = "PI_CODING_AGENT_DIR";

export function resolveRuntimeProfile(
  options: { cwd?: string; agentDir?: string } = {},
) {
  const cwd = os.homedir();
  const agentDir =
    options.agentDir ||
    process.env[RIN_DIR_ENV]?.trim() ||
    path.join(os.homedir(), ".rin");
  return { cwd, agentDir };
}

export function applyRuntimeProfileEnvironment(profile: { agentDir: string }) {
  if (profile.agentDir) {
    process.env[PI_AGENT_DIR_ENV] = profile.agentDir;
  }
}

export function getRuntimeSessionDir(_cwd: string, agentDir: string) {
  return path.join(agentDir, "sessions");
}

export async function createConfiguredAgentSession(
  options: {
    cwd?: string;
    agentDir?: string;
    additionalExtensionPaths?: string[];
    additionalSkillPaths?: string[];
    sessionManager?: any;
    modelRef?: string;
    thinkingLevel?: any;
  } = {},
) {
  const codingAgentModule = await loadRinCodingAgent();
  const {
    createAgentSessionRuntime,
    createAgentSessionServices,
    createAgentSessionFromServices,
    SessionManager,
  } = codingAgentModule as any;

  const { cwd, agentDir } = resolveRuntimeProfile({
    cwd: options.cwd,
    agentDir: options.agentDir,
  });
  const managedSkillPaths = getManagedSkillPaths(agentDir);
  const additionalSkillPaths = Array.from(
    new Set([...managedSkillPaths, ...(options.additionalSkillPaths || [])]),
  );

  applyRuntimeProfileEnvironment({ agentDir });

  const initialSessionManager =
    options.sessionManager ||
    SessionManager.create(cwd, getRuntimeSessionDir(cwd, agentDir));

  const createRuntime = async ({
    cwd: runtimeCwd,
    agentDir: runtimeAgentDir,
    sessionManager,
    sessionStartEvent,
  }: {
    cwd: string;
    agentDir: string;
    sessionManager: any;
    sessionStartEvent?: any;
  }) => {
    if (process.cwd() !== runtimeCwd) {
      process.chdir(runtimeCwd);
    }
    applyRuntimeProfileEnvironment({ agentDir: runtimeAgentDir });

    const services = await createAgentSessionServices({
      cwd: runtimeCwd,
      agentDir: runtimeAgentDir,
      resourceLoaderOptions: {
        additionalExtensionPaths: options.additionalExtensionPaths ?? [],
        additionalSkillPaths,
      },
    });

    let resolvedModel: any = undefined;
    const modelRef = String(options.modelRef || "").trim();
    if (modelRef) {
      const slash = modelRef.indexOf("/");
      if (slash <= 0 || slash >= modelRef.length - 1) {
        throw new Error(`invalid_model_ref:${modelRef}`);
      }
      const provider = modelRef.slice(0, slash);
      const modelId = modelRef.slice(slash + 1);
      resolvedModel = services.modelRegistry.find(provider, modelId);
      if (!resolvedModel) throw new Error(`unknown_model:${modelRef}`);
      if (!services.modelRegistry.hasConfiguredAuth(resolvedModel)) {
        throw new Error(`No API key for ${modelRef}`);
      }
    }

    const result = await createAgentSessionFromServices({
      services,
      sessionManager,
      sessionStartEvent,
      model: resolvedModel,
      thinkingLevel: options.thinkingLevel,
    });

    applyRinPromptBuilder(result.session);
    applyDisableEndTurnThresholdCompaction(result.session);
    applyMidTurnCompaction(result.session);
    applyOverflowContinuationPrompt(result.session);
    applyAutoReloadAfterCompaction(result.session);
    applyTerminalStateConfirmation(result.session);
    return {
      ...result,
      services,
      diagnostics: services.diagnostics,
    };
  };

  const runtime = await createAgentSessionRuntime(createRuntime, {
    cwd: initialSessionManager.getCwd?.() || cwd,
    agentDir,
    sessionManager: initialSessionManager,
  });

  return {
    session: runtime.session,
    runtime,
    extensionsResult: runtime.session.resourceLoader.getExtensions(),
    modelFallbackMessage: runtime.modelFallbackMessage,
  };
}
