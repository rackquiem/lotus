import { closeSync, constants, existsSync, openSync } from "fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { basename, delimiter, isAbsolute, join, normalize as normalizeFsPath, posix as posixPath } from "path";
import { spawn } from "child_process";
import { isCompileContainerGroupAllowed, isCompileContainerRuntimeAllowed, isCompileFeatureAllowed } from "../buildProfile";
import { runProcess } from "./processRunner";
import { splitCommandLine } from "../utils/command";
import { findEnabledCommandLanguage } from "../languagePackages";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult } from "../types";
import { lotusClearTimeout, lotusSetTimeout } from "../utils/timers";
import { type lotusTimeoutMs } from "../utils/timeout";
import { DEFAULT_GODBOLT_COMPILER_DEFAULTS, DEFAULT_GODBOLT_OPTIONS_DEFAULTS } from "../defaultSettings";

type lotusContainerRuntime = "docker" | "podman" | "qemu" | "wsl" | "ssh" | "custom" | "http";
type lotusContainerElevationMode = "default" | "root";
const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");
const BUILT_IN_GODBOLT_GROUP = "godbolt";
const GODBOLT_DEFAULT_BASE_URL = "https://godbolt.org";
const GODBOLT_PRIVACY_WARNING = "[Lotus] Godbolt shortlinks are public and send this snippet to Compiler Explorer.";
const GODBOLT_DEFAULT_COMPILERS = DEFAULT_GODBOLT_COMPILER_DEFAULTS;
const GODBOLT_DEFAULT_COMPILER_OPTIONS = DEFAULT_GODBOLT_OPTIONS_DEFAULTS;
const GODBOLT_DEFAULT_COMPILER_FILTERS: lotusGodboltCompilerFilters = {
  binary: false,
  binaryObject: false,
  commentOnly: true,
  demangle: true,
  directives: true,
  execute: false,
  intel: true,
  labels: true,
  libraryCode: false,
  trim: false,
};
const GODBOLT_LANGUAGE_ALIASES: Record<string, string> = {
  "c": "c",
  "h": "c",
  "ebpf": "c",
  "ebpf-c": "c",
  "bpf": "c",
  "bpf-c": "c",
  "cpp": "c++",
  "c++": "c++",
  "cc": "c++",
  "cxx": "c++",
  "hpp": "c++",
  "hxx": "c++",
  "rust": "rust",
  "rs": "rust",
  "go": "go",
  "golang": "go",
  "java": "java",
  "python": "python",
  "py": "python",
  "javascript": "javascript",
  "js": "javascript",
  "obsidian-js": "javascript",
  "obsidianjs": "javascript",
  "obsidian-javascript": "javascript",
  "typescript": "typescript",
  "ts": "typescript",
  "ruby": "ruby",
  "rb": "ruby",
  "perl": "perl",
  "pl": "perl",
  "lua": "lua",
  "haskell": "haskell",
  "hs": "haskell",
  "ocaml": "ocaml",
  "ml": "ocaml",
  "lean": "lean",
  "lean4": "lean",
  "llvm-ir": "llvm",
  "llvmir": "llvm",
  "llvm": "llvm",
  "ll": "llvm",
  "asm": "assembly",
  "assembly": "assembly",
  "s": "assembly",
};

export interface lotusContainerGroupSummary {
  name: string;
  status: string;
  editable?: boolean;
  buildable?: boolean;
}

interface lotusContainerLanguageConfig {
  command?: string;
  extension?: string;
  useDefault?: boolean;
}

interface lotusCommandExpectation {
  command: string;
  positiveResponse?: string;
  negativeResponse?: string;
}

interface lotusQemuConfig {
  sshTarget: string;
  remoteWorkspace: string;
  sshExecutable?: string;
  sshArgs?: string;
  sshAuthSock?: string;
  scpExecutable?: string;
  scpArgs?: string;
  uploadMode?: lotusRemoteUploadMode;
  cleanupRemoteFile?: boolean;
  startCommand?: string;
  buildCommand?: string;
  teardownCommand?: string;
  healthCheck?: lotusCommandExpectation;
  manager?: lotusQemuManagerConfig;
}

interface lotusRemoteConfig {
  target: string;
  workspace: string;
  sshExecutable?: string;
  sshArgs?: string;
  sshAuthSock?: string;
  scpExecutable?: string;
  scpArgs?: string;
  uploadMode?: lotusRemoteUploadMode;
  cleanupRemoteFile?: boolean;
  mkdirCommand?: string;
  cleanupCommand?: string;
  healthCheck?: lotusCommandExpectation;
}

type lotusRemoteUploadMode = "inline" | "scp";

interface lotusQemuManagerConfig {
  enabled: boolean;
  executable?: string;
  args?: string;
  image?: string;
  imageFormat?: string;
  pidFile?: string;
  logFile?: string;
  readinessTimeoutMs?: number;
  readinessIntervalMs?: number;
  bootDelayMs?: number;
  shutdownCommand?: string;
  shutdownTimeoutMs?: number;
  killSignal?: NodeJS.Signals;
  persist?: boolean;
}

interface lotusCustomRuntimeConfig {
  executable: string;
  args?: string;
  build?: string;
  commandStructure?: string;
  teardown?: string;
  healthCheck?: lotusCommandExpectation;
}

type lotusHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
type lotusHttpResponseMode = "auto" | "json" | "text";

interface lotusHttpStatusRange {
  min: number;
  max: number;
}

interface lotusHttpConfig {
  url: string;
  method: lotusHttpMethod;
  contentType?: string;
  headers: Record<string, string>;
  body?: unknown;
  responseMode: lotusHttpResponseMode;
  successStatuses: lotusHttpStatusRange[];
  stdoutPath?: string;
  stderrPath?: string;
  exitCodePath?: string;
  successPath?: string;
}

interface lotusWslConfig {
  interactive?: boolean;
}

interface lotusOciPersistentConfig {
  enabled: boolean;
  name?: string;
  keepAliveCommand?: string;
}

interface lotusContainerElevationConfig {
  mode: lotusContainerElevationMode;
  commandPrefix?: string;
}

interface lotusContainerConfig {
  runtime: lotusContainerRuntime;
  executable?: string;
  image?: string;
  persistent?: lotusOciPersistentConfig;
  elevation: lotusContainerElevationConfig;
  wsl?: lotusWslConfig;
  healthCheck?: lotusCommandExpectation;
  outputFilters?: lotusOutputFilterConfig;
  ssh?: lotusRemoteConfig;
  qemu?: lotusQemuConfig;
  custom?: lotusCustomRuntimeConfig;
  http?: lotusHttpConfig;
  languages: Record<string, lotusContainerLanguageConfig>;
}

interface lotusOutputFilterConfig {
  stripAnsi?: boolean;
  stdoutStart?: RegExp;
  stdoutEnd?: RegExp;
  stderrStart?: RegExp;
  stderrEnd?: RegExp;
  stripStdout?: RegExp[];
  stripStderr?: RegExp[];
}

interface lotusCustomRuntimeRequest {
  action: "build" | "run" | "teardown";
  groupName: string;
  groupPath: string;
  runtime: lotusContainerRuntime;
  image?: string;
  build?: string;
  commandStructure?: string;
  teardown?: string;
  language?: string;
  languageAlias?: string;
  fileName?: string;
  filePath?: string;
  command?: string;
  stdin?: string;
  timeoutMs: lotusTimeoutMs;
  config: {
    executable?: string;
    custom?: lotusCustomRuntimeConfig;
    ssh?: lotusRemoteConfig;
    qemu?: lotusQemuConfig;
    http?: lotusHttpConfig;
    healthCheck?: lotusCommandExpectation;
    elevation?: lotusContainerElevationConfig;
    outputFilters?: {
      stripAnsi?: boolean;
      stdoutStart?: string;
      stdoutEnd?: string;
      stderrStart?: string;
      stderrEnd?: string;
      stripStdout?: string[];
      stripStderr?: string[];
    };
  };
}

export interface lotusHttpRequest {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | ArrayBuffer;
  contentType?: string;
  throw?: boolean;
}

export interface lotusHttpResponse {
  status: number;
  text: string;
}

export type lotusRequestUrl = (request: lotusHttpRequest | string) => Promise<lotusHttpResponse>;

export interface lotusContainerHost {
  containersPath: string;
}

interface lotusGodboltClientState {
  sessions: lotusGodboltSessionState[];
}

interface lotusGodboltSessionState {
  id: number;
  language: string;
  source: string;
  compilers?: lotusGodboltCompilerState[];
}

interface lotusGodboltCompilerState {
  id: string;
  options?: string;
  filters?: lotusGodboltCompilerFilters;
}

interface lotusGodboltCompilerFilters {
  binary: boolean;
  binaryObject: boolean;
  commentOnly: boolean;
  demangle: boolean;
  directives: boolean;
  execute: boolean;
  intel: boolean;
  labels: boolean;
  libraryCode: boolean;
  trim: boolean;
}

interface lotusCompilerExplorerCompiler {
  id: string;
  name: string;
  lang: string;
  semver: string;
  compilerType: string;
  instructionSet: string;
}

export class lotusContainerRunner {
  private readonly builtImages = new Set<string>();
  private readonly godboltDefaultCompilerCache = new Map<string, string | null>();

  constructor(
    private readonly host: lotusContainerHost,
    private readonly requestUrlFn?: lotusRequestUrl,
  ) { }

