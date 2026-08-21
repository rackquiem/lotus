import { spawn } from "child_process";
import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { basename, join, resolve, sep } from "path";
import type { lotusCodeBlock, lotusCustomPreprocessor, lotusNormalizedLanguage, lotusSourcePreviewStage } from "./types";
import { splitCommandLine } from "./utils/command";
import { formatTimeoutMs, type lotusTimeoutMs } from "./utils/timeout";
import { lotusClearTimeout, lotusSetTimeout, type LotusTimeoutHandle } from "./utils/timers";

export interface lotusExternalSourcePreprocessor extends lotusCustomPreprocessor {
  args: string;
}

export interface lotusPreprocessorPipelineSpec {
  languageName: string;
  initialExtension: string;
  stages: lotusExternalSourcePreprocessor[];
  artifactDirectory: string;
  workingDirectory: string;
  timeoutMs: lotusTimeoutMs;
  signal?: AbortSignal;
}

export interface lotusPreprocessorPipelineResult {
  block: lotusCodeBlock;
  stages: lotusSourcePreviewStage[];
  description: string;
  artifactDirectory: string;
}

interface lotusPreprocessorCommandResult {
  stdout: string;
  stderr: string;
}

interface lotusPreprocessorStageResult {
  content?: unknown;
  source?: unknown;
  outputFile?: unknown;
  language?: unknown;
  extension?: unknown;
  description?: unknown;
}

interface lotusPreprocessorStageState {
  content: string;
  language: lotusNormalizedLanguage;
  extension: string;
  filePath: string;
}

export async function runExternalSourcePreprocessorPipeline(
  source: string,
  block: lotusCodeBlock,
  spec: lotusPreprocessorPipelineSpec,
): Promise<lotusPreprocessorPipelineResult> {
  const stages = spec.stages.filter((stage) => stage.executable.trim());
  if (!stages.length) {
    return {
      block,
      stages: [],
      description: "",
      artifactDirectory: spec.artifactDirectory,
    };
  }

  await mkdir(spec.artifactDirectory, { recursive: true });
  let current: lotusPreprocessorStageState = {
    content: source,
    language: block.language,
    extension: normalizeExtension(spec.initialExtension, block.language),
    filePath: join(spec.artifactDirectory, `stage-00-input${normalizeExtension(spec.initialExtension, block.language)}`),
  };
  await writeFile(current.filePath, current.content, "utf8");

  const previewStages: lotusSourcePreviewStage[] = [{
    label: "Input",
    description: "Original materialized source",
    language: current.language,
    extension: current.extension,
    path: current.filePath,
    content: current.content,
  }];

  for (let index = 0; index < stages.length; index += 1) {
    const stage = stages[index];
    const stageNumber = index + 1;
    const stageName = normalizeStageName(stage.name || `stage-${stageNumber}`);
    const configuredLanguage = normalizeLanguageId(stage.language) || current.language;
    const configuredExtension = normalizeExtension(stage.extension || current.extension, configuredLanguage);
    const outputFile = join(spec.artifactDirectory, `stage-${String(stageNumber).padStart(2, "0")}-${stageName}${configuredExtension}`);
    const requestFile = join(spec.artifactDirectory, `stage-${String(stageNumber).padStart(2, "0")}-${stageName}.json`);
    const request = {
      language: current.language,
      outputLanguage: configuredLanguage,
      extension: current.extension,
      outputExtension: configuredExtension,
      sourceLanguage: block.sourceLanguage,
      languageAlias: block.languageAlias,
      notePath: block.filePath,
      filePath: block.filePath,
      blockId: block.id,
      ordinal: block.ordinal,
      stage: stageNumber,
      stageName: stage.name || `stage-${stageNumber}`,
      attributes: block.attributes,
      inputFile: current.filePath,
      sourceFile: current.filePath,
      outputFile,
      artifactDirectory: spec.artifactDirectory,
    };
    const requestJson = JSON.stringify(request, null, 2);
    await writeFile(requestFile, requestJson, "utf8");

    const commandResult = await runPreprocessorCommand(stage, spec, {
      requestFile,
      inputFile: current.filePath,
      outputFile,
      artifactDirectory: spec.artifactDirectory,
      language: current.language,
      outputLanguage: configuredLanguage,
      extension: current.extension,
      outputExtension: configuredExtension,
      sourceLanguage: block.sourceLanguage,
      languageAlias: block.languageAlias,
      notePath: block.filePath,
      blockId: block.id,
      stage: stageNumber,
      stageName: stage.name || `stage-${stageNumber}`,
      requestJson,
    });
    const parsed = await resolveStageOutput(commandResult.stdout, outputFile, spec.artifactDirectory);
    const nextLanguage = normalizeLanguageId(parsed.language) || configuredLanguage;
    const nextExtension = normalizeExtension(
      typeof parsed.extension === "string" && parsed.extension.trim() ? parsed.extension : configuredExtension,
      nextLanguage,
    );
    const nextOutputFile = nextExtension === configuredExtension
      ? outputFile
      : join(spec.artifactDirectory, `stage-${String(stageNumber).padStart(2, "0")}-${stageName}${nextExtension}`);
    const nextContent = parsed.content;

    if (!nextContent.trim()) {
      throw new Error(`Custom source preprocessor ${stage.name || stageNumber} returned no content.`);
    }
    await writeFile(nextOutputFile, nextContent, "utf8");

    current = {
      content: nextContent,
      language: nextLanguage,
      extension: nextExtension,
      filePath: nextOutputFile,
    };
    previewStages.push({
      label: stage.name || `Stage ${stageNumber}`,
      description: parsed.description || `${basename(stage.executable)} -> ${nextLanguage}${nextExtension}`,
      language: current.language,
      extension: current.extension,
      path: current.filePath,
      content: current.content,
    });
  }

  const description = previewStages
    .slice(1)
    .map((stage) => stage.label)
    .join(" -> ");
  return {
    block: {
      ...block,
      language: current.language,
      languageAlias: current.language,
      sourceLanguage: current.language,
      content: current.content,
    },
    stages: previewStages,
    description,
    artifactDirectory: spec.artifactDirectory,
  };
}

