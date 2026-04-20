import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { pathToFileURL } from "node:url";

const rootDir = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const tuiReport = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "tui-report.js")).href
);
const doctor = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin", "doctor.js")).href
);
const updater = await import(
  pathToFileURL(path.join(rootDir, "dist", "core", "rin-install", "updater.js"))
    .href
);

test("renderReportSection keeps compact note-friendly text", () => {
  const text = tuiReport.renderReportSection({
    title: "Demo",
    lines: ["alpha", "", "beta  ", ""],
  });
  assert.equal(text, "alpha\nbeta");
});

test("buildDoctorSections groups doctor data into installer-style sections", () => {
  const sections = doctor.buildDoctorSections({
    context: {
      targetUser: "rin",
      installDir: "/home/rin/.rin",
      socketPath: "/run/user/1001/rin-daemon/daemon.sock",
      systemctl: "/usr/bin/systemctl",
    },
    socketReady: true,
    daemonStatus: {
      workerCount: 1,
      workers: [
        {
          id: "worker-1",
          pid: 123,
          role: "default",
          attachedConnections: 1,
          pendingResponses: 0,
          isStreaming: false,
          isCompacting: false,
          sessionFile: "/tmp/demo.jsonl",
        },
      ],
      webSearch: {
        runtime: { ready: true },
        instances: [
          {
            instanceId: "web-1",
            pid: 456,
            alive: true,
            port: 8080,
            baseUrl: "http://127.0.0.1:8080",
          },
        ],
      },
      chat: {
        ready: true,
        adapterCount: 2,
        botCount: 3,
        controllerCount: 4,
        detachedControllerCount: 1,
      },
    },
    serviceStatus: {
      unit: "rin-daemon-rin.service",
      lines: ["active (running)"],
    },
    serviceJournal: {
      unit: "rin-daemon-rin.service",
      lines: ["journal line"],
    },
  });

  assert.deepEqual(
    sections.map((section) => section.title),
    [
      "Target",
      "Web search",
      "Chat bridge",
      "Daemon workers",
      "Service status (rin-daemon-rin.service)",
      "Service journal (rin-daemon-rin.service)",
    ],
  );
  assert.ok(
    sections[0].lines.some((line) => line.includes("Target user: rin")),
  );
  assert.ok(
    sections[2].lines.some((line) => line.includes("Adapters: 2")),
  );
  assert.ok(sections[3].lines.some((line) => line.includes("worker-1")));
});

test("buildUpdaterSections mirrors installer-style plan and result blocks", () => {
  const sections = updater.buildUpdaterSections({
    currentUser: "alice",
    targetUser: "rin",
    installDir: "/home/rin/.rin",
    target: {
      source: "manifest",
      ownerHome: "/home/rin",
    },
    result: {
      written: {
        launcherPath: "/home/alice/.config/rin/install.json",
        rinPath: "/home/alice/.local/bin/rin",
        rinInstallPath: "/home/alice/.local/bin/rin-install",
      },
      publishedRuntime: {
        currentLink: "/home/rin/.rin/app/current",
        releaseRoot: "/home/rin/.rin/app/releases/1",
      },
      installedDocsDir: "/home/rin/.rin/docs/rin",
      installedDocs: { pi: ["/home/rin/.rin/docs/pi"] },
      prunedReleases: { removed: ["a", "b"] },
      installedService: {
        servicePath: "/home/rin/.config/systemd/user/rin-daemon-rin.service",
        kind: "systemd",
        label: "rin-daemon-rin.service",
      },
      serviceHint: "A Linux user service will be installed and started.",
      daemonReady: true,
    },
  });

  assert.deepEqual(
    sections.map((section) => section.title),
    [
      "Selected target",
      "Update policy",
      "Updated target",
      "Service state",
      "Next commands",
    ],
  );
  assert.ok(sections[4].lines.includes("- doctor: rin doctor -u rin"));
  assert.ok(sections[4].lines.includes("- open Rin: rin -u rin"));
});