  async getGroupSummaries(): Promise<lotusContainerGroupSummary[]> {
    const builtInGroups = this.getBuiltInGroupSummaries();
    const containersPath = this.getContainersPath();
    if (!existsSync(containersPath)) {
      return builtInGroups;
    }

    const entries = await readdir(containersPath, { withFileTypes: true });
    const diskGroups = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory() && entry.name !== BUILT_IN_GODBOLT_GROUP && isCompileContainerGroupAllowed(entry.name))
        .map(async (entry) => {
          const groupPath = join(containersPath, entry.name);
          const hasConfig = existsSync(join(groupPath, "config.json"));
          const hasDockerfile = existsSync(join(groupPath, "Dockerfile"));
          if (!hasConfig) {
            return {
              name: entry.name,
              status: "missing config.json",
            };
          }
          try {
            const config = await this.readConfig(groupPath);
            const pieces = [`runtime: ${config.runtime}`];
            if ((config.runtime === "docker" || config.runtime === "podman") && hasDockerfile) {
              pieces.push("Dockerfile");
            }
            if ((config.runtime === "docker" || config.runtime === "podman") && config.persistent?.enabled) {
              pieces.push(`persistent: ${this.persistentOciContainerName(entry.name, config)}`);
            }
            if (config.runtime === "ssh" && config.ssh?.target) {
              pieces.push(`ssh: ${config.ssh.target}`);
            }
            if (config.runtime === "qemu" && config.qemu?.sshTarget) {
              pieces.push(`ssh: ${config.qemu.sshTarget}`);
            }
            if (config.runtime === "qemu" && config.qemu?.manager?.enabled) {
              pieces.push(`manager: ${await this.getManagedQemuStatus(groupPath, config.qemu.manager)}`);
            }
            if (config.runtime === "custom" && config.custom?.executable) {
              pieces.push(`wrapper: ${config.custom.executable}`);
            }
            if (config.runtime === "http" && config.http?.url) {
              pieces.push(`${config.http.method} ${config.http.url}`);
            }
            if (config.elevation.mode === "root") {
              pieces.push(config.elevation.commandPrefix ? `elevation: root via ${config.elevation.commandPrefix}` : "elevation: root");
            }
            const languageCount = Object.keys(config.languages).length;
            pieces.push(`${languageCount} language${languageCount === 1 ? "" : "s"}`);
            return {
              name: entry.name,
              status: pieces.join(", "),
            };
          } catch (error) {
            return {
              name: entry.name,
              status: `invalid config.json: ${error instanceof Error ? error.message : String(error)}`,
            };
          }
        }),
    );
    return [...builtInGroups, ...diskGroups];
  }

  async run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings, groupName: string): Promise<lotusRunResult> {
    if (block.codePackage) {
      throw new Error(`code package ${JSON.stringify(block.codePackage.name)} requires native execution; set lotus-execution=native on its blocks.`);
    }
    if (!isCompileContainerGroupAllowed(groupName)) {
      throw new Error(`Container group ${groupName} is not included in this Lotus build.`);
    }
    if (isBuiltInGodboltGroup(groupName)) {
      return this.runGodbolt(block, context, settings);
    }
    const groupPath = this.resolveGroupPath(groupName);
    const config = await this.readConfig(groupPath);
    const configLang = config.languages[block.language] ?? config.languages[block.languageAlias];

    let isFallback = false;
    let language: lotusContainerLanguageConfig | null = null;

    if (configLang) {
      if (configLang.useDefault) {
        language = this.getDefaultLanguageConfig(block.language, settings) ?? this.getDefaultLanguageConfig(block.languageAlias, settings);
      } else {
        language = configLang;
      }
    } else {
      language = this.getDefaultLanguageConfig(block.language, settings) ?? this.getDefaultLanguageConfig(block.languageAlias, settings);
      isFallback = true;
    }

    if (!language && config.runtime === "http") {
      language = {
        extension: `.${block.language || block.languageAlias || "txt"}`,
      };
      isFallback = true;
    }

    if (!language || (config.runtime !== "http" && !language.command) || !language.extension) {
      throw new Error(`Container group ${groupName} has no command for ${block.language}.`);
    }

    await mkdir(groupPath, { recursive: true });
    if (config.runtime !== "http") {
      await this.runHealthCheck(config.healthCheck, groupPath, context.timeoutMs, context.signal, `container:${groupName}:health`, `Container ${groupName} health check`);
    }
    const tempFileName = `temp_${Date.now()}_${Math.random().toString(16).slice(2)}${normalizeExtension(language.extension)}`;
    const tempFilePath = join(groupPath, tempFileName);

    try {
      await writeFile(tempFilePath, block.content, "utf8");
      let result: lotusRunResult;
      switch (config.runtime) {
        case "docker":
        case "podman":
          result = await this.runOciContainer(groupName, groupPath, config, language, tempFileName, context, settings);
          break;
        case "qemu":
          result = await this.runQemu(groupName, groupPath, config, language, tempFileName, tempFilePath, context);
          break;
        case "custom":
          result = await this.runCustom(groupName, groupPath, config, block, language, tempFileName, tempFilePath, context);
          break;
        case "wsl":
          result = await this.runWslContainer(groupName, groupPath, config, language, tempFileName, context);
          break;
        case "ssh":
          result = await this.runSshRemote(groupName, groupPath, config, language, tempFileName, tempFilePath, context);
          break;
        case "http":
          result = await this.runHttpGroup(groupName, config, block, language, tempFileName, context);
          break;
        default:
          throw new Error(`Unsupported runtime: ${config.runtime}`);
      }

      this.applyOutputFilters(result, config.outputFilters);

      if (isFallback) {
        const fallbackMsg = config.runtime === "http"
          ? `[Lotus] Language '${block.language}' was not declared in HTTP execution group. Submitting with fallback language metadata.`
          : `[Lotus] Language '${block.language}' was not declared in container group. Running using default command: ${language.command}`;
        result.warning = result.warning ? `${result.warning}\n${fallbackMsg}` : fallbackMsg;
      }
      if (config.elevation.mode === "root") {
        const elevationMsg = `[Lotus] Container elevation: root${config.elevation.commandPrefix ? ` via ${config.elevation.commandPrefix}` : ""}.`;
        result.warning = result.warning ? `${result.warning}\n${elevationMsg}` : elevationMsg;
      }
      return result;
    } finally {
      await rm(tempFilePath, { force: true });
    }
  }

  async buildGroup(groupName: string, timeoutMs: number, signal: AbortSignal): Promise<lotusRunResult> {
    if (!isCompileContainerGroupAllowed(groupName)) {
      throw new Error(`Container group ${groupName} is not included in this Lotus build.`);
    }
    if (isBuiltInGodboltGroup(groupName)) {
      return this.createSyntheticResult(
        `container:${groupName}:build`,
        "Godbolt build",
        "Built-in Godbolt execution group does not require a build step.\n",
      );
    }
    const groupPath = this.resolveGroupPath(groupName);
    const config = await this.readConfig(groupPath);
    await mkdir(groupPath, { recursive: true });
    if (config.runtime !== "http") {
      await this.runHealthCheck(config.healthCheck, groupPath, timeoutMs, signal, `container:${groupName}:health`, `Container ${groupName} health check`);
    }
    switch (config.runtime) {
      case "docker":
      case "podman":
        return this.buildImage(groupName, groupPath, config, timeoutMs, signal);
      case "qemu":
        return this.buildQemu(groupName, groupPath, config, timeoutMs, signal);
      case "ssh":
        return this.createSyntheticResult(
          `container:${groupName}:ssh:build`,
          `SSH ${groupName} build`,
          `SSH remote ${config.ssh?.target ?? "(unconfigured)"} does not require a build step.\n`,
        );
      case "custom":
        return this.runCustomWrapper(groupName, groupPath, config, this.createCustomRequest("build", groupName, groupPath, config, timeoutMs), timeoutMs, signal);
      case "wsl":
        return this.createSyntheticResult(
          `container:${groupName}:wsl:build`,
          `WSL ${groupName} build`,
          `WSL environment ${config.image || "(default)"} does not require a build step.\n`,
        );
      case "http":
        return this.createSyntheticResult(
          `container:${groupName}:http:build`,
          `HTTP ${groupName} build`,
          `HTTP execution group ${groupName} does not require a build step.\n`,
        );
    }
  }

  private getBuiltInGroupSummaries(): lotusContainerGroupSummary[] {
    if (!isCompileContainerGroupAllowed(BUILT_IN_GODBOLT_GROUP)) {
      return [];
    }
    return [{
      name: BUILT_IN_GODBOLT_GROUP,
      status: "runtime: built-in, posts snippets to Compiler Explorer and returns a Godbolt shortlink",
      editable: false,
      buildable: false,
    }];
  }

  private async runGodbolt(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult> {
    const startedAt = new Date();
    const language = readGodboltLanguage(block);
    const baseUrl = readGodboltBaseUrl(block);
    const clientState = await createGodboltClientState(block, language, settings, baseUrl, context.timeoutMs, context.signal, this.requestUrlFn, this.godboltDefaultCompilerCache);
    const url = await postGodboltShortlink(clientState, baseUrl, context.timeoutMs, context.signal, this.requestUrlFn);
    const finishedAt = new Date();

    return {
      runnerId: `container:${BUILT_IN_GODBOLT_GROUP}`,
      runnerName: "Godbolt",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode: 0,
      stdout: `${url}\n`,
      stderr: "",
      success: true,
      timedOut: false,
      cancelled: false,
      warning: GODBOLT_PRIVACY_WARNING,
      displays: [{
        id: "godbolt-link",
        title: "Godbolt link",
        role: "artifact",
        data: {
          "text/html": renderGodboltLinkHtml(url, language),
          "text/plain": url,
        },
        metadata: {
          "text/html": {
            height: 92,
          },
        },
      }],
    };
  }

  private async runOciContainer(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    language: lotusContainerLanguageConfig,
    tempFileName: string,
    context: lotusRunContext,
    settings: lotusPluginSettings,
  ): Promise<lotusRunResult> {
    const image = await this.resolveImage(groupName, groupPath, config, context, settings);
    const workspacePath = "/workspace";
    const containerFile = posixPath.join(workspacePath, tempFileName);
    const workingDirectory = normalizeFsPath(context.workingDirectory || groupPath);
    const useContextWorkingDirectory = workingDirectory !== normalizeFsPath(groupPath);
    const command = splitCommandLine(normalizeOciLanguageCommand(language.command!).replaceAll("{file}", containerFile));
    if (!command.length) {
      throw new Error("Container command is empty.");
    }

    if (config.persistent?.enabled) {
      const workingDirectoryNotice = useContextWorkingDirectory
        ? "[Lotus] Persistent Docker/Podman containers run in /workspace; lotus-cwd is not mounted for exec runs."
        : undefined;
      return this.runPersistentOciContainer(groupName, groupPath, config, image, workspacePath, command, context, workingDirectoryNotice);
    }

    return await runProcess({
      runnerId: `container:${groupName}`,
      runnerName: `${runtimeLabel(config.runtime)} ${groupName}`,
      executable: this.runtimeExecutable(config),
      args: [
        "run",
        "--rm",
        ...(context.stdin != null || context.stdinSession ? ["-i"] : []),
        "-v",
        `${groupPath}:${workspacePath}`,
        ...(useContextWorkingDirectory
          ? ["-v", `${workingDirectory}:/lotus-cwd`, "-w", "/lotus-cwd"]
          : ["-w", workspacePath]),
        ...this.ociElevationArgs(config),
        image,
        ...command,
      ],
      workingDirectory: groupPath,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      stdin: context.stdin,
      stdinSession: context.stdinSession,
      onStdout: context.onStdout,
      onStderr: context.onStderr,
    });
  }

  private async runPersistentOciContainer(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    image: string,
    workspacePath: string,
    command: string[],
    context: lotusRunContext,
    workingDirectoryNotice: string | undefined,
  ): Promise<lotusRunResult> {
    const runtime = this.runtimeExecutable(config);
    const containerName = this.persistentOciContainerName(groupName, config);
    const lifecycleNotice = await this.ensurePersistentOciContainer(groupName, groupPath, config, image, workspacePath, context);
    const result = await runProcess({
      runnerId: `container:${groupName}:exec`,
      runnerName: `${runtimeLabel(config.runtime)} ${groupName}`,
      executable: runtime,
      args: [
        "exec",
        ...(context.stdin != null || context.stdinSession ? ["-i"] : []),
        "-w",
        workspacePath,
        ...this.ociElevationArgs(config),
        containerName,
        ...command,
      ],
      workingDirectory: groupPath,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      stdin: context.stdin,
      stdinSession: context.stdinSession,
      onStdout: context.onStdout,
      onStderr: context.onStderr,
    });

    const notices = [lifecycleNotice, workingDirectoryNotice].filter((notice): notice is string => Boolean(notice));
    if (notices.length) {
      const notice = notices.join("\n");
      result.warning = result.warning ? `${notice}\n${result.warning}` : notice;
    }
    return result;
  }

  private async ensurePersistentOciContainer(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    image: string,
    workspacePath: string,
    context: lotusRunContext,
  ): Promise<string | undefined> {
    const runtime = this.runtimeExecutable(config);
    const containerName = this.persistentOciContainerName(groupName, config);
    const inspect = await runProcess({
      runnerId: `container:${groupName}:inspect`,
      runnerName: `${runtimeLabel(config.runtime)} ${groupName} inspect`,
      executable: runtime,
      args: ["inspect", "--format", "{{.State.Running}}", containerName],
      workingDirectory: groupPath,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
    });

    if (inspect.success) {
      if (inspect.stdout.trim() === "true") {
        return undefined;
      }
      const start = await runProcess({
        runnerId: `container:${groupName}:start`,
        runnerName: `${runtimeLabel(config.runtime)} ${groupName} start`,
        executable: runtime,
        args: ["start", containerName],
        workingDirectory: groupPath,
        timeoutMs: context.timeoutMs,
        signal: context.signal,
      });
      if (!start.success) {
        throw new Error(start.stderr || start.stdout || `Failed to start persistent ${runtimeLabel(config.runtime)} container ${containerName}.`);
      }
      return `[Lotus] Started persistent ${runtimeLabel(config.runtime)} container ${containerName}.`;
    }

    const keepAliveCommand = config.persistent?.keepAliveCommand?.trim() || "sleep infinity";
    const create = await runProcess({
      runnerId: `container:${groupName}:create`,
      runnerName: `${runtimeLabel(config.runtime)} ${groupName} create`,
      executable: runtime,
      args: [
        "create",
        "--name",
        containerName,
        "-v",
        `${groupPath}:${workspacePath}`,
        "-w",
        workspacePath,
        ...this.ociElevationArgs(config),
        image,
        "sh",
        "-lc",
        keepAliveCommand,
      ],
      workingDirectory: groupPath,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
    });
    if (!create.success) {
      throw new Error(create.stderr || create.stdout || `Failed to create persistent ${runtimeLabel(config.runtime)} container ${containerName}.`);
    }

    const start = await runProcess({
      runnerId: `container:${groupName}:start`,
      runnerName: `${runtimeLabel(config.runtime)} ${groupName} start`,
      executable: runtime,
      args: ["start", containerName],
      workingDirectory: groupPath,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
    });
    if (!start.success) {
      throw new Error(start.stderr || start.stdout || `Failed to start persistent ${runtimeLabel(config.runtime)} container ${containerName}.`);
    }

    return `[Lotus] Created and started persistent ${runtimeLabel(config.runtime)} container ${containerName}.`;
  }

  private async runQemu(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    language: lotusContainerLanguageConfig,
    tempFileName: string,
    tempFilePath: string,
    context: lotusRunContext,
  ): Promise<lotusRunResult> {
    const qemu = this.requireQemuConfig(config);
    await this.runOptionalCommand(qemu.startCommand, groupPath, context.timeoutMs, context.signal, `container:${groupName}:qemu:start`, `QEMU ${groupName} start`);
    await this.ensureManagedQemu(groupName, groupPath, qemu, context.timeoutMs, context.signal);
    await this.runHealthCheck(qemu.healthCheck, groupPath, context.timeoutMs, context.signal, `container:${groupName}:qemu:health`, `QEMU ${groupName} health check`);

    try {
      return await this.runRemoteLanguage(
        groupName,
        groupPath,
        "qemu",
        `QEMU ${groupName}`,
        config,
        this.remoteConfigFromQemu(qemu),
        language,
        tempFileName,
        tempFilePath,
        context,
      );
    } finally {
      await this.runOptionalCommand(qemu.teardownCommand, groupPath, context.timeoutMs, context.signal, `container:${groupName}:qemu:teardown`, `QEMU ${groupName} teardown`);
      await this.stopManagedQemuIfNeeded(groupName, groupPath, qemu, context.timeoutMs, context.signal);
    }
  }

  private async runSshRemote(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    language: lotusContainerLanguageConfig,
    tempFileName: string,
    tempFilePath: string,
    context: lotusRunContext,
  ): Promise<lotusRunResult> {
    return this.runRemoteLanguage(
      groupName,
      groupPath,
      "ssh",
      `SSH ${groupName}`,
      config,
      this.requireSshConfig(config),
      language,
      tempFileName,
      tempFilePath,
      context,
    );
  }

  private async runRemoteLanguage(
    groupName: string,
    groupPath: string,
    runtimeId: "ssh" | "qemu",
    runnerName: string,
    config: lotusContainerConfig,
    remote: lotusRemoteConfig,
    language: lotusContainerLanguageConfig,
    tempFileName: string,
    tempFilePath: string,
    context: lotusRunContext,
  ): Promise<lotusRunResult> {
    const remoteFile = posixPath.join(remote.workspace, tempFileName);
    const remoteCommand = this.applyCommandPrefix(config, normalizeShellLanguageCommand(language.command!).replaceAll("{file}", shellQuote(remoteFile)));
    if (!remoteCommand.trim()) {
      throw new Error(`${runnerName} command is empty.`);
    }

    if (remote.uploadMode !== "scp") {
      return this.runRemoteLanguageInline(groupName, groupPath, runtimeId, runnerName, remote, remoteCommand, tempFilePath, remoteFile, context);
    }

    await this.ensureRemoteWorkspace(groupName, groupPath, runtimeId, runnerName, remote, context.timeoutMs, context.signal);
    await this.runRemoteHealthCheck(groupName, groupPath, runtimeId, runnerName, remote, context.timeoutMs, context.signal);
    await this.uploadRemoteFile(groupName, groupPath, runtimeId, runnerName, remote, tempFilePath, remoteFile, context.timeoutMs, context.signal);

    let result: lotusRunResult | undefined;
    try {
      result = await this.runRemoteCommand(
        groupName,
        groupPath,
        runtimeId,
        runnerName,
        remote,
        `cd ${shellQuote(remote.workspace)} && ${remoteCommand}`,
        context.timeoutMs,
        context.signal,
        undefined,
        context.stdin,
        context.stdinSession,
        context.onStdout,
        context.onStderr,
        "run",
      );
      return result;
    } finally {
      if (remote.cleanupRemoteFile !== false) {
        const cleanup = await this.cleanupRemoteFile(groupName, groupPath, runtimeId, runnerName, remote, remoteFile, context.timeoutMs, context.signal);
        if (result && !cleanup.success) {
          const warning = `Remote cleanup failed: ${cleanup.stderr || cleanup.stdout || `exit ${cleanup.exitCode}`}`;
          result.warning = result.warning ? `${result.warning}\n${warning}` : warning;
        }
      }
    }
  }

  private async runRemoteLanguageInline(
    groupName: string,
    groupPath: string,
    runtimeId: "ssh" | "qemu",
    runnerName: string,
    remote: lotusRemoteConfig,
    remoteCommand: string,
    tempFilePath: string,
    remoteFile: string,
    context: lotusRunContext,
  ): Promise<lotusRunResult> {
    const source = await readFile(tempFilePath, "utf8");
    const command = this.buildInlineRemoteCommand(remote, remoteCommand, remoteFile, Buffer.byteLength(source, "utf8"));
    return this.runRemoteCommand(
      groupName,
      groupPath,
      runtimeId,
      runnerName,
      remote,
      command,
      context.timeoutMs,
      context.signal,
      source,
      context.stdin,
      context.stdinSession,
      context.onStdout,
      context.onStderr,
      "run",
    );
  }

  private buildInlineRemoteCommand(remote: lotusRemoteConfig, remoteCommand: string, remoteFile: string, sourceByteLength: number): string {
    const mkdirCommand = (remote.mkdirCommand || "mkdir -p {workspace}").replaceAll("{workspace}", shellQuote(remote.workspace));
    const cleanupCommand = (remote.cleanupCommand || "rm -f {file}").replaceAll("{file}", shellQuote(remoteFile));
    const lines = [
      "set +e",
      mkdirCommand,
      "__lotus_status=$?",
      "if [ \"$__lotus_status\" -ne 0 ]; then exit \"$__lotus_status\"; fi",
      ...this.buildInlineRemoteHealthCheck(remote.healthCheck),
      `dd of=${shellQuote(remoteFile)} bs=1 count=${sourceByteLength} 2>/dev/null`,
      "__lotus_status=$?",
      "if [ \"$__lotus_status\" -ne 0 ]; then printf '%s\\n' 'Lotus remote upload failed.' >&2; exit \"$__lotus_status\"; fi",
      `cd ${shellQuote(remote.workspace)}`,
      "__lotus_status=$?",
      "if [ \"$__lotus_status\" -ne 0 ]; then exit \"$__lotus_status\"; fi",
      remoteCommand,
      "__lotus_run_status=$?",
    ];

    if (remote.cleanupRemoteFile !== false) {
      lines.push(
        cleanupCommand,
        "__lotus_cleanup_status=$?",
        "if [ \"$__lotus_cleanup_status\" -ne 0 ]; then printf '%s\\n' 'Lotus remote cleanup failed.' >&2; fi",
      );
    }

    lines.push("exit \"$__lotus_run_status\"");
    return lines.join("\n");
  }

  private buildInlineRemoteHealthCheck(healthCheck: lotusCommandExpectation | undefined): string[] {
    if (!healthCheck) {
      return [];
    }

    const lines = [
      `__lotus_health_output="$({ ${healthCheck.command}; } 2>&1)"`,
      "__lotus_health_status=$?",
      "if [ \"$__lotus_health_status\" -ne 0 ]; then printf '%s\\n' 'Lotus remote health check failed.' >&2; printf '%s\\n' \"$__lotus_health_output\" >&2; exit \"$__lotus_health_status\"; fi",
    ];

    if (healthCheck.negativeResponse) {
      lines.push(
        `if printf '%s' "$__lotus_health_output" | grep -F -- ${shellQuote(healthCheck.negativeResponse)} >/dev/null; then printf '%s\\n' ${shellQuote(`Lotus remote health check returned negative response: ${healthCheck.negativeResponse}`)} >&2; exit 1; fi`,
      );
    }
    if (healthCheck.positiveResponse) {
      lines.push(
        `if ! printf '%s' "$__lotus_health_output" | grep -F -- ${shellQuote(healthCheck.positiveResponse)} >/dev/null; then printf '%s\\n' ${shellQuote(`Lotus remote health check did not return positive response: ${healthCheck.positiveResponse}`)} >&2; exit 1; fi`,
      );
    }

    return lines;
  }

  private async runCustom(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    block: lotusCodeBlock,
    language: lotusContainerLanguageConfig,
    tempFileName: string,
    tempFilePath: string,
    context: lotusRunContext,
  ): Promise<lotusRunResult> {
    const command = this.applyCommandPrefix(config, normalizeShellLanguageCommand(language.command!).replaceAll("{file}", tempFileName));
    const result = await this.runCustomWrapper(
      groupName,
      groupPath,
      config,
      this.createCustomRequest("run", groupName, groupPath, config, context.timeoutMs, {
        language: block.language,
        languageAlias: block.languageAlias,
        fileName: tempFileName,
        filePath: tempFilePath,
        command,
        stdin: context.stdin,
      }),
      context.timeoutMs,
      context.signal,
    );

    if (config.custom?.teardown) {
      const teardown = await this.runCustomWrapper(
        groupName,
        groupPath,
        config,
        this.createCustomRequest("teardown", groupName, groupPath, config, context.timeoutMs, {
          language: block.language,
          languageAlias: block.languageAlias,
          fileName: tempFileName,
          filePath: tempFilePath,
          command,
          stdin: context.stdin,
        }),
        context.timeoutMs,
        context.signal,
      );
      if (!teardown.success) {
        result.warning = `Custom runtime teardown failed: ${teardown.stderr || teardown.stdout || `exit ${teardown.exitCode}`}`;
      }
    }

    return result;
  }

  private async runHttpGroup(
    groupName: string,
    config: lotusContainerConfig,
    block: lotusCodeBlock,
    language: lotusContainerLanguageConfig,
    tempFileName: string,
    context: lotusRunContext,
  ): Promise<lotusRunResult> {
    if (!this.requestUrlFn) {
      throw new Error("HTTP execution groups require Obsidian requestUrl.");
    }

    const http = this.requireHttpConfig(config);
    const templateContext = createHttpTemplateContext(groupName, block, language, tempFileName, context);
    const url = renderHttpTemplateString(http.url, templateContext);
    assertHttpUrl(url, `HTTP execution group ${groupName} url`);
    const headers = renderHttpHeaders(http.headers, templateContext);
    const body = createHttpRequestBody(http, templateContext, headers);
    const startedAt = new Date();
    const request = this.requestUrlFn({
      url,
      method: http.method,
      headers,
      ...(body.body != null ? { body: body.body } : {}),
      ...(body.contentType ? { contentType: body.contentType } : {}),
      throw: false,
    });
    request.catch(() => undefined);
    const response = await waitForHttpResponse(request, context.timeoutMs, context.signal, `HTTP execution group ${groupName}`);
    const finishedAt = new Date();
    const decoded = decodeHttpRunResponse(http, response);

    return {
      runnerId: `container:${groupName}:http`,
      runnerName: `HTTP ${groupName}`,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode: decoded.exitCode,
      stdout: decoded.stdout,
      stderr: decoded.stderr,
      success: decoded.success,
      timedOut: false,
      cancelled: false,
      ...(decoded.warning ? { warning: decoded.warning } : {}),
    };
  }

  private async runWslContainer(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    language: lotusContainerLanguageConfig,
    tempFileName: string,
    context: lotusRunContext,
  ): Promise<lotusRunResult> {
    const wslGroupPath = this.translateToWslPath(groupPath);
    const command = this.applyCommandPrefix(config, normalizeShellLanguageCommand(language.command!).replaceAll("{file}", tempFileName));
    if (!command.trim()) {
      throw new Error("WSL command is empty.");
    }

    const shellFlags = config.wsl?.interactive ? ["-i", "-l", "-c"] : ["-l", "-c"];
    const wslArgs = ["bash", ...shellFlags, `cd "${wslGroupPath.replaceAll('"', '\\"')}" && ${command}`];
    if (config.image?.trim()) {
      wslArgs.unshift("-d", config.image.trim());
    }

    return await runProcess({
      runnerId: `container:${groupName}:wsl`,
      runnerName: `WSL ${groupName}`,
      executable: "wsl",
      args: wslArgs,
      workingDirectory: groupPath,
      timeoutMs: context.timeoutMs,
      signal: context.signal,
      stdin: context.stdin,
      stdinSession: context.stdinSession,
      onStdout: context.onStdout,
      onStderr: context.onStderr,
    });
  }

  private remoteConfigFromQemu(qemu: lotusQemuConfig): lotusRemoteConfig {
    return {
      target: qemu.sshTarget,
      workspace: qemu.remoteWorkspace,
      sshExecutable: qemu.sshExecutable,
      sshArgs: qemu.sshArgs,
      sshAuthSock: qemu.sshAuthSock,
      scpExecutable: qemu.scpExecutable,
      scpArgs: qemu.scpArgs,
      uploadMode: qemu.uploadMode,
      cleanupRemoteFile: qemu.cleanupRemoteFile,
    };
  }

  private async ensureRemoteWorkspace(
    groupName: string,
    groupPath: string,
    runtimeId: "ssh" | "qemu",
    runnerName: string,
    remote: lotusRemoteConfig,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
  ): Promise<void> {
    const command = (remote.mkdirCommand || "mkdir -p {workspace}").replaceAll("{workspace}", shellQuote(remote.workspace));
    const result = await this.runRemoteCommand(groupName, groupPath, runtimeId, `${runnerName} mkdir`, remote, command, timeoutMs, signal, undefined, undefined, undefined, undefined, undefined, "mkdir");
    if (!result.success) {
      throw new Error(`${runnerName} workspace setup failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
  }

  private async runRemoteHealthCheck(
    groupName: string,
    groupPath: string,
    runtimeId: "ssh" | "qemu",
    runnerName: string,
    remote: lotusRemoteConfig,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
  ): Promise<void> {
    if (!remote.healthCheck) {
      return;
    }
    const result = await this.runRemoteCommand(groupName, groupPath, runtimeId, `${runnerName} remote health check`, remote, remote.healthCheck.command, timeoutMs, signal, undefined, undefined, undefined, undefined, undefined, "health");
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (!result.success) {
      throw new Error(`${runnerName} remote health check failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
    if (remote.healthCheck.negativeResponse && combinedOutput.includes(remote.healthCheck.negativeResponse)) {
      throw new Error(`${runnerName} remote health check returned negative response: ${remote.healthCheck.negativeResponse}`);
    }
    if (remote.healthCheck.positiveResponse && !combinedOutput.includes(remote.healthCheck.positiveResponse)) {
      throw new Error(`${runnerName} remote health check did not return positive response: ${remote.healthCheck.positiveResponse}`);
    }
  }

  private async uploadRemoteFile(
    groupName: string,
    groupPath: string,
    runtimeId: "ssh" | "qemu",
    runnerName: string,
    remote: lotusRemoteConfig,
    localFile: string,
    remoteFile: string,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
  ): Promise<void> {
    const result = await runProcess({
      runnerId: `container:${groupName}:${runtimeId}:upload`,
      runnerName: `${runnerName} upload`,
      executable: remote.scpExecutable || "scp",
      args: [
        ...splitCommandLine(remote.scpArgs || ""),
        localFile,
        `${remote.target}:${remoteFile}`,
      ],
      workingDirectory: groupPath,
      timeoutMs,
      signal,
      env: this.remoteProcessEnv(remote),
    });
    if (!result.success) {
      throw new Error(`${runnerName} upload failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
  }

  private async cleanupRemoteFile(
    groupName: string,
    groupPath: string,
    runtimeId: "ssh" | "qemu",
    runnerName: string,
    remote: lotusRemoteConfig,
    remoteFile: string,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
  ): Promise<lotusRunResult> {
    const command = (remote.cleanupCommand || "rm -f {file}").replaceAll("{file}", shellQuote(remoteFile));
    return this.runRemoteCommand(groupName, groupPath, runtimeId, `${runnerName} cleanup`, remote, command, timeoutMs, signal, undefined, undefined, undefined, undefined, undefined, "cleanup");
  }

  private async runRemoteCommand(
    groupName: string,
    groupPath: string,
    runtimeId: "ssh" | "qemu",
    runnerName: string,
    remote: lotusRemoteConfig,
    command: string,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
    stdinPrefix: string | Buffer | undefined,
    stdin: string | undefined,
    stdinSession: lotusRunContext["stdinSession"] | undefined,
    onStdout: lotusRunContext["onStdout"] | undefined,
    onStderr: lotusRunContext["onStderr"] | undefined,
    action: string,
  ): Promise<lotusRunResult> {
    return runProcess({
      runnerId: `container:${groupName}:${runtimeId}:${action}`,
      runnerName,
      executable: remote.sshExecutable || "ssh",
      args: [
        ...splitCommandLine(remote.sshArgs || ""),
        remote.target,
        command,
      ],
      workingDirectory: groupPath,
      timeoutMs,
      signal,
      stdinPrefix,
      stdin,
      stdinSession,
      onStdout,
      onStderr,
      env: this.remoteProcessEnv(remote),
    });
  }

  private remoteProcessEnv(remote: lotusRemoteConfig): NodeJS.ProcessEnv | undefined {
    return remote.sshAuthSock ? { SSH_AUTH_SOCK: remote.sshAuthSock } : undefined;
  }

  private translateToWslPath(windowsPath: string): string {
    const match = windowsPath.match(/^([A-Za-z]):\\(.*)/);
    if (match) {
      const drive = match[1].toLowerCase();
      const rest = match[2].replace(/\\/g, "/");
      return `/mnt/${drive}/${rest}`;
    }
    if (windowsPath.includes("\\")) {
      return windowsPath.replace(/\\/g, "/");
    }
    return windowsPath;
  }

  private async resolveImage(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    context: lotusRunContext,
    settings: lotusPluginSettings,
  ): Promise<string> {
    const dockerfile = join(groupPath, "Dockerfile");
    if (!existsSync(dockerfile)) {
      return config.image || "ubuntu:latest";
    }

    const image = this.imageNameForGroup(groupName);
    const cacheKey = `${this.runtimeExecutable(config)}:${image}`;
    if (this.builtImages.has(cacheKey)) {
      return image;
    }

    const result = await this.buildImage(groupName, groupPath, config, Math.max(finiteTimeoutMs(context.timeoutMs, settings.defaultTimeoutMs), 120_000), context.signal);
    if (!result.success) {
      throw new Error(result.stderr || result.stdout || `${runtimeLabel(config.runtime)} build failed for ${groupName}.`);
    }

    this.builtImages.add(cacheKey);
    return image;
  }

  private async buildImage(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    timeoutMs: number,
    signal: AbortSignal,
  ): Promise<lotusRunResult> {
    const image = this.imageNameForGroup(groupName);
    if (!existsSync(join(groupPath, "Dockerfile"))) {
      return this.createSyntheticResult(
        `container:${groupName}:build`,
        `${runtimeLabel(config.runtime)} ${groupName} build`,
        `No Dockerfile configured. Using image ${config.image || "ubuntu:latest"}.\n`,
      );
    }
    return runProcess({
      runnerId: `container:${groupName}:build`,
      runnerName: `${runtimeLabel(config.runtime)} ${groupName} build`,
      executable: this.runtimeExecutable(config),
      args: ["build", "-t", image, groupPath],
      workingDirectory: groupPath,
      timeoutMs,
      signal,
    });
  }

  private async buildQemu(groupName: string, groupPath: string, config: lotusContainerConfig, timeoutMs: number, signal: AbortSignal): Promise<lotusRunResult> {
    const qemu = this.requireQemuConfig(config);
    if (!qemu.buildCommand?.trim()) {
      return this.createSyntheticResult(`container:${groupName}:qemu:build`, `QEMU ${groupName} build`, "No QEMU build command configured.\n");
    }
    return this.runCommandLine(qemu.buildCommand, groupPath, timeoutMs, signal, `container:${groupName}:qemu:build`, `QEMU ${groupName} build`);
  }

  private async readConfig(groupPath: string): Promise<lotusContainerConfig> {
    const configPath = join(groupPath, "config.json");
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(configPath, "utf8"));
    } catch (error) {
      throw new Error(`Unable to read container config ${configPath}: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error("Container config must be an object.");
    }

    const data = raw as {
      runtime?: unknown;
      executable?: unknown;
      image?: unknown;
      persistent?: unknown;
      wsl?: unknown;
      healthCheck?: unknown;
      outputFilters?: unknown;
      outputFilter?: unknown;
      ssh?: unknown;
      remote?: unknown;
      qemu?: unknown;
      custom?: unknown;
      http?: unknown;
      elevation?: unknown;
      languages?: unknown;
    };
    const runtime = this.readRuntime(data.runtime);
    if (data.executable != null && typeof data.executable !== "string") {
      throw new Error("Container config executable must be a string.");
    }
    if (data.image != null && typeof data.image !== "string") {
      throw new Error("Container config image must be a string.");
    }
    if (!data.languages || typeof data.languages !== "object" || Array.isArray(data.languages)) {
      throw new Error("Container config languages must be an object.");
    }

    const languages: Record<string, lotusContainerLanguageConfig> = {};
    for (const [language, value] of Object.entries(data.languages as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`Container language ${language} must be an object.`);
      }
      const languageConfig = value as { command?: unknown; extension?: unknown; useDefault?: unknown };
      const useDefault = languageConfig.useDefault === true;

      if (!useDefault && runtime !== "http" && (typeof languageConfig.command !== "string" || !languageConfig.command.trim())) {
        throw new Error(`Container language ${language} must define command or useDefault.`);
      }

      languages[language] = {
        command: typeof languageConfig.command === "string" ? languageConfig.command : undefined,
        extension: typeof languageConfig.extension === "string" ? languageConfig.extension : useDefault ? undefined : `.${language}`,
        useDefault: useDefault || undefined,
      };
    }

    return {
      runtime,
      executable: typeof data.executable === "string" && data.executable.trim() ? data.executable.trim() : undefined,
      image: typeof data.image === "string" ? data.image : undefined,
      persistent: this.readPersistentConfig(data.persistent),
      elevation: this.readElevationConfig(data.elevation),
      wsl: this.readWslConfig(data.wsl),
      healthCheck: this.readHealthCheck(data.healthCheck, "Container config healthCheck"),
      outputFilters: this.readOutputFilters(data.outputFilters ?? data.outputFilter),
      ssh: this.readSshConfig(data.ssh ?? data.remote, runtime),
      qemu: this.readQemuConfig(data.qemu),
      custom: this.readCustomConfig(data.custom),
      http: this.readHttpConfig(data.http, runtime),
      languages,
    };
  }

  private readRuntime(value: unknown): lotusContainerRuntime {
    let runtime: lotusContainerRuntime;
    if (value == null) {
      runtime = "docker";
    } else if (value === "remote") {
      runtime = "ssh";
    } else if (value === "docker" || value === "podman" || value === "qemu" || value === "custom" || value === "wsl" || value === "ssh" || value === "http") {
      runtime = value;
    } else {
      throw new Error("Container config runtime must be docker, podman, qemu, custom, wsl, ssh, http, or remote.");
    }

    if (!isCompileContainerRuntimeAllowed(runtime)) {
      throw new Error(`Container runtime ${runtime} is not included in this Lotus build.`);
    }
    return runtime;
  }

  private readPersistentConfig(value: unknown): lotusOciPersistentConfig | undefined {
    if (value == null || value === false) {
      return undefined;
    }
    if (value === true) {
      return { enabled: true };
    }
    if (!isRecord(value)) {
      throw new Error("Container config persistent must be a boolean or object.");
    }
    if (value.enabled != null && typeof value.enabled !== "boolean") {
      throw new Error("Container config persistent.enabled must be a boolean.");
    }
    if (value.name != null && typeof value.name !== "string") {
      throw new Error("Container config persistent.name must be a string.");
    }
    if (value.keepAliveCommand != null && typeof value.keepAliveCommand !== "string") {
      throw new Error("Container config persistent.keepAliveCommand must be a string.");
    }

    return {
      enabled: value.enabled === true,
      name: optionalString(value.name),
      keepAliveCommand: optionalString(value.keepAliveCommand),
    };
  }

  private readWslConfig(value: unknown): lotusWslConfig | undefined {
    if (value == null) {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Container config wsl must be an object.");
    }
    const data = value as { interactive?: unknown };
    return {
      interactive: data.interactive === true,
    };
  }

  private readElevationConfig(value: unknown): lotusContainerElevationConfig {
    if (value == null) {
      return { mode: "default" };
    }
    if (typeof value === "string") {
      if (value === "default" || value === "root") {
        return { mode: value };
      }
      throw new Error("Container config elevation must be default, root, or an object.");
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Container config elevation must be an object.");
    }
    const data = value as Record<string, unknown>;
    const mode = data.mode == null ? "default" : data.mode;
    if (mode !== "default" && mode !== "root") {
      throw new Error("Container config elevation.mode must be default or root.");
    }
    return {
      mode,
      commandPrefix: optionalString(data.commandPrefix),
    };
  }

  private readSshConfig(value: unknown, runtime: lotusContainerRuntime): lotusRemoteConfig | undefined {
    if (value == null) {
      if (runtime === "ssh") {
        throw new Error("SSH runtime requires an ssh config object.");
      }
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Container config ssh must be an object.");
    }
    const data = value as Record<string, unknown>;
    const target = optionalString(data.target ?? data.sshTarget);
    const workspace = optionalString(data.workspace ?? data.remoteWorkspace);
    if (!target) {
      throw new Error("Container config ssh.target must be a string.");
    }
    if (!workspace) {
      throw new Error("Container config ssh.workspace must be a string.");
    }
    return {
      target,
      workspace,
      sshExecutable: optionalString(data.sshExecutable),
      sshArgs: optionalString(data.sshArgs),
      sshAuthSock: optionalString(data.sshAuthSock ?? data.authSock ?? data.sshAgentSocket),
      scpExecutable: optionalString(data.scpExecutable),
      scpArgs: optionalString(data.scpArgs),
      uploadMode: optionalUploadMode(data.uploadMode),
      cleanupRemoteFile: typeof data.cleanupRemoteFile === "boolean" ? data.cleanupRemoteFile : undefined,
      mkdirCommand: optionalString(data.mkdirCommand),
      cleanupCommand: optionalString(data.cleanupCommand),
      healthCheck: this.readHealthCheck(data.healthCheck, "Container config ssh.healthCheck"),
    };
  }

  private readOutputFilters(value: unknown): lotusOutputFilterConfig | undefined {
    if (!isCompileFeatureAllowed("output-filters")) {
      return undefined;
    }
    if (value == null) {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Container config outputFilters must be an object.");
    }
    const data = value as Record<string, unknown>;
    return {
      stripAnsi: data.stripAnsi === true,
      stdoutStart: optionalRegex(data.stdoutStart, "Container config outputFilters.stdoutStart"),
      stdoutEnd: optionalRegex(data.stdoutEnd, "Container config outputFilters.stdoutEnd"),
      stderrStart: optionalRegex(data.stderrStart, "Container config outputFilters.stderrStart"),
      stderrEnd: optionalRegex(data.stderrEnd, "Container config outputFilters.stderrEnd"),
      stripStdout: optionalRegexList(data.stripStdout, "Container config outputFilters.stripStdout"),
      stripStderr: optionalRegexList(data.stripStderr, "Container config outputFilters.stripStderr"),
    };
  }

  private readQemuConfig(value: unknown): lotusQemuConfig | undefined {
    if (value == null) {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Container config qemu must be an object.");
    }
    const data = value as Record<string, unknown>;
    if (typeof data.sshTarget !== "string" || !data.sshTarget.trim()) {
      throw new Error("Container config qemu.sshTarget must be a string.");
    }
    if (typeof data.remoteWorkspace !== "string" || !data.remoteWorkspace.trim()) {
      throw new Error("Container config qemu.remoteWorkspace must be a string.");
    }

    return {
      sshTarget: data.sshTarget.trim(),
      remoteWorkspace: data.remoteWorkspace.trim(),
      sshExecutable: optionalString(data.sshExecutable),
      sshArgs: optionalString(data.sshArgs),
      sshAuthSock: optionalString(data.sshAuthSock ?? data.authSock ?? data.sshAgentSocket),
      scpExecutable: optionalString(data.scpExecutable),
      scpArgs: optionalString(data.scpArgs),
      uploadMode: optionalUploadMode(data.uploadMode),
      cleanupRemoteFile: typeof data.cleanupRemoteFile === "boolean" ? data.cleanupRemoteFile : undefined,
      startCommand: optionalString(data.startCommand),
      buildCommand: optionalString(data.buildCommand),
      teardownCommand: optionalString(data.teardownCommand),
      healthCheck: this.readHealthCheck(data.healthCheck, "Container config qemu.healthCheck"),
      manager: this.readQemuManagerConfig(data.manager),
    };
  }

  private readQemuManagerConfig(value: unknown): lotusQemuManagerConfig | undefined {
    if (value == null) {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Container config qemu.manager must be an object.");
    }
    const data = value as Record<string, unknown>;
    return {
      enabled: data.enabled !== false,
      executable: optionalString(data.executable),
      args: optionalString(data.args),
      image: optionalString(data.image),
      imageFormat: optionalString(data.imageFormat),
      pidFile: optionalString(data.pidFile),
      logFile: optionalString(data.logFile),
      readinessTimeoutMs: optionalPositiveInteger(data.readinessTimeoutMs, "Container config qemu.manager.readinessTimeoutMs"),
      readinessIntervalMs: optionalPositiveInteger(data.readinessIntervalMs, "Container config qemu.manager.readinessIntervalMs"),
      bootDelayMs: optionalNonNegativeInteger(data.bootDelayMs, "Container config qemu.manager.bootDelayMs"),
      shutdownCommand: optionalString(data.shutdownCommand),
      shutdownTimeoutMs: optionalPositiveInteger(data.shutdownTimeoutMs, "Container config qemu.manager.shutdownTimeoutMs"),
      killSignal: optionalSignal(data.killSignal, "Container config qemu.manager.killSignal"),
      persist: typeof data.persist === "boolean" ? data.persist : undefined,
    };
  }

  private readCustomConfig(value: unknown): lotusCustomRuntimeConfig | undefined {
    if (value == null) {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Container config custom must be an object.");
    }
    const data = value as Record<string, unknown>;
    if (typeof data.executable !== "string" || !data.executable.trim()) {
      throw new Error("Container config custom.executable must be a string.");
    }
    return {
      executable: data.executable.trim(),
      args: optionalString(data.args),
      build: optionalString(data.build),
      commandStructure: optionalString(data.commandStructure),
      teardown: optionalString(data.teardown),
      healthCheck: this.readHealthCheck(data.healthCheck, "Container config custom.healthCheck"),
    };
  }

  private readHttpConfig(value: unknown, runtime: lotusContainerRuntime): lotusHttpConfig | undefined {
    if (value == null) {
      if (runtime === "http") {
        throw new Error("HTTP runtime requires an http config object.");
      }
      return undefined;
    }
    if (!isRecord(value)) {
      throw new Error("Container config http must be an object.");
    }
    const url = optionalString(value.url ?? value.endpoint);
    if (!url) {
      throw new Error("Container config http.url must be a string.");
    }
    assertHttpUrl(url, "Container config http.url");
    return {
      url,
      method: readHttpMethod(value.method),
      contentType: optionalString(value.contentType ?? value.content_type),
      headers: readHttpHeadersConfig(value.headers),
      body: value.body,
      responseMode: readHttpResponseMode(value.responseMode ?? value.response_mode),
      successStatuses: readHttpSuccessStatuses(value.successStatus ?? value.successStatuses ?? value.okStatus),
      stdoutPath: optionalString(value.stdoutPath ?? value.stdout ?? value.outputPath ?? value.output),
      stderrPath: optionalString(value.stderrPath ?? value.stderr),
      exitCodePath: optionalString(value.exitCodePath ?? value.exitCode),
      successPath: optionalString(value.successPath ?? value.success),
    };
  }

  private readHealthCheck(value: unknown, label: string): lotusCommandExpectation | undefined {
    if (value == null) {
      return undefined;
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} must be an object.`);
    }
    const data = value as Record<string, unknown>;
    if (typeof data.command !== "string" || !data.command.trim()) {
      throw new Error(`${label}.command must be a string.`);
    }
    return {
      command: data.command.trim(),
      positiveResponse: optionalString(data.positiveResponse ?? data.positive_response ?? data["positive response"] ?? data.possitiveResponse),
      negativeResponse: optionalString(data.negativeResponse ?? data.negative_response ?? data["negative response"]),
    };
  }

  private requireQemuConfig(config: lotusContainerConfig): lotusQemuConfig {
    if (!config.qemu) {
      throw new Error("QEMU runtime requires a qemu config object.");
    }
    return config.qemu;
  }

  private requireSshConfig(config: lotusContainerConfig): lotusRemoteConfig {
    if (!config.ssh) {
      throw new Error("SSH runtime requires an ssh config object.");
    }
    return config.ssh;
  }

  private requireCustomConfig(config: lotusContainerConfig): lotusCustomRuntimeConfig {
    if (!config.custom) {
      throw new Error("Custom runtime requires a custom config object.");
    }
    return config.custom;
  }

  private requireHttpConfig(config: lotusContainerConfig): lotusHttpConfig {
    if (!config.http) {
      throw new Error("HTTP runtime requires an http config object.");
    }
    return config.http;
  }

  private runtimeExecutable(config: lotusContainerConfig): string {
    if (config.executable?.trim()) {
      return config.executable.trim();
    }
    return config.runtime === "podman" ? "podman" : "docker";
  }

  private ociElevationArgs(config: lotusContainerConfig): string[] {
    return config.elevation.mode === "root" ? ["--user", "root"] : [];
  }

  private applyCommandPrefix(config: lotusContainerConfig, command: string): string {
    const prefix = config.elevation.mode === "root" ? config.elevation.commandPrefix?.trim() : "";
    return prefix ? `${prefix} ${command}` : command;
  }

  private applyOutputFilters(result: lotusRunResult, filters: lotusOutputFilterConfig | undefined): void {
    if (!filters) {
      return;
    }
    result.stdout = this.filterOutputStream(result.stdout, filters.stdoutStart, filters.stdoutEnd, filters.stripStdout, filters.stripAnsi);
    result.stderr = this.filterOutputStream(result.stderr, filters.stderrStart, filters.stderrEnd, filters.stripStderr, filters.stripAnsi);
  }

  private filterOutputStream(
    value: string,
    start: RegExp | undefined,
    end: RegExp | undefined,
    strip: RegExp[] | undefined,
    stripAnsi: boolean | undefined,
  ): string {
    let output = stripAnsi ? value.replace(ANSI_ESCAPE_SEQUENCE_PATTERN, "") : value;
    if (start) {
      start.lastIndex = 0;
      const match = start.exec(output);
      if (match) {
        output = output.slice(match.index + match[0].length);
      }
    }
    if (end) {
      end.lastIndex = 0;
      const match = end.exec(output);
      if (match) {
        output = output.slice(0, match.index);
      }
    }
    for (const pattern of strip ?? []) {
      pattern.lastIndex = 0;
      output = output.replace(pattern, "");
    }
    return output;
  }

  private async runHealthCheck(
    healthCheck: lotusCommandExpectation | undefined,
    workingDirectory: string,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
    runnerId: string,
    runnerName: string,
  ): Promise<void> {
    if (!healthCheck) {
      return;
    }

    const result = await this.runCommandLine(healthCheck.command, workingDirectory, timeoutMs, signal, runnerId, runnerName);
    const combinedOutput = `${result.stdout}\n${result.stderr}`;
    if (!result.success) {
      throw new Error(`${runnerName} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
    if (healthCheck.negativeResponse && combinedOutput.includes(healthCheck.negativeResponse)) {
      throw new Error(`${runnerName} returned negative response: ${healthCheck.negativeResponse}`);
    }
    if (healthCheck.positiveResponse && !combinedOutput.includes(healthCheck.positiveResponse)) {
      throw new Error(`${runnerName} did not return positive response: ${healthCheck.positiveResponse}`);
    }
  }

  private async runOptionalCommand(
    command: string | undefined,
    workingDirectory: string,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
    runnerId: string,
    runnerName: string,
  ): Promise<void> {
    if (!command?.trim()) {
      return;
    }
    const result = await this.runCommandLine(command, workingDirectory, timeoutMs, signal, runnerId, runnerName);
    if (!result.success) {
      throw new Error(`${runnerName} failed: ${result.stderr || result.stdout || `exit ${result.exitCode}`}`);
    }
  }

  private async runCommandLine(
    command: string,
    workingDirectory: string,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
    runnerId: string,
    runnerName: string,
  ): Promise<lotusRunResult> {
    const parts = splitCommandLine(command);
    if (!parts.length) {
      throw new Error(`${runnerName} command is empty.`);
    }
    return runProcess({
      runnerId,
      runnerName,
      executable: parts[0],
      args: parts.slice(1),
      workingDirectory,
      timeoutMs,
      signal,
    });
  }

  private async ensureManagedQemu(groupName: string, groupPath: string, qemu: lotusQemuConfig, timeoutMs: lotusTimeoutMs, signal: AbortSignal): Promise<void> {
    const manager = qemu.manager;
    if (!manager?.enabled) {
      return;
    }

    const pidPath = this.resolveGroupFilePath(groupPath, manager.pidFile || ".lotus-qemu.pid");
    const existingPid = await this.readPidFile(pidPath);
    if (existingPid && this.isProcessRunning(existingPid)) {
      await this.waitForManagedQemuReadiness(groupName, groupPath, qemu, timeoutMs, signal);
      return;
    }

    if (existingPid) {
      await rm(pidPath, { force: true });
    }

    const executable = manager.executable || "qemu-system-x86_64";
    const args = this.buildManagedQemuArgs(groupPath, manager);
    if (!args.length) {
      throw new Error(`QEMU manager for ${groupName} needs qemu.manager.args or qemu.manager.image.`);
    }

    const logPath = manager.logFile ? this.resolveGroupFilePath(groupPath, manager.logFile) : null;
    const logFd = logPath ? openSync(logPath, "a") : null;
    try {
      await this.assertExecutableAvailable(executable, `QEMU manager for ${groupName}`);
      const child = spawn(executable, args, {
        cwd: groupPath,
        detached: true,
        stdio: ["ignore", logFd ?? "ignore", logFd ?? "ignore"],
      });

      child.on("error", () => undefined);
      child.unref();

      if (!child.pid) {
        throw new Error(`QEMU manager for ${groupName} did not return a process id.`);
      }

      await writeFile(pidPath, `${child.pid}\n`, "utf8");
      await this.waitForManagedQemuReadiness(groupName, groupPath, qemu, timeoutMs, signal);
    } finally {
      if (logFd != null) {
        closeSync(logFd);
      }
    }
  }

  private async assertExecutableAvailable(executable: string, label: string): Promise<void> {
    const candidates = isAbsolute(executable) || executable.includes("/") || executable.includes("\\")
      ? [executable]
      : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((entry) => join(entry, executable));

    for (const candidate of candidates) {
      try {
        await access(candidate, constants.X_OK);
        return;
      } catch {
        continue;
      }
    }

    throw new Error(`${label} executable not found: ${executable}`);
  }

  private buildManagedQemuArgs(groupPath: string, manager: lotusQemuManagerConfig): string[] {
    const args = splitCommandLine(manager.args || "");
    if (manager.image) {
      const imagePath = this.resolveGroupFilePath(groupPath, manager.image);
      args.push("-drive", `file=${imagePath},if=virtio,format=${manager.imageFormat || "qcow2"}`);
    }
    return args;
  }

  private async waitForManagedQemuReadiness(
    groupName: string,
    groupPath: string,
    qemu: lotusQemuConfig,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
  ): Promise<void> {
    const manager = qemu.manager;
    if (!manager?.enabled) {
      return;
    }

    if (!qemu.healthCheck) {
      await sleepWithSignal(manager.bootDelayMs ?? 0, signal);
      return;
    }

    const timeout = Math.min(manager.readinessTimeoutMs ?? 60_000, Math.max(finiteTimeoutMs(timeoutMs, 60_000), 1));
    const interval = manager.readinessIntervalMs ?? 1_000;
    const startedAt = Date.now();
    let lastError = "";

    while (Date.now() - startedAt <= timeout) {
      if (signal.aborted) {
        throw new Error(`QEMU ${groupName} readiness wait cancelled.`);
      }

      try {
        await this.runHealthCheck(qemu.healthCheck, groupPath, Math.min(interval, timeout), signal, `container:${groupName}:qemu:ready`, `QEMU ${groupName} readiness check`);
        return;
      } catch (error) {
        lastError = error instanceof Error ? error.message : String(error);
      }

      await sleepWithSignal(interval, signal);
    }

    throw new Error(`QEMU ${groupName} did not become ready within ${timeout} ms${lastError ? `: ${lastError}` : "."}`);
  }

  private async stopManagedQemuIfNeeded(groupName: string, groupPath: string, qemu: lotusQemuConfig, timeoutMs: lotusTimeoutMs, signal: AbortSignal): Promise<void> {
    const manager = qemu.manager;
    if (!manager?.enabled || manager.persist !== false) {
      return;
    }

    const pidPath = this.resolveGroupFilePath(groupPath, manager.pidFile || ".lotus-qemu.pid");
    const pid = await this.readPidFile(pidPath);
    if (!pid) {
      return;
    }

    if (manager.shutdownCommand) {
      await this.runOptionalCommand(
        manager.shutdownCommand,
        groupPath,
        Math.min(manager.shutdownTimeoutMs ?? finiteTimeoutMs(timeoutMs, 10_000), finiteTimeoutMs(timeoutMs, 10_000)),
        signal,
        `container:${groupName}:qemu:shutdown`,
        `QEMU ${groupName} shutdown`,
      );
    } else if (this.isProcessRunning(pid)) {
      process.kill(pid, manager.killSignal || "SIGTERM");
    }

    const stopped = await this.waitForProcessExit(pid, manager.shutdownTimeoutMs ?? 10_000, signal);
    if (!stopped && this.isProcessRunning(pid)) {
      process.kill(pid, "SIGKILL");
      await this.waitForProcessExit(pid, 2_000, signal);
    }

    await rm(pidPath, { force: true });
  }

  private async getManagedQemuStatus(groupPath: string, manager: lotusQemuManagerConfig): Promise<string> {
    const pidPath = this.resolveGroupFilePath(groupPath, manager.pidFile || ".lotus-qemu.pid");
    const pid = await this.readPidFile(pidPath);
    if (!pid) {
      return "stopped";
    }
    return this.isProcessRunning(pid) ? `running pid ${pid}` : `stale pid ${pid}`;
  }

  private async readPidFile(pidPath: string): Promise<number | null> {
    try {
      const value = (await readFile(pidPath, "utf8")).trim();
      const pid = Number.parseInt(value, 10);
      return Number.isInteger(pid) && pid > 0 ? pid : null;
    } catch {
      return null;
    }
  }

  private isProcessRunning(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private async waitForProcessExit(pid: number, timeoutMs: number, signal: AbortSignal): Promise<boolean> {
    const startedAt = Date.now();
    while (Date.now() - startedAt <= timeoutMs) {
      if (signal.aborted) {
        return false;
      }
      if (!this.isProcessRunning(pid)) {
        return true;
      }
      await sleepWithSignal(250, signal);
    }
    return !this.isProcessRunning(pid);
  }

  private async runCustomWrapper(
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    request: lotusCustomRuntimeRequest,
    timeoutMs: lotusTimeoutMs,
    signal: AbortSignal,
  ): Promise<lotusRunResult> {
    const custom = this.requireCustomConfig(config);
    await this.runHealthCheck(custom.healthCheck, groupPath, timeoutMs, signal, `container:${groupName}:custom:health`, `Custom ${groupName} health check`);

    const requestFileName = `request_${Date.now()}_${Math.random().toString(16).slice(2)}.json`;
    const requestPath = join(groupPath, requestFileName);
    try {
      await writeFile(requestPath, `${JSON.stringify(request, null, 2)}\n`, "utf8");
      const args = splitCommandLine(custom.args || "{request}").map((arg) =>
        arg
          .replaceAll("{request}", requestPath)
          .replaceAll("{group}", groupName)
          .replaceAll("{groupPath}", groupPath),
      );
      return await runProcess({
        runnerId: `container:${groupName}:custom:${request.action}`,
        runnerName: `Custom ${groupName} ${request.action}`,
        executable: custom.executable,
        args,
        workingDirectory: groupPath,
        timeoutMs,
        signal,
      });
    } finally {
      await rm(requestPath, { force: true });
    }
  }

  private createCustomRequest(
    action: lotusCustomRuntimeRequest["action"],
    groupName: string,
    groupPath: string,
    config: lotusContainerConfig,
    timeoutMs: lotusTimeoutMs,
    extra: Partial<lotusCustomRuntimeRequest> = {},
  ): lotusCustomRuntimeRequest {
    return {
      action,
      groupName,
      groupPath,
      runtime: config.runtime,
      image: config.image,
      build: config.custom?.build,
      commandStructure: config.custom?.commandStructure,
      teardown: config.custom?.teardown,
      timeoutMs,
      config: {
        executable: config.executable,
        custom: config.custom,
        qemu: config.qemu,
        http: config.http,
        healthCheck: config.healthCheck,
        elevation: config.elevation,
      },
      ...extra,
    };
  }

  private createSyntheticResult(runnerId: string, runnerName: string, stdout: string, success = true): lotusRunResult {
    const now = new Date().toISOString();
    return {
      runnerId,
      runnerName,
      startedAt: now,
      finishedAt: now,
      durationMs: 0,
      exitCode: success ? 0 : -1,
      stdout,
      stderr: "",
      success,
      timedOut: false,
      cancelled: false,
    };
  }

  private getContainersPath(): string {
    return normalizeFsPath(this.host.containersPath);
  }

  private resolveGroupPath(groupName: string): string {
    const safeName = basename(groupName);
    if (!safeName || safeName !== groupName) {
      throw new Error(`Invalid container group name: ${groupName}`);
    }
    return normalizeFsPath(join(this.getContainersPath(), safeName));
  }

  private resolveGroupFilePath(groupPath: string, filePath: string): string {
    const safePath = normalizeFsPath(join(groupPath, filePath));
    const normalizedGroupPath = normalizeFsPath(groupPath);
    const posixSafePath = safePath.replace(/\\/g, "/");
    const posixGroupPath = normalizedGroupPath.replace(/\\/g, "/");
    if (posixSafePath !== posixGroupPath && !posixSafePath.startsWith(`${posixGroupPath}/`)) {
      throw new Error(`Invalid QEMU manager path outside container group: ${filePath}`);
    }
    return safePath;
  }

  private imageNameForGroup(groupName: string): string {
    return `lotus-container-${groupName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}`;
  }

  private persistentOciContainerName(groupName: string, config: lotusContainerConfig): string {
    return config.persistent?.name?.trim() || `${this.imageNameForGroup(groupName)}-persistent`;
  }

  public getDefaultLanguageConfig(langId: string, settings: lotusPluginSettings): lotusContainerLanguageConfig | null {
    if (!langId) return null;
    const normalized = langId.toLowerCase().trim();

    switch (normalized) {
      case "python":
      case "py":
        return {
          command: `${settings.pythonExecutable.trim() || "python3"} {file}`,
          extension: ".py",
        };
      case "javascript":
      case "js":
        return {
          command: `${settings.nodeExecutable.trim() || "node"} {file}`,
          extension: ".js",
        };
      case "typescript":
      case "ts":
        return {
          command: `${settings.typescriptTranspilerExecutable.trim() || "ts-node"} {file}`,
          extension: ".ts",
        };
      case "sh":
      case "shell":
        return {
          command: "sh {file}",
          extension: ".sh",
        };
      case "bash":
        return {
          command: `${settings.shellExecutable.trim() || "bash"} {file}`,
          extension: ".sh",
        };
      case "graphviz":
      case "dot":
      case "gv":
        return {
          command: "dot -Tsvg {file}",
          extension: ".dot",
        };
      case "ruby":
      case "rb":
        return {
          command: `${settings.rubyExecutable.trim() || "ruby"} {file}`,
          extension: ".rb",
        };
      case "perl":
      case "pl":
        return {
          command: `${settings.perlExecutable.trim() || "perl"} {file}`,
          extension: ".pl",
        };
      case "lua":
        return {
          command: `${settings.luaExecutable.trim() || "lua"} {file}`,
          extension: ".lua",
        };
      case "php":
        return {
          command: `${settings.phpExecutable.trim() || "php"} {file}`,
          extension: ".php",
        };
      case "go":
        return {
          command: `${settings.goExecutable.trim() || "go"} run {file}`,
          extension: ".go",
        };
      case "haskell":
      case "hs":
        return {
          command: `${settings.haskellExecutable.trim() || "runghc"} {file}`,
          extension: ".hs",
        };
      case "ocaml":
      case "ml":
        if (settings.ocamlMode === "dune") {
          return {
            command: `${settings.ocamlExecutable.trim() || "dune"} exec -- ocaml {file}`,
            extension: ".ml",
          };
        }
        if (settings.ocamlMode === "ocamlc") {
          return {
            command: shellCommand(`${settings.ocamlExecutable.trim() || "ocamlc"} -o /tmp/lotus-ocaml "$1" && /tmp/lotus-ocaml`),
            extension: ".ml",
          };
        }
        return {
          command: `${settings.ocamlExecutable.trim() || "ocaml"} {file}`,
          extension: ".ml",
        };
      case "c":
        return {
          command: shellCommand(`${settings.cExecutable.trim() || "gcc"} "$1" -o /tmp/lotus-c && /tmp/lotus-c`),
          extension: ".c",
        };
      case "cpp":
      case "c++":
        return {
          command: shellCommand(`${settings.cppExecutable.trim() || "g++"} "$1" -o /tmp/lotus-cpp && /tmp/lotus-cpp`),
          extension: ".cpp",
        };
      case "ebpf":
      case "ebpf-c":
      case "bpf":
      case "bpf-c":
        return {
          command: shellCommand(`${settings.ebpfClangExecutable.trim() || "clang"} -target bpf -O2 -g -Wall "$1" -c -o /tmp/lotus-ebpf.o && printf 'compiled /tmp/lotus-ebpf.o\\n'`),
          extension: ".bpf.c",
        };
      case "bpftrace":
      case "bt":
        return {
          command: shellCommand(`if ${settings.bpftraceExecutable.trim() || "bpftrace"} --help 2>&1 | grep -q -- '--dry-run'; then ${settings.bpftraceExecutable.trim() || "bpftrace"} --dry-run "$1"; else ${settings.bpftraceExecutable.trim() || "bpftrace"} -d "$1"; fi`),
          extension: ".bt",
        };
      case "rust":
      case "rs":
        return {
          command: shellCommand(`${settings.rustExecutable.trim() || "rustc"} "$1" -o /tmp/lotus-rust && /tmp/lotus-rust`),
          extension: ".rs",
        };
      case "java": {
        const compiler = settings.javaCompilerExecutable.trim() || "javac";
        return {
          command: shellCommand(`tmp=/tmp/lotus-java-$$ && mkdir -p "$tmp" && cp "$1" "$tmp/Main.java" && ${compiler} "$tmp/Main.java" && ${settings.javaExecutable.trim() || "java"} -cp "$tmp" Main`),
          extension: ".java",
        };
      }
      case "llvm-ir":
      case "llvm":
      case "ll":
        return {
          command: `${settings.llvmInterpreterExecutable.trim() || "lli"} {file}`,
          extension: ".ll",
        };
      case "lean":
        return {
          command: `${settings.leanExecutable.trim() || "lean"} {file}`,
          extension: ".lean",
        };
      case "coq":
        return {
          command: `${settings.coqExecutable.trim() || "coqc"} -q {file}`,
          extension: ".v",
        };
      case "smtlib":
      case "smt":
      case "smt-lib":
        return {
          command: `${settings.smtExecutable.trim() || "z3"} {file}`,
          extension: ".smt2",
        };
    }

    const custom = findEnabledCommandLanguage(settings, normalized);
    if (custom) {
      return {
        command: `${custom.executable} ${custom.args}`.trim(),
        extension: custom.extension || ".txt",
      };
    }

    return null;
  }
}

function shellCommand(command: string): string {
  return `sh -lc ${quoteCommandArg(command)} sh {file}`;
}

function normalizeOciLanguageCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || isShellInvocation(trimmed) || !needsShellInvocation(trimmed)) {
    return command;
  }

  const script = trimmed.includes("{file}") ? trimmed.replaceAll("{file}", "\"$1\"") : trimmed;
  return shellCommand(script);
}

function normalizeShellLanguageCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed || trimmed.includes("{file}") || isShellInvocation(trimmed) || !referencesShellPositionalFileArg(trimmed)) {
    return command;
  }

  return shellCommand(trimmed);
}

