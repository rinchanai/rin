import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

import {
  captureCommandAsUser,
  ensureDir,
  installedRuntimeNodeCommandArgs,
  installedRuntimePathValue,
  runCommandAsUser,
  runPrivileged,
  writeTextFile,
  writeTextFileWithPrivilege,
} from "./fs-utils.js";
import {
  daemonStderrLogPath,
  daemonStdoutLogPath,
  installedAppEntryCandidates,
  launchAgentPlistPathForHome,
  resolveInstalledAppEntryPath,
  managedLaunchdLabel,
  managedSystemdUnitCandidates,
  managedSystemdUnitName,
  systemdUserUnitDirForHome,
  systemdUserUnitPathForHome,
} from "./paths.js";
import {
  buildDaemonSocketProbeScript,
  canConnectDaemonSocket,
} from "../rin-daemon/client.js";
import {
  findManagedSystemdJournalSnapshot,
  findManagedSystemdStatusSnapshot,
  tryManagedSystemdAction,
} from "./managed-service.js";

function currentSystemUser() {
  try {
    return os.userInfo().username;
  } catch {
    return "";
  }
}

function firstExistingCommand(candidates: string[], fallback: string) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return fallback;
}

function resolveTargetUserContext(
  targetUser: string,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser?: (user: string) => string;
  },
) {
  const target = deps.findSystemUser(targetUser) as any;
  const uid = Number(target?.uid ?? -1);
  const targetHome = deps.targetHomeForUser?.(targetUser) || "";
  const runtimeDir = uid >= 0 ? `/run/user/${uid}` : "";
  const userEnv =
    runtimeDir && fs.existsSync(runtimeDir)
      ? {
          XDG_RUNTIME_DIR: runtimeDir,
          DBUS_SESSION_BUS_ADDRESS: `unix:path=${runtimeDir}/bus`,
        }
      : {};
  return {
    target,
    uid,
    targetHome,
    runtimeDir,
    userEnv,
  };
}

function resolveDaemonLaunchContext(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
) {
  return {
    targetHome: targetHomeForUser(targetUser),
    daemonEntry: resolveDaemonEntryForInstall(installDir),
    runtimePath: installedRuntimePathValue(),
    nodeCommandArgs: installedRuntimeNodeCommandArgs(),
  };
}

function captureCommandForTargetUser(
  targetUser: string,
  command: string,
  args: string[],
  extraEnv: Record<string, string> = {},
) {
  if (targetUser && targetUser !== currentSystemUser()) {
    return captureCommandAsUser(targetUser, command, args, extraEnv);
  }
  return execFileSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...extraEnv },
  });
}

const MANAGED_SERVICE_FILE_MODE = 0o644;

function writeManagedServiceFile(
  filePath: string,
  value: string,
  options: {
    elevated?: boolean;
    ownerUser?: string;
    ownerGroup?: string | number;
    mode?: number;
  } = {},
) {
  const {
    elevated = false,
    ownerUser,
    ownerGroup,
    mode = MANAGED_SERVICE_FILE_MODE,
  } = options;
  if (elevated) {
    writeTextFileWithPrivilege(filePath, value, ownerUser, ownerGroup, mode);
    return;
  }
  writeTextFile(filePath, value, mode);
}

function runSystemdUserCommand(
  targetUser: string,
  context: {
    systemctl: string;
    userEnv: Record<string, string>;
  },
  args: string[],
  elevated = false,
) {
  const commandArgs = ["--user", ...args];
  if (elevated) {
    runCommandAsUser(
      targetUser,
      context.systemctl,
      commandArgs,
      context.userEnv,
    );
    return;
  }
  execFileSync(context.systemctl, commandArgs, {
    stdio: "inherit",
    env: { ...process.env, ...context.userEnv },
  });
}

function managedSystemdUnitPaths(targetUser: string, targetHome: string) {
  const unitDir = systemdUserUnitDirForHome(targetHome);
  return managedSystemdUnitCandidates(targetUser).map((unit) =>
    path.join(unitDir, unit),
  );
}

export function resolveDaemonEntryForInstall(installDir: string) {
  const candidates = installedAppEntryCandidates(installDir, "rin-daemon");
  const daemonEntry = resolveInstalledAppEntryPath(
    installDir,
    "rin-daemon",
    (candidate) => fs.existsSync(candidate),
  );
  if (daemonEntry) return daemonEntry;
  throw new Error(`rin_installed_daemon_entry_missing:${candidates.join(",")}`);
}

