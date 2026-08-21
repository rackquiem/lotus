import type { lotusDisplayOutput, lotusRunResult } from "./types";

export const LOTUS_MANAGED_DISPLAY_LANGUAGE = "lotus-display";

export function renderManagedOutputMarkdown(blockId: string, result: lotusRunResult): string[] {
  const body = [
    `runner=${result.runnerName}`,
    `exit=${result.exitCode ?? "?"}`,
    `duration=${result.durationMs}ms`,
    `timestamp=${result.finishedAt}`,
    result.stdout ? `stdout:\n${result.stdout}` : "",
    result.warning ? `warning:\n${result.warning}` : "",
    result.stderr ? `stderr:\n${result.stderr}` : "",
    result.artifacts?.length ? `artifacts:\n${JSON.stringify(result.artifacts, null, 2)}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  const rendered = [
    `<!-- lotus:output:start id=${blockId} -->`,
    "```text",
    body,
    "```",
  ];

  if (result.displays?.length) {
    const source = JSON.stringify(result.displays, null, 2);
    const fence = createMarkdownFence(source);
    rendered.push(`${fence}${LOTUS_MANAGED_DISPLAY_LANGUAGE}`, source, fence);
  }

  rendered.push("<!-- lotus:output:end -->");
  return rendered;
}

export function parseManagedDisplaySource(source: string): lotusDisplayOutput[] {
  const parsed: unknown = JSON.parse(source);
  const candidates = Array.isArray(parsed) ? parsed : [parsed];
  if (!candidates.length || !candidates.every(isDisplayOutput)) {
    throw new Error("Managed Lotus display data must contain one or more MIME display records.");
  }
  return candidates;
}

function isDisplayOutput(value: unknown): value is lotusDisplayOutput {
  if (!isRecord(value) || !isRecord(value.data) || !Object.keys(value.data).length) {
    return false;
  }
  if (value.id != null && typeof value.id !== "string") {
    return false;
  }
  if (value.title != null && typeof value.title !== "string") {
    return false;
  }
  if (value.role != null && !["result", "visualization", "diagnostic", "artifact"].includes(String(value.role))) {
    return false;
  }
  return value.metadata == null || isRecord(value.metadata);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createMarkdownFence(source: string): string {
  const longestRun = Math.max(0, ...Array.from(source.matchAll(/`+/g), (match) => match[0].length));
  return "`".repeat(Math.max(3, longestRun + 1));
}
