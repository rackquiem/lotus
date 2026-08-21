import { lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { basename, dirname, extname, join, relative, resolve, sep } from "path";
import { spawn } from "child_process";
import type { lotusDisplayOutput, lotusDisplayRole, lotusRunArtifact, lotusRunResult, lotusStdinSession } from "../types";
import { formatTimeoutMs, type lotusTimeoutMs } from "../utils/timeout";
import { lotusClearTimeout, lotusSetTimeout, type LotusTimeoutHandle } from "../utils/timers";

const FORCE_KILL_GRACE_MS = 1_500;
const MAX_DISPLAY_JSONL_BYTES = 10 * 1024 * 1024;
const MAX_ARTIFACT_COUNT = 32;
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const DISPLAY_ROLES = new Set<lotusDisplayRole>(["result", "visualization", "diagnostic", "artifact"]);

export interface lotusProcessSpec {
  runnerId: string;
  runnerName: string;
  executable: string;
  args: string[];
  workingDirectory: string;
  timeoutMs: lotusTimeoutMs;
  signal: AbortSignal;
  stdinPrefix?: string | Buffer;
  stdin?: string;
  stdinSession?: lotusStdinSession;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  env?: NodeJS.ProcessEnv;
  templateValues?: Record<string, string>;
}

export interface lotusTempSourceSpec extends lotusProcessSpec {
  fileExtension: string;
  source: string;
  readOutputFile?: boolean;
  outputExtension?: string;
}

export interface lotusTempSourceHandle {
  tempDir: string;
  tempFile: string;
  outputFile?: string;
}

export interface lotusTempSourceFileSpec {
  path: string;
  source: string;
}

export interface lotusTempSourceFilesHandle {
  tempDir: string;
  files: Map<string, string>;
}

export async function withNamedTempSourceFile<T>(
  fileName: string,
  source: string,
  callback: (handle: lotusTempSourceHandle) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "lotus-"));
  const tempFile = join(tempDir, fileName);

  try {
    await writeFile(tempFile, normalizeExecutableSource(source), "utf8");
    return await callback({ tempDir, tempFile });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export async function withTempSourceFile<T>(
  fileExtension: string,
  source: string,
  callback: (handle: lotusTempSourceHandle) => Promise<T>,
): Promise<T> {
  return withNamedTempSourceFile(`snippet${fileExtension}`, source, callback);
}

export async function withTempSourceFiles<T>(
  sources: readonly lotusTempSourceFileSpec[],
  callback: (handle: lotusTempSourceFilesHandle) => Promise<T>,
): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), "lotus-"));
  const files = new Map<string, string>();
  const resolvedTempDir = resolve(tempDir);

  try {
    for (const source of sources) {
      const tempFile = resolve(tempDir, ...source.path.split("/"));
      if (!tempFile.startsWith(`${resolvedTempDir}${sep}`)) {
        throw new Error(`temporary source path escapes its package directory: ${source.path}`);
      }
      await mkdir(dirname(tempFile), { recursive: true });
      await writeFile(tempFile, normalizeExecutableSource(source.source), "utf8");
      files.set(source.path, tempFile);
    }
    return await callback({ tempDir, files });
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

function normalizeExecutableSource(source: string): string {
  const lines = source.split("\n");
  const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
  if (!nonEmptyLines.length) {
    return source;
  }

  let sharedIndent = getLeadingWhitespace(nonEmptyLines[0]);
  for (const line of nonEmptyLines.slice(1)) {
    sharedIndent = sharedWhitespacePrefix(sharedIndent, getLeadingWhitespace(line));
    if (!sharedIndent) {
      return source;
    }
  }

  if (!sharedIndent) {
    return source;
  }

  return lines
    .map((line) => (line.trim().length === 0 ? line : line.startsWith(sharedIndent) ? line.slice(sharedIndent.length) : line))
    .join("\n");
}

function getLeadingWhitespace(line: string): string {
  const match = line.match(/^[\t ]*/);
  return match?.[0] ?? "";
}

function sharedWhitespacePrefix(left: string, right: string): string {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) {
    index += 1;
  }
  return left.slice(0, index);
}