export function buildLaunchdPlist(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
) {
  const label = managedLaunchdLabel(targetUser);
  const { targetHome, daemonEntry, runtimePath, nodeCommandArgs } =
    resolveDaemonLaunchContext(targetUser, installDir, targetHomeForUser);
  const stdoutPath = daemonStdoutLogPath(installDir);
  const stderrPath = daemonStderrLogPath(installDir);
  const plistPath = launchAgentPlistPathForHome(targetHome, label);
  const programArguments = [...nodeCommandArgs, daemonEntry]
    .map((entry) => `      <string>${entry}</string>`)
    .join("\n");
  const plist = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0">\n  <dict>\n    <key>Label</key>\n    <string>${label}</string>\n    <key>ProgramArguments</key>\n    <array>\n${programArguments}\n    </array>\n    <key>EnvironmentVariables</key>\n    <dict>\n      <key>PATH</key>\n      <string>${runtimePath}</string>\n      <key>RIN_DIR</key>\n      <string>${installDir}</string>\n    </dict>\n    <key>WorkingDirectory</key>\n    <string>${targetHome}</string>\n    <key>RunAtLoad</key>\n    <true/>\n    <key>KeepAlive</key>\n    <true/>\n    <key>StandardOutPath</key>\n    <string>${stdoutPath}</string>\n    <key>StandardErrorPath</key>\n    <string>${stderrPath}</string>\n  </dict>\n</plist>\n`;
  return { label, plistPath, plist, stdoutPath, stderrPath };
}

