import { mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";

export type PreparedToolText = {
  agentText: string;
  userText: string;
  fullOutputPath?: string;
  truncated: boolean;
};

async function writeTempOutput(
  prefix: string,
  filename: string,
  content: string,
) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  const filePath = path.join(dir, filename);
  await withFileMutationQueue(filePath, async () => {
    await writeFile(filePath, content, "utf8");
  });
  return filePath;
}

export async function prepareToolTextOutput(options: {
  agentText: string;
  userText?: string;
  tempPrefix?: string;
  filename?: string;
}) {
  const agentText = String(options.agentText || "");
  const userText = String(options.userText ?? options.agentText ?? "");
  const agent = truncateHead(agentText, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });
  const user = truncateHead(userText, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!agent.truncated && !user.truncated) {
    return {
      agentText,
      userText,
      truncated: false,
    } satisfies PreparedToolText;
  }

  const fullOutputPath = await writeTempOutput(
    options.tempPrefix || "rin-tool-output-",
    options.filename || "output.txt",
    ["## Agent text", agentText, "", "## User text", userText].join("\n"),
  );

  const buildNotice = (result: ReturnType<typeof truncateHead>) =>
    `\n\n[Output truncated: showing ${result.outputLines} of ${result.totalLines} lines (${formatSize(result.outputBytes)} of ${formatSize(result.totalBytes)}). Full output saved to: ${fullOutputPath}]`;

  return {
    agentText: agent.content + (agent.truncated ? buildNotice(agent) : ""),
    userText: user.content + (user.truncated ? buildNotice(user) : ""),
    fullOutputPath,
    truncated: true,
  } satisfies PreparedToolText;
}