function isShellInvocation(command: string): boolean {
  const [executable, firstArg] = splitCommandLine(command);
  const shellName = executable?.split(/[\\/]/).pop();
  return Boolean(shellName && ["sh", "bash", "dash", "zsh", "ksh"].includes(shellName) && firstArg?.includes("c"));
}

function needsShellInvocation(command: string): boolean {
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] ?? "";

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (quote !== "'") {
      if (char === "$" && (isShellPositionalFileArg(next) || next === "(" || next === "{" || /[A-Za-z_]/.test(next))) {
        return true;
      }
      if (char === "`") {
        return true;
      }
    }

    if (!quote && (
      char === ";" ||
      char === "<" ||
      char === ">" ||
      char === "|" ||
      (char === "&" && next === "&")
    )) {
      return true;
    }
  }

  return false;
}

function referencesShellPositionalFileArg(command: string): boolean {
  let quote: "'" | "\"" | null = null;
  let escaping = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1] ?? "";

    if (escaping) {
      escaping = false;
      continue;
    }

    if (char === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if ((char === "'" || char === "\"") && !quote) {
      quote = char;
      continue;
    }

    if (char === quote) {
      quote = null;
      continue;
    }

    if (quote !== "'" && char === "$" && isShellPositionalFileArg(next)) {
      return true;
    }
  }

  return false;
}

