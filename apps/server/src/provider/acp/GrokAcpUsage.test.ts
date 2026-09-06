import { describe, expect, it } from "vitest";
import { parseGrokPromptResponseConsumption } from "./GrokAcpUsage.ts";

const response = (total = 100) => ({
  stopReason: "end_turn",
  _meta: {
    sessionId: "session-1",
    promptId: "prompt-1",
    totalTokens: 999999,
    usage: {
      inputTokens: total - 10,
      outputTokens: 10,
      totalTokens: total,
      cachedReadTokens: 20,
      reasoningTokens: 3,
    },
  },
});

describe("Grok prompt consumption", () => {
  it("reads the response usage without counting cache/reasoning subsets twice", () => {
    expect(parseGrokPromptResponseConsumption(response(), "session-1")).toEqual({
      sourceId: "prompt-1",
      usage: {
        inputTokens: 90, outputTokens: 10, totalTokens: 100,
        cachedInputTokens: 20, reasoningOutputTokens: 3,
      },
    });
  });

  it("rejects malformed counts, missing prompt identity and foreign sessions", () => {
    for (const totalTokens of [-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100", 101]) {
      const value = response();
      expect(parseGrokPromptResponseConsumption({
        ...value,
        _meta: { ...value._meta, usage: { ...value._meta.usage, totalTokens } },
      }, "session-1")).toBeUndefined();
    }
    expect(parseGrokPromptResponseConsumption(response(), "another-session")).toBeUndefined();
    const value = response();
    expect(parseGrokPromptResponseConsumption({
      ...value, _meta: { ...value._meta, promptId: " " },
    }, "session-1")).toBeUndefined();
  });

  it("does not infer consumption from totalTokens metadata or standard window snapshots", () => {
    expect(parseGrokPromptResponseConsumption({
      _meta: { sessionId: "session-1", promptId: "prompt-1", totalTokens: 999999 },
    }, "session-1")).toBeUndefined();
    expect(parseGrokPromptResponseConsumption({ usage: { used: 50, size: 100 } }, "session-1")).toBeUndefined();
  });

  it("accepts per-prompt decreases and cancellation usage without any text notification", () => {
    for (const total of [192413, 176953]) {
      expect(parseGrokPromptResponseConsumption(response(total), "session-1")?.usage.totalTokens).toBe(total);
    }
    expect(parseGrokPromptResponseConsumption({ ...response(), stopReason: "cancelled" }, "session-1")?.usage.totalTokens).toBe(100);
  });
});
