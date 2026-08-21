import { normalizeVaultPath } from "./utils/vaultPath";
import { spawn, type ChildProcess } from "child_process";
import { dirname } from "path";
import { splitCommandLine } from "./utils/command";
import { sha256Hash } from "./utils/hash";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunResult } from "./types";
import type { lotusTimeoutMs } from "./utils/timeout";

export interface lotusLogInput {
  type: string;
  message?: string;
  notePath?: string;
  noteHash?: string;
  block?: lotusCodeBlock;
  target?: lotusLogTarget;
  data?: Record<string, unknown>;
  code?: string;
  stdin?: string;
  stdout?: string;
  stderr?: string;
  warning?: string;
  error?: string;
}

export interface lotusLogTarget {
  runnerId?: string;
  runnerName?: string;
  containerGroup?: string;
  workingDirectory?: string;
  timeoutMs?: lotusTimeoutMs;
  source?: Record<string, unknown>;
}

interface lotusLogEvent {
  version: 1;
  id: string;
  timestamp: string;
  type: string;
  machineHash: string;
  message?: string;
  note?: {
    name?: string;
    nameHash?: string;
    path?: string;
    pathHash?: string;
    contentHash?: string;
  };
  block?: {
    id: string;
    ordinal: number;
    language: string;
    alias: string;
    hash: string;
  };
  target?: lotusLogTarget;
  data?: Record<string, unknown>;
  code?: string;
  stdin?: string;
  stdout?: string;
  stderr?: string;
  warning?: string;
  error?: string;
  truncated?: boolean;
}

export interface lotusLogHost {
  vaultName: string;
  configDir: string;
  vaultBasePath: string | undefined;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  append(path: string, content: string): Promise<void>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
  postJson(url: string, headers: Record<string, string>, body: string): Promise<void>;
}

export class lotusLogger {
  private processChild: ChildProcess | null = null;
  private processCommand = "";

  constructor(
    private readonly host: lotusLogHost,
    private readonly getSettings: () => lotusPluginSettings,
  ) {}

  async log(input: lotusLogInput): Promise<void> {
    const settings = this.getSettings();
    if (!settings.loggingEnabled) {
      return;
    }

    const event = redactLogEvent(this.createEvent(input, settings), settings.loggingRedactionRules);
    const line = `${this.stringifyEvent(event, settings)}\n`;
    const tasks: Promise<void>[] = [];

    if (settings.loggingGlobalTextEnabled) {
      tasks.push(this.appendVaultText(settings.loggingGlobalTextPath, `${renderTextLogLine(event)}\n`));
    }
    if (settings.loggingGlobalJsonlEnabled) {
      tasks.push(this.appendVaultText(settings.loggingGlobalJsonlPath, line));
    }
    if (input.notePath && settings.loggingPerNoteTextEnabled) {
      tasks.push(this.appendVaultText(this.renderNoteLogPath(settings.loggingPerNoteTextPathPattern, input.notePath), `${renderTextLogLine(event)}\n`));
    }
    if (input.notePath && settings.loggingPerNoteJsonlEnabled) {
      tasks.push(this.appendVaultText(this.renderNoteLogPath(settings.loggingPerNoteJsonlPathPattern, input.notePath), line));
    }
    if (settings.loggingProcessEnabled && settings.loggingProcessCommand.trim()) {
      tasks.push(this.writeProcessSink(settings.loggingProcessCommand, line));
    }
    if (settings.loggingHttpEnabled && settings.loggingHttpEndpoint.trim()) {
      tasks.push(this.writeHttpSink(settings.loggingHttpEndpoint, event, settings.loggingHttpHeaders));
    }

    const results = await Promise.allSettled(tasks);
    for (const result of results) {
      if (result.status === "rejected") {
        console.warn("lotus logging sink failed", result.reason);
      }
    }
  }

  async logRunFinished(filePath: string, block: lotusCodeBlock, runnerName: string, result: lotusRunResult, data: Record<string, unknown> = {}, target?: lotusLogTarget, noteHash?: string): Promise<void> {
    await this.log({
      type: result.success ? "lotus.run.finished" : "lotus.run.failed",
      message: result.success ? "Code block finished" : "Code block failed",
      notePath: filePath,
      noteHash,
      block,
      target,
      data: {
        ...data,
        runnerId: result.runnerId,
        runnerName,
        success: result.success,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        timedOut: result.timedOut,
        cancelled: result.cancelled,
        stdoutBytes: result.stdout.length,
        stderrBytes: result.stderr.length,
        warningBytes: result.warning?.length ?? 0,
        displayCount: result.displays?.length ?? 0,
        displayMimeTypes: [...new Set(result.displays?.flatMap((display) => Object.keys(display.data)) ?? [])],
      },
      stdout: result.stdout,
      stderr: result.stderr,
      warning: result.warning,
    });
  }

  close(): void {
    this.processChild?.stdin?.end();
    this.processChild?.kill();
    this.processChild = null;
    this.processCommand = "";
  }

