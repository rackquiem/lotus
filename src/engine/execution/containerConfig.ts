
import { readFile } from "fs/promises";
import { join } from "path";
import { isCompileContainerRuntimeAllowed, isCompileFeatureAllowed } from "../buildProfile";
import { readHttpConfig, type lotusHttpConfig } from "./httpGroup";
import { isRecord, optionalNonNegativeInteger, optionalPositiveInteger, optionalRegex, optionalRegexList, optionalSignal, optionalString, optionalUploadMode } from "./configValues";

export type lotusContainerRuntime = "docker" | "podman" | "qemu" | "wsl" | "ssh" | "custom" | "http";

type lotusContainerElevationMode = "default" | "root";

export interface lotusContainerLanguageConfig {
  command?: string;
  extension?: string;
  useDefault?: boolean;
}

export interface lotusCommandExpectation {
  command: string;
  positiveResponse?: string;
  negativeResponse?: string;
}

export interface lotusQemuConfig {
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

export interface lotusRemoteConfig {
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

export type lotusRemoteUploadMode = "inline" | "scp";

export interface lotusQemuManagerConfig {
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

export interface lotusCustomRuntimeConfig {
  executable: string;
  args?: string;
  build?: string;
  commandStructure?: string;
  teardown?: string;
  healthCheck?: lotusCommandExpectation;
}

interface lotusWslConfig {
  interactive?: boolean;
}

interface lotusOciPersistentConfig {
  enabled: boolean;
  name?: string;
  keepAliveCommand?: string;
}

export interface lotusContainerElevationConfig {
  mode: lotusContainerElevationMode;
  commandPrefix?: string;
}

export interface lotusContainerConfig {
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

export interface lotusOutputFilterConfig {
  stripAnsi?: boolean;
  stdoutStart?: RegExp;
  stdoutEnd?: RegExp;
  stderrStart?: RegExp;
  stderrEnd?: RegExp;
  stripStdout?: RegExp[];
  stripStderr?: RegExp[];
}

export function runtimeLabel(runtime: lotusContainerRuntime): string {
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

export async function readContainerConfig(groupPath: string): Promise<lotusContainerConfig> {
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
  const runtime = readRuntime(data.runtime);
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
    persistent: readPersistentConfig(data.persistent),
    elevation: readElevationConfig(data.elevation),
    wsl: readWslConfig(data.wsl),
    healthCheck: readHealthCheck(data.healthCheck, "Container config healthCheck"),
    outputFilters: readOutputFilters(data.outputFilters ?? data.outputFilter),
    ssh: readSshConfig(data.ssh ?? data.remote, runtime),
    qemu: readQemuConfig(data.qemu),
    custom: readCustomConfig(data.custom),
    http: readHttpConfig(data.http, runtime),
    languages,
  };
}

export function readRuntime(value: unknown): lotusContainerRuntime {
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

export function readPersistentConfig(value: unknown): lotusOciPersistentConfig | undefined {
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

export function readWslConfig(value: unknown): lotusWslConfig | undefined {
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

export function readElevationConfig(value: unknown): lotusContainerElevationConfig {
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

export function readSshConfig(value: unknown, runtime: lotusContainerRuntime): lotusRemoteConfig | undefined {
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
    healthCheck: readHealthCheck(data.healthCheck, "Container config ssh.healthCheck"),
  };
}

export function readOutputFilters(value: unknown): lotusOutputFilterConfig | undefined {
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

export function readQemuConfig(value: unknown): lotusQemuConfig | undefined {
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
    healthCheck: readHealthCheck(data.healthCheck, "Container config qemu.healthCheck"),
    manager: readQemuManagerConfig(data.manager),
  };
}

export function readQemuManagerConfig(value: unknown): lotusQemuManagerConfig | undefined {
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

export function readCustomConfig(value: unknown): lotusCustomRuntimeConfig | undefined {
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
    healthCheck: readHealthCheck(data.healthCheck, "Container config custom.healthCheck"),
  };
}

export function readHealthCheck(value: unknown, label: string): lotusCommandExpectation | undefined {
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

export function requireQemuConfig(config: lotusContainerConfig): lotusQemuConfig {
  if (!config.qemu) {
    throw new Error("QEMU runtime requires a qemu config object.");
  }
  return config.qemu;
}

export function requireSshConfig(config: lotusContainerConfig): lotusRemoteConfig {
  if (!config.ssh) {
    throw new Error("SSH runtime requires an ssh config object.");
  }
  return config.ssh;
}

export function requireCustomConfig(config: lotusContainerConfig): lotusCustomRuntimeConfig {
  if (!config.custom) {
    throw new Error("Custom runtime requires a custom config object.");
  }
  return config.custom;
}