function isShellPositionalFileArg(char: string): boolean {
  return char === "1" || char === "@" || char === "*";
}

function normalizeExtension(extension: string): string {
  const trimmed = extension.trim();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalRegex(value: unknown, label: string): RegExp | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${label} must be a string.`);
  }
  return regexFromString(value, label);
}

function optionalRegexList(value: unknown, label: string): RegExp[] | undefined {
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

function regexFromString(value: string, label: string, fallbackFlags = ""): RegExp {
  const literal = value.match(/^\/(.+)\/([a-z]*)$/i);
  const source = literal ? literal[1] : value;
  const flags = literal ? literal[2] : fallbackFlags;
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new Error(`${label} is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return value;
}

function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return value;
}

function optionalSignal(value: unknown, label: string): NodeJS.Signals | undefined {
  if (value == null) {
    return undefined;
  }
  if (typeof value !== "string" || !/^SIG[A-Z0-9]+$/.test(value)) {
    throw new Error(`${label} must be a signal name like SIGTERM.`);
  }
  return value as NodeJS.Signals;
}

async function sleepWithSignal(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs <= 0 || signal.aborted) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timeout = lotusSetTimeout(resolve, durationMs);
    const abort = () => {
      lotusClearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function runtimeLabel(runtime: lotusContainerRuntime): string {
  switch (runtime) {
    case "docker":
      return "Docker";
    case "podman":
      return "Podman";
    case "qemu":
      return "QEMU";
    case "custom":
      return "Custom";
    case "wsl":
      return "WSL";
    case "ssh":
      return "SSH";
    case "http":
      return "HTTP";
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function finiteTimeoutMs(timeoutMs: lotusTimeoutMs, fallbackMs: number): number {
  return timeoutMs ?? fallbackMs;
}

interface lotusHttpTemplateContext {
  values: Record<string, string>;
}

interface lotusHttpRequestBody {
  body?: string;
  contentType?: string;
}

interface lotusDecodedHttpRunResponse {
  stdout: string;
  stderr: string;
  exitCode: number;
  success: boolean;
  warning?: string;
}

function readHttpMethod(value: unknown): lotusHttpMethod {
  if (value == null || value === "") {
    return "POST";
  }
  if (typeof value !== "string") {
    throw new Error("Container config http.method must be a string.");
  }
  const normalized = value.trim().toUpperCase();
  if (["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(normalized)) {
    return normalized as lotusHttpMethod;
  }
  throw new Error("Container config http.method must be GET, POST, PUT, PATCH, DELETE, or HEAD.");
}

function readHttpResponseMode(value: unknown): lotusHttpResponseMode {
  if (value == null || value === "") {
    return "auto";
  }
  if (value === "auto" || value === "json" || value === "text") {
    return value;
  }
  throw new Error("Container config http.responseMode must be auto, json, or text.");
}

function readHttpHeadersConfig(value: unknown): Record<string, string> {
  if (value == null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new Error("Container config http.headers must be an object.");
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(value)) {
    if (typeof headerValue !== "string") {
      throw new Error(`Container config http.headers.${name} must be a string.`);
    }
    if (name.trim() && headerValue.trim()) {
      headers[name.trim()] = headerValue;
    }
  }
  return headers;
}

function readHttpSuccessStatuses(value: unknown): lotusHttpStatusRange[] {
  if (value == null || value === "") {
    return [{ min: 200, max: 299 }];
  }
  const values = Array.isArray(value) ? value : [value];
  const ranges = values.map(readHttpStatusRange);
  return ranges.length ? ranges : [{ min: 200, max: 299 }];
}

function readHttpStatusRange(value: unknown): lotusHttpStatusRange {
  if (typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599) {
    return { min: value, max: value };
  }
  if (typeof value !== "string") {
    throw new Error("Container config http success status values must be numbers or strings.");
  }
  const trimmed = value.trim();
  const range = trimmed.match(/^(\d{3})\s*-\s*(\d{3})$/);
  if (range) {
    const min = Number.parseInt(range[1], 10);
    const max = Number.parseInt(range[2], 10);
    if (min >= 100 && max <= 599 && min <= max) {
      return { min, max };
    }
  }
  const status = Number.parseInt(trimmed, 10);
  if (/^\d{3}$/.test(trimmed) && status >= 100 && status <= 599) {
    return { min: status, max: status };
  }
  throw new Error(`Invalid HTTP success status: ${trimmed}`);
}

function createHttpTemplateContext(
  groupName: string,
  block: lotusCodeBlock,
  language: lotusContainerLanguageConfig,
  tempFileName: string,
  context: lotusRunContext,
): lotusHttpTemplateContext {
  const extension = language.extension ? normalizeExtension(language.extension) : "";
  const baseValues: Record<string, string> = {
    source: block.content,
    stdin: context.stdin ?? "",
    language: block.language,
    languageAlias: block.languageAlias,
    sourceLanguage: block.sourceLanguage,
    group: groupName,
    fileName: tempFileName,
    filename: tempFileName,
    extension,
    command: language.command ?? "",
    workingDirectory: context.workingDirectory,
  };
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseValues)) {
    values[key] = value;
    values[`${key}Uri`] = encodeURIComponent(value);
    values[`${key}Json`] = JSON.stringify(value);
  }
  return { values };
}

function renderHttpHeaders(headers: Record<string, string>, context: lotusHttpTemplateContext): Record<string, string> {
  const rendered: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    rendered[name] = renderHttpTemplateString(value, context);
  }
  return rendered;
}

function createHttpRequestBody(http: lotusHttpConfig, context: lotusHttpTemplateContext, headers: Record<string, string>): lotusHttpRequestBody {
  const bodyConfig = http.body === undefined && !["GET", "DELETE", "HEAD"].includes(http.method)
    ? {
      source: "{source}",
      stdin: "{stdin}",
      language: "{language}",
      languageAlias: "{languageAlias}",
      sourceLanguage: "{sourceLanguage}",
      fileName: "{fileName}",
      command: "{command}",
    }
    : http.body;

  if (bodyConfig == null) {
    return {};
  }

  if (typeof bodyConfig === "string") {
    return {
      body: renderHttpTemplateString(bodyConfig, context),
      contentType: http.contentType ?? (hasHttpHeader(headers, "content-type") ? undefined : "text/plain"),
    };
  }

  return {
    body: JSON.stringify(renderHttpTemplateValue(bodyConfig, context)),
    contentType: http.contentType ?? (hasHttpHeader(headers, "content-type") ? undefined : "application/json"),
  };
}

function renderHttpTemplateValue(value: unknown, context: lotusHttpTemplateContext): unknown {
  if (typeof value === "string") {
    return renderHttpTemplateString(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => renderHttpTemplateValue(entry, context));
  }
  if (isRecord(value)) {
    const rendered: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      rendered[key] = renderHttpTemplateValue(entry, context);
    }
    return rendered;
  }
  return value;
}

