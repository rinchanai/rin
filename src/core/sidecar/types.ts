export type SidecarInstanceState = {
  pid?: number;
  ownerPid?: number;
  startedAt?: string;
  entryPath?: string;
  baseUrl?: string;
  port?: number;
  statePath?: string;
};

export type SidecarStatusRow = {
  instanceId: string;
  pid: number;
  alive: boolean;
  startedAt?: string;
  ownerPid?: number;
  entryPath?: string;
  baseUrl?: string;
  port?: number;
  statePath: string;
};
