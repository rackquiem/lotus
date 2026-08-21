import type { lotusCodeBlock } from "../types";

export function readStringAttribute(block: lotusCodeBlock, primary: string, fallback: string): string | undefined {
  return block.attributes[primary]?.trim() || block.attributes[fallback]?.trim() || undefined;
}

export function readListAttribute(block: lotusCodeBlock, primary: string, fallback: string): string[] {
  return splitCsv(readStringAttribute(block, primary, fallback) || "");
}

export function splitCsv(value: string): string[] {
  return value.split(",").map((item) => item.trim()).filter(Boolean);
}

export function appendLine(existing: string | undefined, line: string): string {
  return [existing, line].filter((part) => part?.trim()).join("\n");
}

export function appendSection(existing: string, title: string, body: string): string {
  const content = body.trim();
  return content ? [existing.trim(), `${title}:\n${content}`].filter(Boolean).join("\n\n") : existing;
}