  private createEvent(input: lotusLogInput, settings: lotusPluginSettings): lotusLogEvent {
    const event: lotusLogEvent = {
      version: 1,
      id: createLogId(),
      timestamp: new Date().toISOString(),
      type: input.type,
      machineHash: this.createMachineHash(settings),
      message: input.message,
      data: input.data,
      error: input.error,
    };

    if (input.notePath) {
      event.note = this.formatNote(input.notePath, settings.loggingNotePathMode, input.noteHash);
    }
    event.target = input.target;
    if (input.block) {
      event.block = {
        id: input.block.id,
        ordinal: input.block.ordinal,
        language: input.block.language,
        alias: input.block.sourceLanguage || input.block.languageAlias,
        hash: sha256Hash(input.block.content),
      };
      if (settings.loggingIncludeCode) {
        event.code = input.code ?? input.block.content;
      }
    } else if (settings.loggingIncludeCode && input.code != null) {
      event.code = input.code;
    }

    if (settings.loggingIncludeInput && input.stdin != null) {
      event.stdin = input.stdin;
    }
    if (settings.loggingIncludeOutput) {
      event.stdout = input.stdout;
      event.stderr = input.stderr;
      event.warning = input.warning;
    }

    return event;
  }

  private createMachineHash(settings: lotusPluginSettings): string {
    switch (settings.loggingMachineHashScope) {
      case "vault":
        return sha256Hash(`vault:${this.host.vaultName}`);
      case "install-vault":
        return sha256Hash(JSON.stringify({
          installId: settings.loggingMachineId,
          vaultName: this.host.vaultName,
        }));
      case "install":
        return sha256Hash(settings.loggingMachineId);
    }
  }

  private stringifyEvent(event: lotusLogEvent, settings: lotusPluginSettings): string {
    let serialized = JSON.stringify(event);
    const maxBytes = normalizeMaxEventBytes(settings.loggingMaxEventBytes);
    if (!maxBytes || encodedLength(serialized) <= maxBytes) {
      return serialized;
    }

    const trimmed: lotusLogEvent = {
      ...event,
      code: undefined,
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      warning: undefined,
      truncated: true,
    };
    serialized = JSON.stringify(trimmed);
    if (encodedLength(serialized) <= maxBytes) {
      return serialized;
    }

    return JSON.stringify({
      version: trimmed.version,
      id: trimmed.id,
      timestamp: trimmed.timestamp,
      type: trimmed.type,
      message: trimmed.message,
      machineHash: trimmed.machineHash,
      note: trimmed.note,
      block: trimmed.block,
      target: trimmed.target,
      truncated: true,
    });
  }

  private formatNote(notePath: string, mode: lotusPluginSettings["loggingNotePathMode"], noteHash?: string): lotusLogEvent["note"] {
    const pathHash = sha256Hash(notePath);
    const noteName = notePath.split("/").pop() ?? notePath;
    const nameHash = sha256Hash(noteName);
    if (mode === "omit") {
      return { pathHash, nameHash, contentHash: noteHash };
    }
    if (mode === "plain") {
      return { name: noteName, nameHash, path: notePath, pathHash, contentHash: noteHash };
    }
    return { pathHash, nameHash, contentHash: noteHash };
  }

  private async appendVaultText(rawPath: string, content: string): Promise<void> {
    const path = normalizeVaultLogPath(this.host.configDir, rawPath);
    if (!path) {
      return;
    }

    await this.ensureVaultParentFolder(path);
    if (await this.host.exists(path)) {
      await this.host.append(path, content);
    } else {
      await this.host.write(path, content);
    }
  }

  private async ensureVaultParentFolder(path: string): Promise<void> {
    const folder = dirname(path);
    if (!folder || folder === ".") {
      return;
    }

    let current = "";
    for (const part of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.host.exists(current))) {
        await this.host.mkdir(current);
      }
    }
  }

  private renderNoteLogPath(pattern: string, notePath: string): string {
    const noteHash = sha256Hash(notePath);
    const noteName = notePath
      .replace(/\.[^/.]+$/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "__")
      .replace(/^_+|_+$/g, "")
      .slice(0, 160) || noteHash.slice(0, 16);
    return pattern
      .replaceAll("{note}", noteName)
      .replaceAll("{hash}", noteHash.slice(0, 16));
  }

  private async writeProcessSink(commandLine: string, line: string): Promise<void> {
    const child = this.ensureProcessSink(commandLine);
    const stdin = child?.stdin;
    if (!stdin || stdin.destroyed) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      stdin.write(line, (error) => error ? reject(error) : resolve());
    });
  }

  private ensureProcessSink(commandLine: string): ChildProcess | null {
    const command = commandLine.trim();
    if (!command) {
      return null;
    }

    if (this.processChild && this.processCommand === command && !this.processChild.killed) {
      return this.processChild;
    }

    this.close();
    const [executable, ...args] = splitCommandLine(command);
    if (!executable) {
      return null;
    }

    const child = spawn(executable, args, {
      cwd: this.host.vaultBasePath,
      stdio: ["pipe", "ignore", "pipe"],
      shell: false,
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString().trim();
      if (message) {
        console.warn(`lotus logging process stderr: ${message}`);
      }
    });
    child.on("error", (error) => {
      if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
        console.warn(`lotus logging process executable not found: ${executable}`);
        return;
      }
      console.warn("lotus logging process failed", error);
    });
    child.on("exit", () => {
      if (this.processChild === child) {
        this.processChild = null;
        this.processCommand = "";
      }
    });

    this.processChild = child;
    this.processCommand = command;
    return child;
  }

  private async writeHttpSink(endpoint: string, event: lotusLogEvent, rawHeaders: string): Promise<void> {
    await this.host.postJson(endpoint.trim(), parseHeaderJson(rawHeaders), JSON.stringify(event));
  }
}