function renderHttpTemplateString(value: string, context: lotusHttpTemplateContext): string {
  return value.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (match, token: string) => context.values[token] ?? match);
}

function hasHttpHeader(headers: Record<string, string>, name: string): boolean {
  const normalized = name.toLowerCase();
  return Object.keys(headers).some((headerName) => headerName.toLowerCase() === normalized);
}

function assertHttpUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use http or https.`);
  }
}

async function waitForHttpResponse<T>(request: Promise<T>, timeoutMs: lotusTimeoutMs, signal: AbortSignal, label: string): Promise<T> {
  if (signal.aborted) {
    throw new Error(`${label} request was cancelled.`);
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof lotusSetTimeout> | null = null;
    const cleanup = () => {
      if (timeoutHandle !== null) {
        lotusClearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      finish(() => reject(new Error(`${label} request was cancelled.`)));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== null) {
      timeoutHandle = lotusSetTimeout(() => {
        finish(() => reject(new Error(`${label} request timed out after ${timeoutMs} ms.`)));
      }, timeoutMs);
    }
    request.then(
      (response) => finish(() => resolve(response)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function decodeHttpRunResponse(http: lotusHttpConfig, response: lotusHttpResponse): lotusDecodedHttpRunResponse {
  const statusSuccess = matchesHttpStatus(response.status, http.successStatuses);
  const parsed = parseHttpResponseBody(http, response.text);
  const stdout = http.stdoutPath
    ? httpOutputFromPath(parsed, http.stdoutPath, "stdoutPath")
    : response.text;
  const stderr = http.stderrPath
    ? httpOutputFromPath(parsed, http.stderrPath, "stderrPath")
    : "";
  const exitCode = http.exitCodePath
    ? httpExitCodeFromValue(readRequiredHttpPath(parsed, http.exitCodePath, "exitCodePath"), "exitCodePath")
    : statusSuccess ? 0 : 1;
  const mappedSuccess = http.successPath
    ? httpSuccessFromValue(readRequiredHttpPath(parsed, http.successPath, "successPath"), "successPath")
    : undefined;
  const success = mappedSuccess ?? (statusSuccess && exitCode === 0);
  const warning = statusSuccess ? undefined : `HTTP status ${response.status} was outside configured success statuses.`;
  return {
    stdout,
    stderr,
    exitCode,
    success,
    ...(warning ? { warning } : {}),
  };
}

function parseHttpResponseBody(http: lotusHttpConfig, text: string): unknown {
  if (http.responseMode === "text") {
    return text;
  }
  const needsJson = Boolean(http.stdoutPath || http.stderrPath || http.exitCodePath || http.successPath || http.responseMode === "json");
  const trimmed = text.trim();
  if (!trimmed) {
    if (needsJson) {
      throw new Error("HTTP response body was empty but JSON response paths were configured.");
    }
    return undefined;
  }
  if (!needsJson && !trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    return undefined;
  }
  try {
    return JSON.parse(trimmed);
  } catch (error) {
    if (needsJson) {
      throw new Error(`HTTP response body was not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    return undefined;
  }
}