export function installLaunchdAgent(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  const { target, uid } = resolveTargetUserContext(targetUser, deps);
  if (uid < 0)
    throw new Error(`rin_launchd_target_user_not_found:${targetUser}`);
  const { label, plistPath, plist, stdoutPath, stderrPath } = buildLaunchdPlist(
    targetUser,
    installDir,
    deps.targetHomeForUser,
  );
  if (elevated) {
    runPrivileged("mkdir", ["-p", path.dirname(plistPath)]);
    runPrivileged("mkdir", ["-p", path.dirname(stdoutPath)]);
    writeManagedServiceFile(plistPath, plist, {
      elevated: true,
      ownerUser: targetUser,
      ownerGroup: target?.gid,
    });
    try {
      runPrivileged("launchctl", ["bootout", `gui/${uid}`, plistPath]);
    } catch {}
    runPrivileged("launchctl", ["bootstrap", `gui/${uid}`, plistPath]);
    try {
      runPrivileged("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`]);
    } catch {}
  } else {
    ensureDir(path.dirname(plistPath));
    ensureDir(path.dirname(stdoutPath));
    writeManagedServiceFile(plistPath, plist);
    try {
      execFileSync("launchctl", ["bootout", `gui/${uid}`, plistPath], {
        stdio: "ignore",
      });
    } catch {}
    execFileSync("launchctl", ["bootstrap", `gui/${uid}`, plistPath], {
      stdio: "inherit",
    });
    try {
      execFileSync("launchctl", ["kickstart", "-k", `gui/${uid}/${label}`], {
        stdio: "inherit",
      });
    } catch {}
  }
  return {
    kind: "launchd" as const,
    label,
    servicePath: plistPath,
    stdoutPath,
    stderrPath,
  };
}

export function buildSystemdUserService(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
) {
  const { targetHome, daemonEntry, runtimePath, nodeCommandArgs } =
    resolveDaemonLaunchContext(targetUser, installDir, targetHomeForUser);
  const unitName = managedSystemdUnitName(targetUser);
  const unitPath = systemdUserUnitPathForHome(targetHome, unitName);
  const execStart = [...nodeCommandArgs, daemonEntry].join(" ");
  const service = `[Unit]\nDescription=Rin daemon for ${targetUser}\nAfter=network.target\n\n[Service]\nType=simple\nWorkingDirectory=${targetHome}\nEnvironment=PATH=${runtimePath}\nEnvironment=RIN_DIR=${installDir}\nExecStart=${execStart}\nRestart=always\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
  return {
    kind: "systemd" as const,
    label: unitName,
    servicePath: unitPath,
    service,
  };
}

export function installSystemdUserService(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  const spec = buildSystemdUserService(
    targetUser,
    installDir,
    deps.targetHomeForUser,
  );
  const { systemctl, userEnv, target } = systemdUserContext(targetUser, deps);
  const loginctl = firstExistingCommand(
    ["/usr/bin/loginctl", "/bin/loginctl"],
    "loginctl",
  );
  writeManagedServiceFile(spec.servicePath, spec.service, {
    elevated,
    ownerUser: targetUser,
    ownerGroup: target?.gid,
  });
  if (elevated) {
    try {
      runPrivileged(loginctl, ["enable-linger", targetUser]);
    } catch {}
  }
  runSystemdUserCommand(
    targetUser,
    { systemctl, userEnv },
    ["daemon-reload"],
    elevated,
  );
  runSystemdUserCommand(
    targetUser,
    { systemctl, userEnv },
    ["enable", "--now", spec.label],
    elevated,
  );
  return spec;
}

export function refreshManagedServiceFiles(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  if (process.platform !== "linux") return;
  const spec = buildSystemdUserService(
    targetUser,
    installDir,
    deps.targetHomeForUser,
  );
  const ownerGroup = deps.findSystemUser(targetUser)?.gid;
  for (const filePath of managedSystemdUnitPaths(
    targetUser,
    deps.targetHomeForUser(targetUser),
  )) {
    if (!fs.existsSync(filePath)) continue;
    writeManagedServiceFile(filePath, spec.service, {
      elevated,
      ownerUser: targetUser,
      ownerGroup,
    });
  }
}

export function systemdUserContext(
  targetUser: string,
  deps: { findSystemUser: (user: string) => any },
) {
  const { target, uid, runtimeDir, userEnv } = resolveTargetUserContext(
    targetUser,
    deps,
  );
  return {
    target,
    uid,
    runtimeDir,
    systemctl: firstExistingCommand(
      ["/usr/bin/systemctl", "/bin/systemctl"],
      "",
    ),
    userEnv,
    units: managedSystemdUnitCandidates(targetUser),
  };
}

export function daemonSocketPathForUser(
  targetUser: string,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  const { uid, targetHome } = resolveTargetUserContext(targetUser, deps);
  if (process.platform === "darwin")
    return path.join(
      targetHome,
      "Library",
      "Caches",
      "rin-daemon",
      "daemon.sock",
    );
  if (uid >= 0)
    return path.join("/run/user", String(uid), "rin-daemon", "daemon.sock");
  return path.join(targetHome, ".cache", "rin-daemon", "daemon.sock");
}

export function collectDaemonFailureDetails(
  targetUser: string,
  installDir: string,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  const socketPath = daemonSocketPathForUser(targetUser, deps);
  const lines = [
    `targetUser=${targetUser}`,
    `installDir=${installDir}`,
    `socketPath=${socketPath}`,
    "socketReady=no",
  ];
  if (process.platform === "linux") {
    const { systemctl, userEnv, units } = systemdUserContext(targetUser, deps);
    if (systemctl) {
      const status = findManagedSystemdStatusSnapshot(units, (unit) =>
        captureCommandForTargetUser(
          targetUser,
          systemctl,
          ["--user", "status", unit, "--no-pager", "-l"],
          userEnv,
        ),
      );
      if (status) {
        lines.push(
          `serviceUnit=${status.unit}`,
          "serviceStatus:",
          ...status.lines,
        );
      }
      const journal = findManagedSystemdJournalSnapshot(units, (unit) =>
        captureCommandForTargetUser(
          targetUser,
          "journalctl",
          ["--user", "-u", unit, "-n", "20", "--no-pager"],
          userEnv,
        ),
      );
      if (journal) {
        lines.push(`serviceJournal=${journal.unit}`, ...journal.lines);
      }
    }
  }
  return lines.join("\n");
}

export function reconcileSystemdUserService(
  targetUser: string,
  installDir: string,
  action: "start" | "restart",
  elevated = false,
  deps: { findSystemUser: (user: string) => any },
) {
  void installDir;
  if (process.platform !== "linux") return false;
  const { systemctl, userEnv, units } = systemdUserContext(targetUser, deps);
  if (!systemctl) return false;
  return Boolean(
    tryManagedSystemdAction(units, {
      daemonReload: () =>
        runSystemdUserCommand(
          targetUser,
          { systemctl, userEnv },
          ["daemon-reload"],
          elevated,
        ),
      runAction: (unit) =>
        runSystemdUserCommand(
          targetUser,
          { systemctl, userEnv },
          [action, unit],
          elevated,
        ),
    }),
  );
}

export function installDaemonService(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
  },
) {
  if (process.platform === "darwin")
    return installLaunchdAgent(targetUser, installDir, elevated, deps);
  if (
    process.platform === "linux" &&
    (fs.existsSync("/usr/bin/systemctl") || fs.existsSync("/bin/systemctl"))
  )
    return installSystemdUserService(targetUser, installDir, elevated, deps);
  throw new Error(`rin_service_install_unsupported:${process.platform}`);
}

export async function waitForSocket(
  socketPath: string,
  timeoutMs = 5000,
  targetUser?: string,
) {
  const startedAt = Date.now();
  const currentUser = currentSystemUser();
  const isCurrentUser = !targetUser || targetUser === currentUser;
  while (Date.now() - startedAt < timeoutMs) {
    const ok = await new Promise<boolean>((resolve) => {
      if (!isCurrentUser) {
        try {
          const probe = captureCommandAsUser(targetUser, process.execPath, [
            "-e",
            buildDaemonSocketProbeScript(socketPath, 300),
          ]);
          void probe;
          resolve(true);
          return;
        } catch {
          resolve(false);
          return;
        }
      }
      void canConnectDaemonSocket(socketPath, 300).then(resolve);
    });
    if (ok) return true;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  return false;
}
