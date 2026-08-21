import { closeSync, constants, existsSync, openSync } from "fs";
import { access, mkdir, readFile, readdir, rm, writeFile } from "fs/promises";
import { basename, delimiter, isAbsolute, join, normalize as normalizeFsPath, posix as posixPath } from "path";
import { spawn } from "child_process";
import { isCompileContainerGroupAllowed } from "../buildProfile";
import { runProcess } from "./processRunner";
import { splitCommandLine } from "../utils/command";
import { findEnabledCommandLanguage } from "../languagePackages";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult } from "../types";
import { lotusClearTimeout, lotusSetTimeout } from "../utils/timers";
import type { lotusTimeoutMs } from "../utils/timeout";
import { readContainerConfig, requireCustomConfig, requireQemuConfig, requireSshConfig, runtimeLabel, type lotusCommandExpectation, type lotusContainerConfig, type lotusContainerElevationConfig, type lotusContainerLanguageConfig, type lotusContainerRuntime, type lotusCustomRuntimeConfig, type lotusOutputFilterConfig, type lotusQemuConfig, type lotusQemuManagerConfig, type lotusRemoteConfig } from "./containerConfig";
import { runHttpGroup, type lotusHttpConfig, type lotusRequestUrl } from "./httpGroup";
import { normalizeExtension } from "./configValues";
import { BUILT_IN_GODBOLT_GROUP, isBuiltInGodboltGroup, runGodboltGroup } from "./godboltGroup";

const ANSI_ESCAPE_SEQUENCE_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "g");

export interface lotusContainerGroupSummary {
  name: string;
  status: string;
  editable?: boolean;
  buildable?: boolean;
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

export interface lotusContainerHost {
  containersPath: string;
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function finiteTimeoutMs(timeoutMs: lotusTimeoutMs, fallbackMs: number): number {
  return timeoutMs ?? fallbackMs;
}

function quoteCommandArg(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
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
            const config = await readContainerConfig(groupPath);
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
      return runGodboltGroup(block, context, settings, this.requestUrlFn, this.godboltDefaultCompilerCache);
    }
    const groupPath = this.resolveGroupPath(groupName);
    const config = await readContainerConfig(groupPath);
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
          result = await runHttpGroup(groupName, config, block, language, tempFileName, context, this.requestUrlFn);
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
    const config = await readContainerConfig(groupPath);
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
    const qemu = requireQemuConfig(config);
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
      requireSshConfig(config),
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
    const qemu = requireQemuConfig(config);
    if (!qemu.buildCommand?.trim()) {
      return this.createSyntheticResult(`container:${groupName}:qemu:build`, `QEMU ${groupName} build`, "No QEMU build command configured.\n");
    }
    return this.runCommandLine(qemu.buildCommand, groupPath, timeoutMs, signal, `container:${groupName}:qemu:build`, `QEMU ${groupName} build`);
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
    const custom = requireCustomConfig(config);
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