function httpOutputFromPath(parsed: unknown, path: string, label: string): string {
  return httpValueToOutput(readRequiredHttpPath(parsed, path, label));
}

function readRequiredHttpPath(parsed: unknown, path: string, label: string): unknown {
  const value = readHttpPath(parsed, path);
  if (value === undefined) {
    throw new Error(`HTTP response ${label} did not resolve: ${path}`);
  }
  return value;
}

function readHttpPath(parsed: unknown, path: string): unknown {
  const segments = readHttpPathSegments(path);
  if (!segments.length) {
    return parsed;
  }

  let current = parsed;
  for (const segment of segments) {
    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return undefined;
      }
      current = current[index];
    } else if (isRecord(current)) {
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function readHttpPathSegments(path: string): string[] {
  const normalized = path.trim().replace(/^\$\.?/, "");
  if (!normalized) {
    return [];
  }
  const matches = normalized.match(/[^.[\]]+|\[\d+\]/g);
  return (matches ?? []).map((segment) => segment.startsWith("[") ? segment.slice(1, -1) : segment);
}

function httpValueToOutput(value: unknown): string {
  if (value == null) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function httpExitCodeFromValue(value: unknown, label: string): number {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  if (typeof value === "boolean") {
    return value ? 0 : 1;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }
    if (isHttpTrueValue(trimmed)) {
      return 0;
    }
    if (isHttpFalseValue(trimmed)) {
      return 1;
    }
  }
  throw new Error(`HTTP response ${label} must resolve to an integer or boolean.`);
}

function httpSuccessFromValue(value: unknown, label: string): boolean {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value === 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (isHttpTrueValue(trimmed)) {
      return true;
    }
    if (isHttpFalseValue(trimmed)) {
      return false;
    }
  }
  throw new Error(`HTTP response ${label} must resolve to a boolean.`);
}