export async function runProcess(spec: lotusProcessSpec): Promise<lotusRunResult> {
  const startedAt = new Date();
  const displayEnv = await createProcessDisplayEnvironment();
  let stdout = "";
  let stderr = "";
  let displayWarning: string | undefined;
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;
  let timedOut = false;
  let cancelled = false;
  let child: ReturnType<typeof spawn> | null = null;
  let childExited = false;
  let timeoutHandle: LotusTimeoutHandle | null = null;
  let killHandle: LotusTimeoutHandle | null = null;
  let abortHandler: (() => void) | null = null;
  let detachStdinSession: (() => void) | undefined;

  try {
    await new Promise<void>((resolve, reject) => {
      const terminateChild = (signal: NodeJS.Signals) => {
        if (!child || childExited) {
          return;
        }
        child.kill(signal);
        if (killHandle === null) {
          killHandle = lotusSetTimeout(() => {
            if (child && !childExited) {
              child.kill("SIGKILL");
            }
          }, FORCE_KILL_GRACE_MS);
        }
      };

      child = spawn(spec.executable, spec.args, {
        cwd: spec.workingDirectory,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...process.env,
          LOTUS_DISPLAY_JSONL: displayEnv.jsonlPath,
          LOTUS_ARTIFACT_DIR: displayEnv.artifactDir,
          ...spec.env,
        },
      });
      child.stdin?.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code !== "EPIPE") {
          reject(error);
        }
      });

      const attachStdinSession = () => {
        if (!spec.stdinSession) {
          return;
        }
        detachStdinSession = spec.stdinSession.attachWriter((chunk) => {
          if (!child?.stdin || child.stdin.destroyed || childExited) {
            return;
          }
          if (chunk == null) {
            child.stdin.end();
            return;
          }
          child.stdin.write(chunk);
        });
      };

      if (spec.stdinPrefix != null && spec.stdin != null) {
        child.stdin?.end(combineStdinPrefix(spec.stdinPrefix, spec.stdin));
      } else if (spec.stdinPrefix != null) {
        child.stdin?.write(spec.stdinPrefix, (error?: Error | null) => {
          if (error) {
            if (!("code" in error) || (error as NodeJS.ErrnoException).code !== "EPIPE") {
              reject(error);
            }
            return;
          }
          if (spec.stdinSession) {
            attachStdinSession();
          } else {
            child?.stdin?.end();
          }
        });
      } else if (spec.stdin != null) {
        child.stdin?.end(spec.stdin);
      } else if (spec.stdinSession) {
        attachStdinSession();
      } else {
        child.stdin?.destroy();
      }

      const abort = () => {
        cancelled = true;
        terminateChild("SIGTERM");
      };
      abortHandler = abort;

      if (spec.signal.aborted) {
        abort();
      } else {
        spec.signal.addEventListener("abort", abort, { once: true });
      }

      if (spec.timeoutMs !== null) {
        timeoutHandle = lotusSetTimeout(() => {
          timedOut = true;
          terminateChild("SIGTERM");
        }, spec.timeoutMs);
      }

      child.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stdout += text;
        spec.onStdout?.(text);
      });

      child.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString();
        stderr += text;
        spec.onStderr?.(text);
      });

      child.on("error", (error) => {
        reject(error);
      });

      child.on("close", (code, signal) => {
        childExited = true;
        if (killHandle !== null) {
          lotusClearTimeout(killHandle);
          killHandle = null;
        }
        exitCode = code;
        exitSignal = signal;
        resolve();
      });
    });
  } catch (error) {
    stderr = stderr || formatProcessError(error, spec.executable);
    exitCode = exitCode ?? -1;
  } finally {
    if (abortHandler) {
      spec.signal.removeEventListener("abort", abortHandler);
    }
    if (detachStdinSession) {
      detachStdinSession();
      detachStdinSession = undefined;
    }
    if (timeoutHandle !== null) {
      lotusClearTimeout(timeoutHandle);
    }
    if (killHandle !== null) {
      lotusClearTimeout(killHandle);
    }
  }

  const finishedAt = new Date();
  const durationMs = finishedAt.getTime() - startedAt.getTime();
  let displays: lotusDisplayOutput[] = [];
  let artifacts: lotusRunArtifact[] = [];
  try {
    displays = await readProcessDisplayOutputs(displayEnv.jsonlPath);
    artifacts = await readProcessArtifacts(displayEnv.artifactDir);
  } catch (error) {
    displayWarning = `Failed to read Lotus display or artifact output: ${error instanceof Error ? error.message : String(error)}`;
  } finally {
    await rm(displayEnv.tempDir, { recursive: true, force: true });
  }

  if (!stderr.trim()) {
    if (timedOut) {
      stderr = `Process timed out after ${formatTimeoutMs(spec.timeoutMs)}.`;
    } else if (cancelled) {
      stderr = "Process was cancelled.";
    } else if (exitCode == null && exitSignal) {
      stderr = `Process exited after signal ${exitSignal}.`;
    } else if (exitCode == null) {
      stderr = "Process exited without an exit code.";
    }
  }
  const success = !timedOut && !cancelled && exitCode === 0;
  const warning = displayWarning;

  return {
    runnerId: spec.runnerId,
    runnerName: spec.runnerName,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs,
    exitCode,
    stdout,
    stderr,
    success,
    timedOut,
    cancelled,
    ...(warning ? { warning } : {}),
    ...(displays.length ? { displays } : {}),
    ...(artifacts.length ? { artifacts } : {}),
  };
}

