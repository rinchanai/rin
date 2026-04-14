import fs from "node:fs";
import path from "node:path";

const INIT_STATE_FILE = "init-state.json";
const REQUIRED_INIT_SLOTS = ["agent_profile", "user_profile"];
const OPTIONAL_INIT_SLOTS = ["core_doctrine", "core_facts"];

function initStatePath(resolveAgentDir: () => string) {
  return path.join(resolveAgentDir(), "self_improve", "state", INIT_STATE_FILE);
}

function readInitState(resolveAgentDir: () => string) {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(initStatePath(resolveAgentDir), "utf8"),
    ) as Record<string, any>;
    return {
      version: 2,
      promptedAt: "",
      completedAt: "",
      lastTrigger: "",
      pending: false,
      ...parsed,
    };
  } catch {
    return {
      version: 2,
      promptedAt: "",
      completedAt: "",
      lastTrigger: "",
      pending: false,
    };
  }
}

function writeInitState(
  resolveAgentDir: () => string,
  next: Record<string, any>,
) {
  fs.mkdirSync(path.dirname(initStatePath(resolveAgentDir)), {
    recursive: true,
  });
  fs.writeFileSync(
    initStatePath(resolveAgentDir),
    JSON.stringify(next, null, 2),
    "utf8",
  );
}

export function buildOnboardingPrompt(
  _mode: "auto" | "manual" = "manual",
): string {
  return [
    "The user is requesting initialization. Proactively start the conversation and ask questions in the following flow. Ask only one question in each message:",
    "1. What the user is called and how to address them.",
    "2. What the user wants to call you.",
    "3. What identity the user wants you to become.",
    "4. Based on that information, continue the conversation on your own and expand the topic naturally while keeping a one-question, one-answer rhythm.",
    "Persist all of the information above with save_prompts.",
  ].join("\n");
}

export function getOnboardingState(resolveAgentDir: () => string) {
  return readInitState(resolveAgentDir);
}

export function isOnboardingActive(
  resolveAgentDir: () => string,
  state = readInitState(resolveAgentDir),
) {
  return Boolean(state?.pending);
}

export async function getOnboardingStatus(
  resolveAgentDir: () => string,
  loadSelfImproveStore: () => Promise<any>,
) {
  const service = await loadSelfImproveStore();
  const docs = await service.loadActiveSelfImproveDocs(resolveAgentDir());
  const missing = REQUIRED_INIT_SLOTS.concat(OPTIONAL_INIT_SLOTS).filter(
    (slot, index, all) =>
      all.indexOf(slot) === index &&
      !docs.some(
        (doc: any) =>
          doc?.exposure === "self_improve_prompts" &&
          doc?.self_improve_prompt_slot === slot,
      ),
  );
  const requiredMissing = REQUIRED_INIT_SLOTS.filter((slot) =>
    missing.includes(slot),
  );
  const optionalMissing = OPTIONAL_INIT_SLOTS.filter((slot) =>
    missing.includes(slot),
  );
  const state = readInitState(resolveAgentDir);
  const complete = requiredMissing.length === 0;
  return { state, requiredMissing, optionalMissing, complete };
}

export async function markOnboardingPrompted(
  resolveAgentDir: () => string,
  trigger: string,
) {
  const state = readInitState(resolveAgentDir);
  const next = {
    ...state,
    version: 2,
    promptedAt: new Date().toISOString(),
    completedAt: "",
    lastTrigger: trigger,
    pending: true,
  };
  writeInitState(resolveAgentDir, next);
  return next;
}

export async function refreshOnboardingCompletion(
  resolveAgentDir: () => string,
  loadSelfImproveStore: () => Promise<any>,
) {
  const status = await getOnboardingStatus(
    resolveAgentDir,
    loadSelfImproveStore,
  );
  if (status.complete) {
    const next = {
      ...status.state,
      version: 2,
      completedAt: new Date().toISOString(),
      pending: false,
    };
    writeInitState(resolveAgentDir, next);
    return { ...status, state: next, complete: true };
  }
  return status;
}