function renderTextLogLine(event: lotusLogEvent): string {
  const note = event.note?.path ? ` note=${event.note.path}` : event.note?.pathHash ? ` noteHash=${event.note.pathHash.slice(0, 16)}` : "";
  const noteContent = event.note?.contentHash ? ` contentHash=${event.note.contentHash.slice(0, 16)}` : "";
  const block = event.block ? ` block=${event.block.ordinal}:${event.block.language}:${event.block.hash.slice(0, 12)}` : "";
  const machine = ` machine=${event.machineHash.slice(0, 16)}`;
  const target = event.target?.containerGroup
    ? ` target=${event.target.containerGroup}`
    : event.target?.runnerName ? ` target=${event.target.runnerName}` : "";
  const message = event.message ? ` ${event.message}` : "";
  const success = typeof event.data?.success === "boolean" ? ` success=${String(event.data.success)}` : "";
  const exit = event.data?.exitCode != null ? ` exit=${String(event.data.exitCode)}` : "";
  const duration = event.data?.durationMs != null ? ` durationMs=${String(event.data.durationMs)}` : "";
  return `${event.timestamp} ${event.type}${machine}${note}${noteContent}${block}${target}${success}${exit}${duration}${message}`;
}

function normalizeVaultLogPath(configDir: string, rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  const path = normalizeVaultPath(trimmed.startsWith("/") ? trimmed.slice(1) : trimmed);
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.includes("..") || path === configDir || path.startsWith(`${configDir}/`) || path === ".git" || path.startsWith(".git/")) {
    return null;
  }
  return path;
}

function parseHeaderJson(rawHeaders: string): Record<string, string> {
  const trimmed = rawHeaders.trim();
  if (!trimmed) {
    return {};
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  } catch {
    return {};
  }
}

interface lotusRedactionRule {
  pattern: RegExp;
  replacement: string;
}

function redactLogEvent(event: lotusLogEvent, rawRules: string): lotusLogEvent {
  const rules = parseRedactionRules(rawRules);
  if (!rules.length) {
    return event;
  }
  return redactValue(event, rules) as lotusLogEvent;
}

function redactValue(value: unknown, rules: lotusRedactionRule[]): unknown {
  if (typeof value === "string") {
    return redactString(value, rules);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry, rules));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [key, redactValue(entry, rules)]),
    );
  }
  return value;
}

function redactString(value: string, rules: lotusRedactionRule[]): string {
  let redacted = value;
  for (const rule of rules) {
    redacted = redacted.replace(rule.pattern, rule.replacement);
  }
  return redacted;
}

function parseRedactionRules(rawRules: string): lotusRedactionRule[] {
  return rawRules
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      const parsed = parseRedactionRule(line);
      return parsed ? [parsed] : [];
    });
}

function parseRedactionRule(line: string): lotusRedactionRule | null {
  const { pattern, replacement } = splitRedactionRule(line);
  if (!pattern) {
    return null;
  }

  if (pattern.startsWith("/")) {
    const lastSlash = pattern.lastIndexOf("/");
    if (lastSlash > 0) {
      try {
        const source = pattern.slice(1, lastSlash);
        const flags = normalizeRegexFlags(pattern.slice(lastSlash + 1));
        return { pattern: new RegExp(source, flags), replacement };
      } catch {
        return null;
      }
    }
  }

  return { pattern: new RegExp(escapeRegExp(pattern), "g"), replacement };
}

function splitRedactionRule(line: string): { pattern: string; replacement: string } {
  const separator = line.indexOf("=>");
  if (separator < 0) {
    return { pattern: line.trim(), replacement: "[redacted]" };
  }
  return {
    pattern: line.slice(0, separator).trim(),
    replacement: line.slice(separator + 2).trim() || "[redacted]",
  };
}

function normalizeRegexFlags(flags: string): string {
  const unique = new Set(flags.split("").filter((flag) => "dgimsuvy".includes(flag)));
  unique.add("g");
  return [...unique].join("");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function normalizeMaxEventBytes(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.max(1024, Math.floor(value));
}

function encodedLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function createLogId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

