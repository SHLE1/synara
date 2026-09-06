import type { ThreadConsumptionUsage } from "@synara/contracts";

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function parseGrokUsage(value: unknown, promptId: unknown):
  | { readonly sourceId: string; readonly usage: ThreadConsumptionUsage }
  | undefined {
  const sourceId = typeof promptId === "string" ? promptId.trim() : "";
  const raw = record(value);
  if (!sourceId || !raw) return undefined;
  const inputTokens = tokenCount(raw.inputTokens);
  const outputTokens = tokenCount(raw.outputTokens);
  const totalTokens = tokenCount(raw.totalTokens);
  if (inputTokens === undefined || outputTokens === undefined || totalTokens === undefined) {
    return undefined;
  }
  // Cached reads and reasoning are subsets of input/output, not extra tokens.
  if (inputTokens + outputTokens !== totalTokens) return undefined;
  const cachedInputTokens = tokenCount(raw.cachedReadTokens);
  const reasoningOutputTokens = tokenCount(raw.reasoningTokens);
  return {
    sourceId,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cachedInputTokens !== undefined && cachedInputTokens <= inputTokens
        ? { cachedInputTokens }
        : {}),
      ...(reasoningOutputTokens !== undefined && reasoningOutputTokens <= outputTokens
        ? { reasoningOutputTokens }
        : {}),
    },
  };
}

/**
 * Grok 1.0.13 sends per-prompt spend in PromptResponse._meta.usage.
 * Its local updates.jsonl records private completion notifications that are
 * not necessarily forwarded to ACP clients; the RPC result is the source of
 * truth and already belongs to the active Synara turn.
 */
export function parseGrokPromptResponseConsumption(value: unknown, sessionId: string):
  | { readonly sourceId: string; readonly usage: ThreadConsumptionUsage }
  | undefined {
  const meta = record(record(value)?._meta);
  if (!meta || meta.sessionId !== sessionId) return undefined;
  return parseGrokUsage(meta.usage, meta.promptId);
}
