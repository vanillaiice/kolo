import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { LARGE_TRANSFER_LIMITS, STANDARD_TRANSFER_LIMITS, type TransferLimits } from "@kolo/core/backup/types";

/**
 * Per-computer settings that are not business data and must never travel in a backup. Today only
 * the large-files switch: off by default, it lifts transfer-file and photo-storage limits for
 * computers with memory to spare (ADR-027).
 */
export interface DevicePreferences {
  largeFiles(): boolean;
  setLargeFiles(value: boolean): void;
  /** The transfer size profile the current setting selects. */
  limits(): TransferLimits;
}

/** File-backed preferences; a missing or damaged file reads as the defaults. */
export function devicePreferences(path: string): DevicePreferences {
  let large = false;
  try { const value: unknown = JSON.parse(readFileSync(path, "utf8")); large = typeof value === "object" && value !== null && (value as { largeFiles?: unknown }).largeFiles === true; }
  catch { large = false; }
  return {
    largeFiles: () => large,
    setLargeFiles(value) {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const staged = `${path}.tmp`; writeFileSync(staged, JSON.stringify({ largeFiles: value }), { mode: 0o600 }); renameSync(staged, path);
      large = value;
    },
    limits: () => large ? LARGE_TRANSFER_LIMITS : STANDARD_TRANSFER_LIMITS,
  };
}

/** In-memory preferences for tests and smoke runs. */
export function memoryPreferences(initial = false): DevicePreferences {
  let large = initial;
  return { largeFiles: () => large, setLargeFiles: value => { large = value; }, limits: () => large ? LARGE_TRANSFER_LIMITS : STANDARD_TRANSFER_LIMITS };
}
