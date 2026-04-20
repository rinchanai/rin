export type UsageMetrics = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costInput: number;
  costOutput: number;
  costCacheRead: number;
  costCacheWrite: number;
  costTotal: number;
};

function usageNumber(value: unknown) {
  const num = Number(value || 0);
  return Number.isFinite(num) ? num : 0;
}

export function readUsageMetrics(usage: any): UsageMetrics {
  const input = usageNumber(usage?.input);
  const output = usageNumber(usage?.output);
  const cacheRead = usageNumber(usage?.cacheRead);
  const cacheWrite = usageNumber(usage?.cacheWrite);

  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens:
      usageNumber(usage?.totalTokens) ||
      input + output + cacheRead + cacheWrite,
    costInput: usageNumber(usage?.cost?.input),
    costOutput: usageNumber(usage?.cost?.output),
    costCacheRead: usageNumber(usage?.cost?.cacheRead),
    costCacheWrite: usageNumber(usage?.cost?.cacheWrite),
    costTotal: usageNumber(usage?.cost?.total),
  };
}

export function calculateUsageTotalTokens(usage: any): number {
  return readUsageMetrics(usage).totalTokens;
}
