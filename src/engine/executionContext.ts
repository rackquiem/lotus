import { dirname, isAbsolute, join } from "path";
import { normalizeVaultPath } from "./utils/vaultPath";
import type { lotusCodeBlock, lotusExecutionContextOverride, lotusPluginSettings, lotusResolvedExecutionContext, lotusRunFile } from "./types";
import type { lotusVaultHost } from "./vaultHost";
import { readFrontmatterTimeoutMs } from "./utils/timeout";

export type lotusExecutionContextHost = Pick<lotusVaultHost, "readFrontmatter" | "vaultBasePath">;

interface NoteExecutionContext {
  containerGroup?: string;
  disableContainer?: boolean;
  workingDirectory?: string;
  timeoutMs?: lotusResolvedExecutionContext["timeoutMs"];
}

export function resolveExecutionContext(
  host: lotusExecutionContextHost,
  file: lotusRunFile,
  block: lotusCodeBlock,
  settings: lotusPluginSettings,
): lotusResolvedExecutionContext {
  const note = readNoteExecutionContext(host, file);
  const vaultBasePath = host.vaultBasePath ?? "";
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

function readNoteExecutionContext(host: lotusExecutionContextHost, file: lotusRunFile): NoteExecutionContext {
  const frontmatter = host.readFrontmatter(file.path) ?? null;
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

function resolveDefaultWorkingDirectory(file: lotusRunFile, settings: lotusPluginSettings, vaultBasePath: string): string {
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
  const configured = normalizeVaultPath(value.trim());
  if (configured === ".") {
    return vaultBasePath || process.cwd();
  }
  if (isAbsolute(configured)) {
    return configured;
  }
  return vaultBasePath ? join(vaultBasePath, configured) : configured;
}

function isDisabledValue(value: string): boolean {
  return ["0", "false", "no", "off", "none", "native"].includes(value.trim().toLowerCase());
}
