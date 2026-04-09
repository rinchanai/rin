import { RpcInteractiveSession } from "./runtime.js";

export function createRpcRuntimeHost(session: RpcInteractiveSession) {
  return {
    get session() {
      return session;
    },
    async newSession(options?: { parentSession?: string }) {
      const completed = await session.newSession(options);
      return { cancelled: !completed };
    },
    async switchSession(sessionPath: string, cwdOverride?: string) {
      const completed = await (session as any).switchSession(
        sessionPath,
        cwdOverride,
      );
      return { cancelled: !completed };
    },
    async fork(entryId: string) {
      return await session.fork(entryId);
    },
    async importFromJsonl(inputPath: string, cwdOverride?: string) {
      const completed = await (session as any).importFromJsonl(
        inputPath,
        cwdOverride,
      );
      return { cancelled: !completed };
    },
    async dispose() {
      await session.terminateSession().catch(() => {});
      await session.disconnect();
    },
  };
}
