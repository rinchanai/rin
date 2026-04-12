import fs from "node:fs";
import path from "node:path";

export type PendingResumeState = {
  sessionFile?: string;
  resumeTurn?: boolean;
};

export type RestartState = {
  pendingResume: PendingResumeState[];
};

export function restartStatePath(agentDir: string) {
  return path.join(agentDir, "data", "restart.json");
}

export function loadRestartState(agentDir: string): RestartState {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(restartStatePath(agentDir), "utf8"),
    );
    const pendingResume = Array.isArray(parsed?.pendingResume)
      ? parsed.pendingResume
          .map((item: any) => ({
            sessionFile:
              typeof item?.sessionFile === "string" && item.sessionFile
                ? item.sessionFile
                : undefined,
            resumeTurn: Boolean(item?.resumeTurn),
          }))
          .filter((item: PendingResumeState) => item.sessionFile)
      : [];
    return { pendingResume };
  } catch {
    return { pendingResume: [] };
  }
}

export function saveRestartState(agentDir: string, state: RestartState) {
  const filePath = restartStatePath(agentDir);
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    if (!state.pendingResume.length) {
      fs.rmSync(filePath, { force: true });
      return;
    }
    fs.writeFileSync(
      filePath,
      JSON.stringify({ version: 1, pendingResume: state.pendingResume }),
    );
  } catch {}
}