function isHttpTrueValue(value: string): boolean {
  return ["1", "true", "yes", "ok", "success"].includes(value.toLowerCase());
}

function isHttpFalseValue(value: string): boolean {
  return ["0", "false", "no", "fail", "failed", "error"].includes(value.toLowerCase());
}

function matchesHttpStatus(status: number, ranges: lotusHttpStatusRange[]): boolean {
  return ranges.some((range) => status >= range.min && status <= range.max);
}

function isBuiltInGodboltGroup(groupName: string): boolean {
  return groupName.trim().toLowerCase() === BUILT_IN_GODBOLT_GROUP;
}

async function createGodboltClientState(
  block: lotusCodeBlock,
  language: string,
  settings: lotusPluginSettings,
  baseUrl: string,
  timeoutMs: lotusTimeoutMs,
  signal: AbortSignal,
  requestUrlFn: lotusRequestUrl | undefined,
  compilerCache: Map<string, string | null>,
): Promise<lotusGodboltClientState> {
  const session: lotusGodboltSessionState = {
    id: 1,
    language,
    source: block.content,
  };
  const compilerId = await readGodboltCompiler(block, language, settings, baseUrl, timeoutMs, signal, requestUrlFn, compilerCache);
  if (compilerId) {
    const options = readGodboltCompilerOptions(block, language, settings);
    session.compilers = [{
      id: compilerId,
      ...(options ? { options } : {}),
      filters: { ...GODBOLT_DEFAULT_COMPILER_FILTERS },
    }];
  }
  return {
    sessions: [session],
  };
}

