import { runTempFileProcess } from "../execution/processRunner";
import { splitCommandLine } from "../utils/command";
import { findEnabledCommandLanguage } from "../languagePackages";
import { resolveHighlightLanguageReference } from "../languageHighlight";
import { isCompileFeatureAllowed } from "../buildProfile";
import type { lotusCodeBlock, lotusCustomLanguage, lotusDisplayRole, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../types";

const DISPLAY_ROLES = new Set<lotusDisplayRole>(["result", "visualization", "diagnostic", "artifact"]);

export class CustomLanguageRunner implements lotusRunner {
  id = "custom";
  displayName = "Custom language";
  languages = [] as const;

  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    return Boolean(this.getCustomLanguage(block, settings)?.executable.trim());
  }

  async run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    const language = this.getCustomLanguage(block, settings);
    if (!language) {
      throw new Error(`Unsupported custom language: ${block.language}`);
    }

    const mode = language.mode === "transpile" ? "transpile" : "execute";
    const readsGeneratedFile = language.outputMode === "file";
    const result = await runTempFileProcess({
      runnerId: `${this.id}:${language.name}`,
      runnerName: mode === "transpile" ? `${language.name} transpiler` : language.name,
      executable: language.executable.trim(),
      args: splitCommandLine(language.args || "{file}"),
      fileExtension: normalizeExtension(language.extension, language.name),
      source: block.content,
      readOutputFile: readsGeneratedFile,
      outputExtension: readsGeneratedFile ? normalizeExtension(language.outputExtension, "out") : undefined,
      workingDirectory: context.workingDirectory,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      stdin: context.stdin,
      stdinSession: context.stdinSession,
      onStdout: context.onStdout,
      onStderr: context.onStderr,
      env: language.packageDirectory ? { LOTUS_LANGUAGE_PACK_DIR: language.packageDirectory } : undefined,
      templateValues: createLanguageTemplateValues(language),
    });
    if (mode === "transpile") {
      const outputLanguage = resolveConfiguredLanguage(language.targetLanguage || language.highlightLanguage, settings);
      result.stdoutRole = "transpiled-source";
      if (outputLanguage) {
        result.stdoutLanguage = outputLanguage;
      }
    }
    attachConfiguredDisplayOutput(result, language);
    return result;
  }

  private getCustomLanguage(block: lotusCodeBlock, settings: lotusPluginSettings): lotusCustomLanguage | undefined {
    return findEnabledCommandLanguage(settings, block.language, block.languageAlias);
  }
}

function createLanguageTemplateValues(language: lotusCustomLanguage): Record<string, string> | undefined {
  const packageDirectory = language.packageDirectory?.trim();
  if (!packageDirectory) {
    return undefined;
  }
  return {
    packDir: packageDirectory,
    packageDir: packageDirectory,
    languagePackDir: packageDirectory,
  };
}

function resolveConfiguredLanguage(language: string | undefined, settings: lotusPluginSettings): string | undefined {
  return resolveHighlightLanguageReference(settings, language) ?? undefined;
}

function normalizeExtension(extension: string | undefined, name: string): string {
  const trimmed = extension?.trim() ?? "";
  if (!trimmed) {
    return `.${name}`;
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function attachConfiguredDisplayOutput(result: lotusRunResult, language: lotusCustomLanguage): void {
  const mode = language.displayOutput ?? "none";
  if (mode !== "copy-stdout" && mode !== "replace-stdout") {
    return;
  }

  if (!isCompileFeatureAllowed("rich-displays")) {
    result.warning = appendText(result.warning ?? "", `Custom language ${language.name} requested display output, but rich displays are not included in this build.`);
    return;
  }

  const content = result.stdout;
  if (!content.trim()) {
    return;
  }

  const mimeType = normalizeDisplayMimeType(language.displayMimeType);
  if (!mimeType) {
    result.warning = appendText(result.warning ?? "", `Custom language ${language.name} requested display output without a valid MIME type.`);
    return;
  }

  const title = language.displayTitle?.trim() || `${language.name} output`;
  const role = readDisplayRole(language.displayRole);
  const height = readDisplayHeight(language.displayHeight);
  const data = mimeType === "text/plain"
    ? { "text/plain": content }
    : {
      [mimeType]: content,
      "text/plain": title,
    };

  result.displays = [
    ...(result.displays ?? []),
    {
      title,
      ...(role ? { role } : {}),
      data,
      ...(height ? { metadata: { height } } : {}),
    },
  ];

  if (mode === "replace-stdout") {
    result.stdout = "";
  }
}

function normalizeDisplayMimeType(value: string | undefined): string {
  const trimmed = value?.trim().toLowerCase() ?? "";
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\+[a-z0-9!#$&^_.+-]+)?$/.test(trimmed) ? trimmed : "";
}

function readDisplayRole(value: lotusDisplayRole | undefined): lotusDisplayRole | undefined {
  return value && DISPLAY_ROLES.has(value) ? value : undefined;
}

function readDisplayHeight(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function appendText(left: string, right: string): string {
  if (!left) {
    return right;
  }
  if (!right) {
    return left;
  }
  return `${left}${left.endsWith("\n") ? "" : "\n"}${right}`;
}
