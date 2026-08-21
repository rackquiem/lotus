
import { dirname } from "path";
import { isCompileFeatureAllowed } from "./buildProfile";
import { normalizeVaultPath } from "./utils/vaultPath";
import type { lotusCodeBlock, lotusRunFile, lotusStoredOutput } from "./types";

type lotusOutputFileMode = "replace" | "append";

type lotusOutputFileFormat = "text" | "json";

type lotusOutputFileStream = "stdout" | "stderr" | "warning" | "metadata" | "displays" | "artifacts";

interface lotusOutputFileTarget {
  path: string;
  mode: lotusOutputFileMode;
  format: lotusOutputFileFormat;
  streams: lotusOutputFileStream[];
}

export function readOutputFileTarget(configDir: string, file: lotusRunFile, block: lotusCodeBlock): lotusOutputFileTarget | null {
  const rawPath = block.attributes["lotus-output-file"] ?? block.attributes["output-file"];
  if (!rawPath?.trim()) {
    return null;
  }

  return {
    path: resolveOutputVaultPath(configDir, file, rawPath),
    mode: readOutputFileMode(block),
    format: readOutputFileFormat(block),
    streams: readOutputFileStreams(block),
  };
}

export function readOutputFileMode(block: lotusCodeBlock): lotusOutputFileMode {
  const append = block.attributes["lotus-output-append"] ?? block.attributes["output-append"];
  if (append && !["0", "false", "no", "off"].includes(append.trim().toLowerCase())) {
    return "append";
  }

  const mode = (block.attributes["lotus-output-file-mode"] ?? block.attributes["output-file-mode"] ?? "replace").trim().toLowerCase();
  if (mode === "append") {
    return "append";
  }
  if (mode === "replace") {
    return "replace";
  }
  throw new Error(`Unsupported lotus-output-file-mode: ${mode}. Use replace or append.`);
}

export function readOutputFileFormat(block: lotusCodeBlock): lotusOutputFileFormat {
  const format = (block.attributes["lotus-output-file-format"] ?? block.attributes["output-file-format"] ?? "text").trim().toLowerCase();
  if (format === "text" || format === "json") {
    return format;
  }
  throw new Error(`Unsupported lotus-output-file-format: ${format}. Use text or json.`);
}

export function readOutputFileStreams(block: lotusCodeBlock): lotusOutputFileStream[] {
  const value = block.attributes["lotus-output-file-streams"] ?? block.attributes["output-file-streams"] ?? "stdout";
  const parsed = value
    .split(",")
    .map((stream) => stream.trim().toLowerCase())
    .filter(Boolean);
  const expanded = parsed.includes("all")
    ? ["metadata", "stdout", "warning", "stderr", ...(isCompileFeatureAllowed("rich-displays") ? ["displays"] : []), "artifacts"]
    : parsed;
  const streams = expanded.map((stream) => {
    if (stream === "displays" && !isCompileFeatureAllowed("rich-displays")) {
      throw new Error("lotus-output-file-streams=displays requires a build with the rich-displays feature.");
    }
    if (stream === "stdout" || stream === "stderr" || stream === "warning" || stream === "metadata" || stream === "displays" || stream === "artifacts") {
      return stream;
    }
    throw new Error(`Unsupported lotus-output-file-streams entry: ${stream}.`);
  });
  return streams.length ? [...new Set(streams)] : ["stdout"];
}

export function resolveOutputVaultPath(configDir: string, file: lotusRunFile, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    throw new Error("lotus-output-file must be a vault-relative path.");
  }

  const path = trimmed.startsWith("/")
    ? normalizeVaultPath(trimmed.slice(1))
    : normalizeVaultPath(dirname(file.path) === "." ? trimmed : `${dirname(file.path)}/${trimmed}`);
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.includes("..") || path.startsWith(`${configDir}/`) || path === configDir || path.startsWith(".git/") || path === ".git") {
    throw new Error(`Invalid lotus-output-file path: ${rawPath}`);
  }
  return path;
}

export function renderOutputFileText(result: lotusStoredOutput["result"], target: lotusOutputFileTarget): string {
  const sections = target.streams.flatMap((stream) => {
    switch (stream) {
      case "metadata":
        return [
          `runner=${result.runnerName}`,
          `exit=${result.exitCode ?? "?"}`,
          `duration=${result.durationMs}ms`,
          `timestamp=${result.finishedAt}`,
        ].join("\n");
      case "stdout":
        return result.stdout ? [result.stdout] : [];
      case "warning":
        return result.warning ? [result.warning] : [];
      case "stderr":
        return result.stderr ? [result.stderr] : [];
      case "displays":
        return result.displays?.length ? [JSON.stringify(result.displays, null, 2)] : [];
      case "artifacts":
        return result.artifacts?.length ? [JSON.stringify(result.artifacts, null, 2)] : [];
    }
  });
  return `${sections.join("\n\n").replace(/\s*$/, "")}\n`;
}

export function renderOutputFileJson(file: lotusRunFile, block: lotusCodeBlock, result: lotusStoredOutput["result"], target: lotusOutputFileTarget): string {
  const payload = {
    note: file.path,
    blockId: block.id,
    language: block.language,
    runner: result.runnerName,
    exitCode: result.exitCode,
    success: result.success,
    durationMs: result.durationMs,
    startedAt: result.startedAt,
    finishedAt: result.finishedAt,
    streams: {
      ...(target.streams.includes("stdout") ? {
        stdout: result.stdout,
        stdoutLanguage: result.stdoutLanguage ?? null,
        stdoutRole: result.stdoutRole ?? null,
      } : {}),
      ...(target.streams.includes("warning") ? { warning: result.warning ?? "" } : {}),
      ...(target.streams.includes("stderr") ? { stderr: result.stderr } : {}),
      ...(target.streams.includes("displays") ? { displays: result.displays ?? [] } : {}),
      ...(target.streams.includes("artifacts") ? { artifacts: result.artifacts ?? [] } : {}),
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}
