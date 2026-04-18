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
  managedLaunchdLabel,
  managedSystemdUnitCandidates,
  managedSystemdUnitName,
  sourceAppEntryPath,
  systemdUserUnitDirForHome,
  systemdUserUnitPathForHome,
} from "./paths.js";
import { canConnectDaemonSocket } from "../rin-daemon/client.js";

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
  repoRootFromHere: () => string,
) {
  return {
    targetHome: targetHomeForUser(targetUser),
    daemonEntry: resolveDaemonEntryForInstall(installDir, repoRootFromHere),
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

export function resolveDaemonEntryForInstall(
  installDir: string,
  repoRootFromHere: () => string,
) {
  for (const candidate of installedAppEntryCandidates(
    installDir,
    "rin-daemon",
  )) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return sourceAppEntryPath(repoRootFromHere(), "rin-daemon");
}

export function buildLaunchdPlist(
  targetUser: string,
  installDir: string,
  targetHomeForUser: (user: string) => string,
  repoRootFromHere: () => string,
) {
  const label = managedLaunchdLabel(targetUser);
  const { targetHome, daemonEntry, runtimePath, nodeCommandArgs } =
    resolveDaemonLaunchContext(
      targetUser,
      installDir,
      targetHomeForUser,
      repoRootFromHere,
    );
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
    repoRootFromHere: () => string;
  },
) {
  const { target, uid } = resolveTargetUserContext(targetUser, deps);
  if (uid < 0)
    throw new Error(`rin_launchd_target_user_not_found:${targetUser}`);
  const { label, plistPath, plist, stdoutPath, stderrPath } = buildLaunchdPlist(
    targetUser,
    installDir,
    deps.targetHomeForUser,
    deps.repoRootFromHere,
  );
  if (elevated) {
    runPrivileged("mkdir", ["-p", path.dirname(plistPath)]);
    runPrivileged("mkdir", ["-p", path.dirname(stdoutPath)]);
    writeTextFileWithPrivilege(
      plistPath,
      plist,
      targetUser,
      target?.gid,
      0o644,
    );
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
    writeTextFile(plistPath, plist, 0o644);
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
  repoRootFromHere: () => string,
) {
  const { targetHome, daemonEntry, runtimePath, nodeCommandArgs } =
    resolveDaemonLaunchContext(
      targetUser,
      installDir,
      targetHomeForUser,
      repoRootFromHere,
    );
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
    repoRootFromHere: () => string;
  },
) {
  const spec = buildSystemdUserService(
    targetUser,
    installDir,
    deps.targetHomeForUser,
    deps.repoRootFromHere,
  );
  const { systemctl, userEnv, target } = systemdUserContext(targetUser, deps);
  const loginctl = firstExistingCommand(
    ["/usr/bin/loginctl", "/bin/loginctl"],
    "loginctl",
  );
  if (elevated) {
    writeTextFileWithPrivilege(
      spec.servicePath,
      spec.service,
      targetUser,
      target?.gid,
      0o644,
    );
    try {
      runPrivileged(loginctl, ["enable-linger", targetUser]);
    } catch {}
    runCommandAsUser(
      targetUser,
      systemctl,
      ["--user", "daemon-reload"],
      userEnv,
    );
    runCommandAsUser(
      targetUser,
      systemctl,
      ["--user", "enable", "--now", spec.label],
      userEnv,
    );
  } else {
    writeTextFile(spec.servicePath, spec.service, 0o644);
    execFileSync(systemctl, ["--user", "daemon-reload"], {
      stdio: "inherit",
      env: { ...process.env, ...userEnv },
    });
    execFileSync(systemctl, ["--user", "enable", "--now", spec.label], {
      stdio: "inherit",
      env: { ...process.env, ...userEnv },
    });
  }
  return spec;
}

export function refreshManagedServiceFiles(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
    repoRootFromHere: () => string;
  },
) {
  if (process.platform !== "linux") return;
  const targetHome = deps.targetHomeForUser(targetUser);
  const unitDir = systemdUserUnitDirForHome(targetHome);
  const candidateFiles = managedSystemdUnitCandidates(targetUser).map((unit) =>
    path.join(unitDir, unit),
  );
  const spec = buildSystemdUserService(
    targetUser,
    installDir,
    deps.targetHomeForUser,
    deps.repoRootFromHere,
  );
  const ownerGroup = deps.findSystemUser(targetUser)?.gid;
  for (const filePath of candidateFiles) {
    if (!fs.existsSync(filePath)) continue;
    if (elevated)
      writeTextFileWithPrivilege(
        filePath,
        spec.service,
        targetUser,
        ownerGroup,
        0o644,
      );
    else writeTextFile(filePath, spec.service, 0o644);
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
    systemctl: firstExistingCommand(["/usr/bin/systemctl", "/bin/systemctl"], ""),
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
      for (const unit of units) {
        try {
          const status = captureCommandForTargetUser(
            targetUser,
            systemctl,
            ["--user", "status", unit, "--no-pager", "-l"],
            userEnv,
          );
          lines.push(
            `serviceUnit=${unit}`,
            "serviceStatus:",
            ...String(status).trim().split(/\r?\n/).slice(0, 20),
          );
          break;
        } catch (error: any) {
          const text = String(
            error?.stdout || error?.stderr || error?.message || "",
          ).trim();
          if (text) {
            lines.push(
              `serviceUnit=${unit}`,
              "serviceStatus:",
              ...text.split(/\r?\n/).slice(0, 20),
            );
            break;
          }
        }
      }
      for (const unit of units) {
        try {
          const journal = captureCommandForTargetUser(
            targetUser,
            "journalctl",
            ["--user", "-u", unit, "-n", "20", "--no-pager"],
            userEnv,
          );
          if (String(journal || "").trim()) {
            lines.push(
              `serviceJournal=${unit}`,
              ...String(journal).trim().split(/\r?\n/).slice(-20),
            );
            break;
          }
        } catch {}
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
  if (elevated) {
    runCommandAsUser(
      targetUser,
      systemctl,
      ["--user", "daemon-reload"],
      userEnv,
    );
    for (const unit of units) {
      try {
        runCommandAsUser(
          targetUser,
          systemctl,
          ["--user", action, unit],
          userEnv,
        );
        return true;
      } catch {}
    }
    return false;
  }
  execFileSync(systemctl, ["--user", "daemon-reload"], {
    stdio: "inherit",
    env: { ...process.env, ...userEnv },
  });
  for (const unit of units) {
    try {
      execFileSync(systemctl, ["--user", action, unit], {
        stdio: "inherit",
        env: { ...process.env, ...userEnv },
      });
      return true;
    } catch {}
  }
  return false;
}

export function installDaemonService(
  targetUser: string,
  installDir: string,
  elevated = false,
  deps: {
    findSystemUser: (user: string) => any;
    targetHomeForUser: (user: string) => string;
    repoRootFromHere: () => string;
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
            `const net=require('node:net');const s=net.createConnection(${JSON.stringify(socketPath)});let done=false;const finish=(ok)=>{if(done)return;done=true;try{s.destroy()}catch{};process.exit(ok?0:1)};s.once('connect',()=>finish(true));s.once('error',()=>finish(false));setTimeout(()=>finish(false),300);`,
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