async function runPreprocessorCommand(
  stage: lotusExternalSourcePreprocessor,
  spec: lotusPreprocessorPipelineSpec,
  values: {
    requestFile: string;
    inputFile: string;
    outputFile: string;
    artifactDirectory: string;
    language: string;
    outputLanguage: string;
    extension: string;
    outputExtension: string;
    sourceLanguage: string;
    languageAlias: string;
    notePath: string;
    blockId: string;
    stage: number;
    stageName: string;
    requestJson: string;
  },
): Promise<lotusPreprocessorCommandResult> {
  const executable = stage.executable.trim();
  const args = splitCommandLine(stage.args || "{request}").map((arg) => arg
    .replaceAll("{request}", values.requestFile)
    .replaceAll("{source}", values.inputFile)
    .replaceAll("{file}", values.inputFile)
    .replaceAll("{input}", values.inputFile)
    .replaceAll("{output}", values.outputFile)
    .replaceAll("{artifactDir}", values.artifactDirectory)
    .replaceAll("{language}", values.language)
    .replaceAll("{outputLanguage}", values.outputLanguage)
    .replaceAll("{extension}", values.extension)
    .replaceAll("{outputExtension}", values.outputExtension)
    .replaceAll("{sourceLanguage}", values.sourceLanguage)
    .replaceAll("{alias}", values.languageAlias)
    .replaceAll("{note}", values.notePath)
    .replaceAll("{blockId}", values.blockId)
    .replaceAll("{stage}", String(values.stage))
    .replaceAll("{stageName}", values.stageName));

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: spec.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeout: LotusTimeoutHandle | null = null;
    let abortHandler: (() => void) | null = null;

    const cleanup = () => {
      if (timeout !== null) {
        lotusClearTimeout(timeout);
        timeout = null;
      }
      if (abortHandler) {
        spec.signal?.removeEventListener("abort", abortHandler);
        abortHandler = null;
      }
    };

    const fail = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      fail(formatSpawnError(error, executable, "Custom source preprocessor"));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Custom source preprocessor exited with code ${code}.`).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });

    abortHandler = () => {
      child.kill("SIGTERM");
      fail(new Error("Custom source preprocessor was cancelled."));
    };
    if (spec.signal?.aborted) {
      abortHandler();
      return;
    }
    spec.signal?.addEventListener("abort", abortHandler, { once: true });

    if (spec.timeoutMs !== null) {
      timeout = lotusSetTimeout(() => {
        child.kill("SIGTERM");
        fail(new Error(`Custom source preprocessor timed out after ${formatTimeoutMs(spec.timeoutMs)}.`));
      }, spec.timeoutMs);
    }

    child.stdin.end(values.requestJson);
  });
}

async function resolveStageOutput(stdout: string, plannedOutputFile: string, artifactDirectory: string): Promise<{ content: string; language?: unknown; extension?: unknown; description: string }> {
  const parsed = parseStageJson(stdout);
  if (parsed) {
    const outputFile = typeof parsed.outputFile === "string" && parsed.outputFile.trim()
      ? parsed.outputFile.trim()
      : plannedOutputFile;
    if (!isPathWithin(outputFile, artifactDirectory)) {
      throw new Error("Custom source preprocessor outputFile must stay inside the stage artifact directory.");
    }
    const content = typeof parsed.content === "string"
      ? parsed.content
      : typeof parsed.source === "string"
        ? parsed.source
        : await readExistingFile(outputFile);
    return {
      content,
      language: parsed.language,
      extension: parsed.extension,
      description: typeof parsed.description === "string" ? parsed.description.trim() : "",
    };
  }

  if (stdout.length) {
    return { content: stdout, description: "" };
  }

  return {
    content: await readExistingFile(plannedOutputFile),
    description: "",
  };
}

function isPathWithin(path: string, parent: string): boolean {
  const resolvedPath = resolve(path);
  const resolvedParent = resolve(parent);
  return resolvedPath === resolvedParent || resolvedPath.startsWith(`${resolvedParent}${sep}`);
}

function parseStageJson(output: string): lotusPreprocessorStageResult | null {
  const trimmed = output.trim();
  if (!trimmed.startsWith("{")) {
    return null;
  }

  try {
    const parsed = JSON.parse(trimmed) as lotusPreprocessorStageResult;
    return typeof parsed === "object" && parsed != null ? parsed : null;
  } catch {
    return null;
  }
}

async function readExistingFile(filePath: string): Promise<string> {
  try {
    const fileStat = await stat(filePath);
    if (!fileStat.isFile()) {
      return "";
    }
    return await readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function normalizeStageName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "") || "stage";
}

function normalizeLanguageId(value: unknown): lotusNormalizedLanguage | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return normalized ? normalized : null;
}

function normalizeExtension(extension: string, language: string): string {
  const trimmed = extension.trim();
  if (!trimmed) {
    return `.${language}`;
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function formatSpawnError(error: unknown, executable: string, label: string): Error {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return new Error(`${label} executable not found: ${executable}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}