async function readGodboltCompiler(
  block: lotusCodeBlock,
  language: string,
  settings: lotusPluginSettings,
  baseUrl: string,
  timeoutMs: lotusTimeoutMs,
  signal: AbortSignal,
  requestUrlFn: lotusRequestUrl | undefined,
  compilerCache: Map<string, string | null>,
): Promise<string | undefined> {
  const compilerId = readBlockAttribute(block, "lotus-godbolt-compiler", "godbolt-compiler", "ce-compiler");
  if (compilerId) {
    return isDisabledGodboltValue(compilerId) ? undefined : compilerId;
  }
  const settingsCompiler = readGodboltSettingsMap(settings.godboltCompilerDefaults, "Godbolt compiler defaults")[language];
  if (settingsCompiler) {
    return isDisabledGodboltValue(settingsCompiler) ? undefined : settingsCompiler;
  }
  if (settings.godboltResolveCompilerFromApi) {
    const remoteCompiler = await readGodboltRemoteCompiler(language, baseUrl, timeoutMs, signal, requestUrlFn, compilerCache);
    if (remoteCompiler) {
      return remoteCompiler;
    }
  }
  return GODBOLT_DEFAULT_COMPILERS[language];
}

function readGodboltCompilerOptions(block: lotusCodeBlock, language: string, settings: lotusPluginSettings): string | undefined {
  const options = readBlockAttribute(block, "lotus-godbolt-options", "godbolt-options", "ce-options");
  if (options) {
    return isDisabledGodboltValue(options) ? undefined : options;
  }
  const settingsOptions = readGodboltSettingsMap(settings.godboltOptionsDefaults, "Godbolt options defaults")[language];
  if (settingsOptions) {
    return isDisabledGodboltValue(settingsOptions) ? undefined : settingsOptions;
  }
  return GODBOLT_DEFAULT_COMPILER_OPTIONS[language];
}

function readGodboltSettingsMap(value: string, label: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}") {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    throw new Error(`${label} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)) {
    throw new Error(`${label} must be a JSON object.`);
  }

  const result: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(parsed)) {
    if (typeof rawValue !== "string") {
      throw new Error(`${label}.${key} must be a string.`);
    }
    const normalizedKey = normalizeGodboltLanguageKey(key, label);
    const normalizedValue = rawValue.trim();
    if (normalizedValue) {
      result[normalizedKey] = normalizedValue;
    }
  }
  return result;
}

async function readGodboltRemoteCompiler(
  language: string,
  baseUrl: string,
  timeoutMs: lotusTimeoutMs,
  signal: AbortSignal,
  requestUrlFn: lotusRequestUrl | undefined,
  compilerCache: Map<string, string | null>,
): Promise<string | undefined> {
  if (!requestUrlFn) {
    return undefined;
  }
  const cacheKey = `${baseUrl}\u0000${language}`;
  if (compilerCache.has(cacheKey)) {
    return compilerCache.get(cacheKey) ?? undefined;
  }

  try {
    const compilers = await fetchGodboltCompilers(language, baseUrl, timeoutMs, signal, requestUrlFn);
    const selected = selectGodboltCompiler(language, compilers);
    compilerCache.set(cacheKey, selected ?? null);
    return selected;
  } catch {
    return undefined;
  }
}

async function fetchGodboltCompilers(
  language: string,
  baseUrl: string,
  timeoutMs: lotusTimeoutMs,
  signal: AbortSignal,
  requestUrlFn: lotusRequestUrl,
): Promise<lotusCompilerExplorerCompiler[]> {
  const endpoint = `${baseUrl}/api/compilers/${encodeURIComponent(language)}?fields=id,name,lang,semver,compilerType,instructionSet`;
  const request = requestUrlFn({
    url: endpoint,
    method: "GET",
    headers: {
      "Accept": "application/json",
    },
    throw: false,
  });
  request.catch(() => undefined);
  const response = await waitForGodboltResponse(request, timeoutMs, signal);
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Godbolt compiler metadata returned HTTP ${response.status}`);
  }

  const parsed: unknown = JSON.parse(response.text);
  if (!Array.isArray(parsed)) {
    throw new Error("Godbolt compiler metadata was not an array.");
  }
  return parsed.map(readGodboltCompilerMetadata).filter((compiler): compiler is lotusCompilerExplorerCompiler => compiler !== null);
}

function readGodboltCompilerMetadata(value: unknown): lotusCompilerExplorerCompiler | null {
  if (!isRecord(value)) {
    return null;
  }
  const id = optionalString(value.id);
  if (!id) {
    return null;
  }
  return {
    id,
    name: optionalString(value.name) ?? "",
    lang: optionalString(value.lang) ?? "",
    semver: optionalString(value.semver) ?? "",
    compilerType: optionalString(value.compilerType) ?? "",
    instructionSet: optionalString(value.instructionSet) ?? "",
  };
}

function selectGodboltCompiler(language: string, compilers: lotusCompilerExplorerCompiler[]): string | undefined {
  const candidates = compilers.filter((compiler) => compiler.lang === language || !compiler.lang);
  const preferred = candidates.filter((compiler) => isPreferredGodboltCompiler(language, compiler));
  const selected = selectHighestStableCompiler(preferred.length ? preferred : candidates.filter(hasStableCompilerVersion));
  return selected?.id;
}

function isPreferredGodboltCompiler(language: string, compiler: lotusCompilerExplorerCompiler): boolean {
  switch (language) {
    case "c":
      return compiler.instructionSet === "amd64" && /^cg\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "c++":
      return compiler.instructionSet === "amd64" && /^g\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "rust":
      return compiler.instructionSet === "amd64" && /^r\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "go":
      return compiler.instructionSet === "amd64" && /^gl\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "java":
      return /^java\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "python":
      return compiler.compilerType === "python" && /^python\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "javascript":
      return compiler.id === "v8trunk" || (compiler.compilerType === "v8" && hasStableCompilerVersion(compiler));
    case "typescript":
      return compiler.instructionSet === "amd64" && /^tsc_.+_gc$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "ruby":
      return compiler.compilerType === "ruby" && /^ruby\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "ocaml":
      return compiler.instructionSet === "amd64" && /^ocaml\d+/.test(compiler.id) && !compiler.id.includes("flambda") && hasStableCompilerVersion(compiler);
    case "llvm":
      return compiler.instructionSet === "amd64" && compiler.compilerType === "llc" && /^llc\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "assembly":
      return compiler.instructionSet === "amd64" && compiler.compilerType === "nasm" && /^nasm\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "haskell":
      return compiler.instructionSet === "amd64" && compiler.compilerType === "haskell" && /^ghc\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "lua":
      return compiler.instructionSet === "amd64" && compiler.compilerType === "lua" && /^lua\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "perl":
      return compiler.compilerType === "perl" && /^perl\d+$/.test(compiler.id) && hasStableCompilerVersion(compiler);
    case "lean":
      return compiler.instructionSet === "amd64" && compiler.compilerType === "lean" && /^lean_/.test(compiler.id) && hasStableCompilerVersion(compiler);
    default:
      return hasStableCompilerVersion(compiler);
  }
}

function selectHighestStableCompiler(compilers: lotusCompilerExplorerCompiler[]): lotusCompilerExplorerCompiler | undefined {
  return [...compilers].sort((left, right) => compareCompilerVersion(right, left))[0];
}

function compareCompilerVersion(left: lotusCompilerExplorerCompiler, right: lotusCompilerExplorerCompiler): number {
  if (left.id === "v8trunk" && right.id !== "v8trunk") {
    return 1;
  }
  if (right.id === "v8trunk" && left.id !== "v8trunk") {
    return -1;
  }
  const leftVersion = readCompilerVersionParts(left);
  const rightVersion = readCompilerVersionParts(right);
  const width = Math.max(leftVersion.length, rightVersion.length);
  for (let index = 0; index < width; index += 1) {
    const delta = (leftVersion[index] ?? 0) - (rightVersion[index] ?? 0);
    if (delta !== 0) {
      return delta;
    }
  }
  return left.id.localeCompare(right.id);
}

function hasStableCompilerVersion(compiler: lotusCompilerExplorerCompiler): boolean {
  return readCompilerVersionParts(compiler).length > 0 && !/\b(?:trunk|snapshot|tip|nightly|beta|master)\b/i.test(`${compiler.id} ${compiler.name} ${compiler.semver}`);
}

function readCompilerVersionParts(compiler: lotusCompilerExplorerCompiler): number[] {
  const match = compiler.semver.match(/\d+(?:\.\d+){0,3}/) ?? compiler.name.match(/\d+(?:\.\d+){0,3}/);
  return match ? match[0].split(".").map((part) => Number.parseInt(part, 10)) : [];
}

function readGodboltLanguage(block: lotusCodeBlock): string {
  const override = readBlockAttribute(block, "lotus-godbolt-language", "godbolt-language", "ce-language");
  if (override) {
    return normalizeGodboltLanguageKey(override, "lotus-godbolt-language");
  }

  for (const candidate of [block.language, block.languageAlias, block.sourceLanguage]) {
    const mapped = GODBOLT_LANGUAGE_ALIASES[candidate.trim().toLowerCase()];
    if (mapped) {
      return mapped;
    }
  }

  throw new Error(`Godbolt has no default language mapping for ${block.sourceLanguage || block.language}. Set lotus-godbolt-language to a Compiler Explorer language id.`);
}

function readGodboltBaseUrl(block: lotusCodeBlock): string {
  const value = readBlockAttribute(block, "lotus-godbolt-base-url", "godbolt-base-url", "compiler-explorer-url", "ce-url");
  if (!value) {
    return GODBOLT_DEFAULT_BASE_URL;
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid Godbolt base URL: ${value}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`Invalid Godbolt base URL protocol: ${url.protocol}`);
  }
  return url.toString().replace(/\/+$/, "");
}

async function postGodboltShortlink(
  clientState: lotusGodboltClientState,
  baseUrl: string,
  timeoutMs: lotusTimeoutMs,
  signal: AbortSignal,
  requestUrlFn?: lotusRequestUrl,
): Promise<string> {
  if (signal.aborted) {
    throw new Error("Godbolt shortlink request was cancelled.");
  }
  if (!requestUrlFn) {
    throw new Error("Godbolt shortlink creation requires Obsidian requestUrl.");
  }
  try {
    const request = requestUrlFn({
      url: `${baseUrl}/api/shortener`,
      method: "POST",
      contentType: "application/json",
      headers: {
        "Accept": "application/json",
      },
      body: JSON.stringify(clientState),
      throw: false,
    });
    request.catch(() => undefined);
    const response = await waitForGodboltResponse(request, timeoutMs, signal);
    const body = response.text;
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Godbolt shortener returned HTTP ${response.status}${body.trim() ? `: ${shortenForError(body)}` : ""}`);
    }
    const parsed: unknown = JSON.parse(body);
    const url = isRecord(parsed) ? optionalString(parsed.url) : undefined;
    if (!url) {
      throw new Error("Godbolt shortener response did not include a url.");
    }
    return url;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`Godbolt shortener returned invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

async function waitForGodboltResponse<T>(request: Promise<T>, timeoutMs: lotusTimeoutMs, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    throw new Error("Godbolt shortlink request was cancelled.");
  }

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    let timeoutHandle: ReturnType<typeof lotusSetTimeout> | null = null;
    const cleanup = () => {
      if (timeoutHandle !== null) {
        lotusClearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      signal.removeEventListener("abort", onAbort);
    };
    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      finish(() => reject(new Error("Godbolt shortlink request was cancelled.")));
    };

    signal.addEventListener("abort", onAbort, { once: true });
    if (timeoutMs !== null) {
      timeoutHandle = lotusSetTimeout(() => {
        finish(() => reject(new Error(`Godbolt shortlink request timed out after ${timeoutMs} ms.`)));
      }, timeoutMs);
    }
    request.then(
      (response) => finish(() => resolve(response)),
      (error: unknown) => finish(() => reject(error)),
    );
  });
}

function renderGodboltLinkHtml(url: string, language: string): string {
  const escapedUrl = escapeHtml(url);
  const escapedHref = escapeHtmlAttribute(url);
  return [
    "<!doctype html>",
    "<meta charset=\"utf-8\">",
    "<style>body{font:13px -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;margin:0;padding:12px;color:#222;background:#fff}a{font-weight:600;color:#0b5cad}.meta{margin-top:6px;color:#555;word-break:break-all}</style>",
    `<a href="${escapedHref}" target="_blank" rel="noreferrer noopener">open in godbolt</a>`,
    `<div class="meta">${escapedUrl}</div>`,
    `<div class="meta">language: ${escapeHtml(language)}</div>`,
  ].join("");
}

function readBlockAttribute(block: lotusCodeBlock, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = block.attributes[name];
    if (value?.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function normalizeGodboltLanguageId(value: string, label: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[a-z0-9_+.#-]+$/.test(normalized)) {
    throw new Error(`${label} must be a Compiler Explorer language id.`);
  }
  return normalized;
}

function normalizeGodboltLanguageKey(value: string, label: string): string {
  const normalized = normalizeGodboltLanguageId(value, label);
  return GODBOLT_LANGUAGE_ALIASES[normalized] ?? normalized;
}

function isDisabledGodboltValue(value: string): boolean {
  return ["0", "false", "no", "off", "none"].includes(value.trim().toLowerCase());
}

function shortenForError(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 500 ? `${normalized.slice(0, 500)}...` : normalized;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeHtmlAttribute(value: string): string {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function optionalUploadMode(value: unknown): lotusRemoteUploadMode | undefined {
  if (value == null || value === "") {
    return undefined;
  }
  if (value === "inline" || value === "scp") {
    return value;
  }
  throw new Error("Remote upload mode must be inline or scp.");
}

function quoteCommandArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
