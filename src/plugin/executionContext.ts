import { dirname, isAbsolute, join } from "path";
import { normalizePath, type App, type TFile } from "obsidian";
import type { lotusCodeBlock, lotusExecutionContextOverride, lotusPluginSettings, lotusResolvedExecutionContext } from "../engine/types";
import { readFrontmatterTimeoutMs } from "../engine/utils/timeout";

interface NoteExecutionContext {
  containerGroup?: string;
  disableContainer?: boolean;
  workingDirectory?: string;
  timeoutMs?: lotusResolvedExecutionContext["timeoutMs"];
}

export function resolveExecutionContext(
  app: App,
  file: TFile,
  block: lotusCodeBlock,
  settings: lotusPluginSettings,
): lotusResolvedExecutionContext {
  const note = readNoteExecutionContext(app, file);
  const vaultBasePath = readVaultBasePath(file);
  const defaultWorkingDirectory = resolveDefaultWorkingDirectory(file, settings, vaultBasePath);
  const noteWorkingDirectory = resolveWorkingDirectoryOverride(note.workingDirectory, vaultBasePath);
  const blockWorkingDirectory = resolveWorkingDirectoryOverride(block.executionContext.workingDirectory, vaultBasePath);
  const noteTimeout = note.timeoutMs;
  const blockTimeout = block.executionContext.timeoutMs;

  return {
    containerGroup: resolveContainerGroup(settings.defaultContainerGroup, note, block.executionContext),
    workingDirectory: blockWorkingDirectory ?? noteWorkingDirectory ?? defaultWorkingDirectory,
    timeoutMs: blockTimeout ?? noteTimeout ?? settings.defaultTimeoutMs,
    source: {
      container: resolveContainerSource(settings.defaultContainerGroup, note, block.executionContext),
      workingDirectory: blockWorkingDirectory !== undefined ? "block" : noteWorkingDirectory !== undefined ? "note" : settings.workingDirectory.trim() ? "global" : "default",
      timeout: blockTimeout !== undefined ? "block" : noteTimeout !== undefined ? "note" : "global",
    },
  };
}

function resolveContainerGroup(
  globalContainer: string,
  note: NoteExecutionContext,
  block: lotusExecutionContextOverride,
): string | undefined {
  if (block.disableContainer) {
    return undefined;
  }
  if (block.containerGroup?.trim()) {
    return block.containerGroup.trim();
  }
  if (note.disableContainer) {
    return undefined;
  }
  if (note.containerGroup?.trim()) {
    return note.containerGroup.trim();
  }
  return globalContainer.trim() || undefined;
}

function resolveContainerSource(
  globalContainer: string,
  note: NoteExecutionContext,
  block: lotusExecutionContextOverride,
): lotusResolvedExecutionContext["source"]["container"] {
  if (block.disableContainer || block.containerGroup?.trim()) {
    return "block";
  }
  if (note.disableContainer || note.containerGroup?.trim()) {
    return "note";
  }
  if (globalContainer.trim()) {
    return "global";
  }
  return "none";
}

function readNoteExecutionContext(app: App, file: TFile): NoteExecutionContext {
  const rawFrontmatter: unknown = app.metadataCache.getFileCache(file)?.frontmatter;
  const frontmatter = isRecord(rawFrontmatter) ? rawFrontmatter : null;
  if (!frontmatter) {
    return {};
  }

  const container = frontmatter["lotus-execution"] ?? frontmatter["lotus-container"];
  const workingDirectory = frontmatter["lotus-cwd"] ?? frontmatter["lotus-working-directory"];
  const timeout = frontmatter["lotus-timeout"];

  return {
    containerGroup: typeof container === "string" && !isDisabledValue(container) ? container.trim() : undefined,
    disableContainer: typeof container === "string" ? isDisabledValue(container) : undefined,
    workingDirectory: typeof workingDirectory === "string" ? workingDirectory : undefined,
    timeoutMs: readFrontmatterTimeoutMs(timeout),
  };
}

function resolveDefaultWorkingDirectory(file: TFile, settings: lotusPluginSettings, vaultBasePath: string): string {
  if (settings.workingDirectory.trim()) {
    return resolveConfiguredWorkingDirectory(settings.workingDirectory, vaultBasePath);
  }

  const fileFolder = dirname(file.path);
  const resolved = fileFolder === "." ? vaultBasePath : join(vaultBasePath, fileFolder);
  return resolved || process.cwd();
}

function resolveWorkingDirectoryOverride(value: string | undefined, vaultBasePath: string): string | undefined {
  return value?.trim() ? resolveConfiguredWorkingDirectory(value, vaultBasePath) : undefined;
}

function resolveConfiguredWorkingDirectory(value: string, vaultBasePath: string): string {
  const configured = normalizePath(value.trim());
  if (configured === ".") {
    return vaultBasePath || process.cwd();
  }
  if (isAbsolute(configured)) {
    return configured;
  }
  return vaultBasePath ? join(vaultBasePath, configured) : configured;
}

function readVaultBasePath(file: TFile): string {
  return (file.vault.adapter as { basePath?: string }).basePath ?? "";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isDisabledValue(value: string): boolean {
  return ["0", "false", "no", "off", "none", "native"].includes(value.trim().toLowerCase());
}
