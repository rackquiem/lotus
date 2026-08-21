
import type { lotusRemoteUploadMode } from "./containerConfig";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function optionalRegex(value: unknown, label: string): RegExp | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return regexFromString(value, label);
}

export function optionalRegexList(value: unknown, label: string): RegExp[] | undefined {
  if (value == null) {
    return undefined;
  }
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split("\n") : null;
  if (!values) {
    throw new Error(`${label} must be a string or array of strings.`);
  }
  const patterns = values
    .map((entry) => typeof entry === "string" ? entry.trim() : "")
    .filter(Boolean)
    .map((entry, index) => regexFromString(entry, `${label}[${index}]`, "g"));
  return patterns.length ? patterns : undefined;
}

export function regexFromString(value: string, label: string, fallbackFlags = ""): RegExp {
  const literal = value.match(/^\/(.+)\/([a-z]*)$/i);
  const source = literal ? literal[1] : value;
  const flags = literal ? literal[2] : fallbackFlags;
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

export function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

export function optionalSignal(value: unknown, label: string): NodeJS.Signals | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !/^SIG[A-Z0-9]+$/.test(value)) {
    throw new Error(`${label} must be a signal name like SIGTERM.`);
  }
  return value as NodeJS.Signals;
}

export function optionalUploadMode(value: unknown): lotusRemoteUploadMode | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (value === "inline" || value === "scp") {
    return value;
  }
  throw new Error("Remote upload mode must be inline or scp.");
}

export function normalizeExtension(extension: string): string {
  const trimmed = extension.trim();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}