function formatProcessError(error: unknown, executable: string): string {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return `Executable not found: ${executable}`;
  }

  return error instanceof Error ? error.message : String(error);
}

function combineStdinPrefix(prefix: string | Buffer, stdin: string): string | Buffer {
  if (Buffer.isBuffer(prefix)) {
    return Buffer.concat([prefix, Buffer.from(stdin)]);
  }

  return `${prefix}${stdin}`;
}

async function createProcessDisplayEnvironment(): Promise<{ tempDir: string; artifactDir: string; jsonlPath: string }> {
  const tempDir = await mkdtemp(join(tmpdir(), "lotus-display-"));
  const artifactDir = join(tempDir, "artifacts");
  const jsonlPath = join(tempDir, "display.jsonl");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(jsonlPath, "", "utf8");
  return { tempDir, artifactDir, jsonlPath };
}

async function readProcessDisplayOutputs(jsonlPath: string): Promise<lotusDisplayOutput[]> {
  let raw: Buffer;
  try {
    raw = await readFile(jsonlPath);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  if (!raw.length) {
    return [];
  }
  if (raw.length > MAX_DISPLAY_JSONL_BYTES) {
    throw new Error(`display JSONL exceeded ${MAX_DISPLAY_JSONL_BYTES} bytes`);
  }

  const displays: lotusDisplayOutput[] = [];
  const lines = raw.toString("utf8").split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (!line) {
      continue;
    }
    const parsed: unknown = JSON.parse(line);
    const display = normalizeDisplayOutput(parsed);
    if (!display) {
      throw new Error(`invalid display record on line ${index + 1}`);
    }
    displays.push(display);
  }
  return displays;
}

async function readProcessArtifacts(artifactDir: string): Promise<lotusRunArtifact[]> {
  const paths = await listArtifactFiles(artifactDir, artifactDir);
  const artifacts: lotusRunArtifact[] = [];
  let totalBytes = 0;
  for (const path of paths.sort()) {
    if (artifacts.length >= MAX_ARTIFACT_COUNT) {
      break;
    }
    const stats = await lstat(path);
    if (!stats.isFile()) {
      continue;
    }
    totalBytes += stats.size;
    if (totalBytes > MAX_ARTIFACT_BYTES) {
      throw new Error(`artifact files exceeded ${MAX_ARTIFACT_BYTES} bytes`);
    }
    const data = await readFile(path);
    const artifactPath = normalizeArtifactPath(relative(artifactDir, path));
    artifacts.push({
      name: basename(artifactPath),
      path: artifactPath,
      mimeType: inferArtifactMimeType(path),
      size: data.byteLength,
      dataBase64: data.toString("base64"),
    });
  }
  return artifacts;
}

async function listArtifactFiles(root: string, current: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const files: string[] = [];
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      if (normalizeArtifactPath(relative(root, path)).split("/").length <= 4) {
        files.push(...await listArtifactFiles(root, path));
      }
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function normalizeArtifactPath(path: string): string {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).join("/");
}

function inferArtifactMimeType(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".html":
    case ".htm":
      return "text/html";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".json":
      return "application/json";
    case ".pdf":
      return "application/pdf";
    case ".tex":
      return "application/x-tex";
    case ".md":
      return "text/markdown";
    case ".txt":
    case ".log":
      return "text/plain";
    default:
      return "application/octet-stream";
  }
}

