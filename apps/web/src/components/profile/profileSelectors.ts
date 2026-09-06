// FILE: profileSelectors.ts
// Purpose: Shared profile selectors that combine fast core stats with slower
// token telemetry for profile surfaces and export cards.
// Layer: web profile feature (pure selection logic, no I/O).

import type {
  ProfileHeatmapCell,
  ProfileStats,
  ProfileTokenStats,
  ProviderKind,
} from "@synara/contracts";
import { PROVIDER_DISPLAY_NAMES } from "@synara/contracts";

export interface ProfileHeatmapSelection {
  readonly cells: ReadonlyArray<ProfileHeatmapCell>;
  /** Tooltip noun matching the selected series ("tokens" or "prompts"). */
  readonly unit: "tokens" | "prompts";
}

export interface ProfileTopProviderSelection {
  readonly provider: ProviderKind | null;
  readonly percent: number | null;
  readonly metric: "turns";
}

export interface ProfileModelUsageEntry {
  readonly provider: ProviderKind | "unknown";
  readonly model: string;
  readonly percent: number;
}

export interface ProfileModelUsageSelection {
  readonly entries: ReadonlyArray<ProfileModelUsageEntry>;
  readonly metric: "turns";
}

// Prefer tokens/day when available; fall back to prompt counts while token stats load.
export function selectProfileHeatmap(
  stats: ProfileStats,
  tokenStats: ProfileTokenStats | null,
): ProfileHeatmapSelection {
  if (tokenStats?.available) {
    return { cells: tokenStats.heatmap, unit: "tokens" };
  }
  return { cells: stats.activity.heatmap, unit: "prompts" };
}

// Rank by turns so missing telemetry never excludes a provider from usage rankings.
export function selectProfileTopProvider(stats: ProfileStats): ProfileTopProviderSelection {
  return {
    provider: stats.insights.topProvider,
    percent: stats.insights.topProviderPercent,
    metric: "turns",
  };
}

// Keep the same turn-based denominator before and after token telemetry loads.
export function selectProfileModelUsage(stats: ProfileStats): ProfileModelUsageSelection {
  return { entries: stats.providerModels, metric: "turns" };
}

export function selectProfileTokenCoverage(tokenStats: ProfileTokenStats | null): string | null {
  if (!tokenStats) return null;
  const notes: string[] = [];
  if (tokenStats.unavailableProviders.length > 0) {
    const names = tokenStats.unavailableProviders.map((provider) => PROVIDER_DISPLAY_NAMES[provider]);
    notes.push(`No token data recorded for ${names.join(", ")}.`);
  }
  if (tokenStats.estimatedProviders && tokenStats.estimatedProviders.length > 0) {
    const names = tokenStats.estimatedProviders.map((provider) => PROVIDER_DISPLAY_NAMES[provider]);
    notes.push(`Includes historical estimates for ${names.join(", ")}.`);
  }
  return notes.length > 0 ? notes.join(" ") : null;
}
