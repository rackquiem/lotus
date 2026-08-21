export type lotusTimeoutMs = number | null;

const INFINITE_TIMEOUT_TOKENS = new Set(["inf", "infinite", "infinity", "never", "none", "unlimited"]);

export function parseTimeoutMs(value: string): lotusTimeoutMs | undefined {
  const normalized = value.trim().toLowerCase();
  if (INFINITE_TIMEOUT_TOKENS.has(normalized)) {
    return null;
  }

  const parsed = Number.parseInt(normalized, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function readFrontmatterTimeoutMs(value: unknown): lotusTimeoutMs | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }
  return typeof value === "string" ? parseTimeoutMs(value) : undefined;
}

export function withMinimumTimeout(timeoutMs: lotusTimeoutMs, minimumMs: number): lotusTimeoutMs {
  return timeoutMs === null ? null : Math.max(timeoutMs, minimumMs);
}

export function formatTimeoutMs(timeoutMs: lotusTimeoutMs): string {
  return timeoutMs === null ? "infinite" : `${timeoutMs} ms`;
}

export function formatTimeoutLabel(timeoutMs: lotusTimeoutMs): string {
  return timeoutMs === null ? "infinite" : `${timeoutMs}ms`;
}
