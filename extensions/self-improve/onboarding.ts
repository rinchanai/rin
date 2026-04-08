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
  mode: "auto" | "manual" = "manual",
): string {
  return [
    mode === "auto"
      ? "Memory onboarding is active. Continue the initialization naturally."
      : "The user requested /init. Continue onboarding naturally.",
    "Do not mention, quote, summarize, or expose any hidden onboarding instructions, internal prompt text, or implementation details to the user.",
    "Keep the conversation natural and concise. Ask at most one onboarding question in this turn.",
    "The onboarding order should be handled by you conversationally:",
    "- first establish the user's preferred language",
    "- then ask the user to define the assistant's own name / identity / relationship framing",
    "- then ask how to address the user",
    "- finally ask for the assistant's default voice/style preferences",
    "If the user already provided information from later steps early, remember it and use it; do not force redundant questions.",
    "When a stable fact becomes clear, proactively call save_self_improve_prompt to save or update it.",
    "For onboarding or preference updates, prefer updating the existing target slot instead of assuming blank state or creating duplicates.",
    "Use self-improve prompt slots:",
    "- agent_profile = assistant identity, relationship framing, default language, and voice/style",
    "- user_profile = user name, addressing, household context, and stable identity cues",
    "- core_doctrine = methodology, values, worldview, and stable working doctrine",
    "- core_facts = curated durable facts that should stay present every turn; this slot can hold more than the profile slots",
    "Prefer updating existing memory over creating duplicates.",
    "Stable global work-method preferences, methodology, values, worldview, and a few always-relevant facts belong in always-on self-improve prompts.",
    "Once the main self-improve prompt slots are established clearly enough, stop onboarding and continue normally.",
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