function normalizeDisplayOutput(value: unknown): lotusDisplayOutput | null {
  if (!isRecord(value) || !isRecord(value.data)) {
    return null;
  }
  const role = typeof value.role === "string" && DISPLAY_ROLES.has(value.role as lotusDisplayRole)
    ? value.role as lotusDisplayRole
    : undefined;
  const metadata = isRecord(value.metadata) ? value.metadata : undefined;
  return {
    ...(typeof value.id === "string" && value.id.trim() ? { id: value.id.trim() } : {}),
    ...(typeof value.title === "string" && value.title.trim() ? { title: value.title.trim() } : {}),
    ...(role ? { role } : {}),
    data: value.data,
    ...(metadata ? { metadata } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function runTempFileProcess(spec: lotusTempSourceSpec): Promise<lotusRunResult> {
  return withTempSourceFile(spec.fileExtension, spec.source, async ({ tempFile, tempDir }) => {
    const outputFile = spec.readOutputFile || spec.outputExtension
      ? join(tempDir, `output${normalizeTempOutputExtension(spec.outputExtension)}`)
      : undefined;
    const result = await runProcess({
      runnerId: spec.runnerId,
      runnerName: spec.runnerName,
      executable: expandTempPathTemplates(spec.executable, tempFile, tempDir, outputFile, spec.templateValues),
      args: spec.args.map((value) => expandTempPathTemplates(value, tempFile, tempDir, outputFile, spec.templateValues)),
      workingDirectory: spec.workingDirectory,
      timeoutMs: spec.timeoutMs,
      signal: spec.signal,
      stdin: spec.stdin,
      stdinSession: spec.stdinSession,
      onStdout: spec.onStdout,
      onStderr: spec.onStderr,
      env: expandTemplatedEnv(spec.env, tempFile, tempDir, outputFile, spec.templateValues),
    });

    if (!spec.readOutputFile || !outputFile) {
      return result;
    }
    return readGeneratedOutputFile(result, outputFile, spec.onStdout);
  });
}

async function readGeneratedOutputFile(
  result: lotusRunResult,
  outputFile: string,
  onStdout: ((chunk: string) => void) | undefined,
): Promise<lotusRunResult> {
  try {
    const generatedOutput = await readFile(outputFile, "utf8");
    if (generatedOutput.length) {
      onStdout?.(generatedOutput);
    }
    return {
      ...result,
      stdout: appendText(result.stdout, generatedOutput),
    };
  } catch (error) {
    return {
      ...result,
      stderr: appendText(result.stderr, formatOutputFileError(error, outputFile)),
      success: false,
    };
  }
}

function expandTemplatedEnv(
  env: NodeJS.ProcessEnv | undefined,
  tempFile: string,
  tempDir: string,
  outputFile: string | undefined,
  templateValues: Record<string, string> | undefined,
): NodeJS.ProcessEnv | undefined {
  if (!env) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(env).map(([key, value]) => [
      key,
      typeof value === "string" ? expandTempPathTemplates(value, tempFile, tempDir, outputFile, templateValues) : value,
    ]),
  );
}

function expandTempPathTemplates(
  value: string,
  tempFile: string,
  tempDir: string,
  outputFile: string | undefined,
  templateValues: Record<string, string> | undefined,
): string {
  let expanded = value
    .replaceAll("{file}", tempFile)
    .replaceAll("{tempDir}", tempDir)
    .replaceAll("{output}", outputFile ?? "");
  for (const [key, replacement] of Object.entries(templateValues ?? {})) {
    expanded = expanded.replaceAll(`{${key}}`, replacement);
  }
  return expanded;
}

function normalizeTempOutputExtension(value: string | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) {
    return ".out";
  }
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function appendText(left: string, right: string): string {
  if (!right) {
    return left;
  }
  if (!left) {
    return right;
  }
  return `${left}${left.endsWith("\n") ? "" : "\n"}${right}`;
}

function formatOutputFileError(error: unknown, outputFile: string): string {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return `Expected output file was not produced: ${outputFile}`;
  }
  return `Failed to read output file ${outputFile}: ${error instanceof Error ? error.message : String(error)}`;
}
