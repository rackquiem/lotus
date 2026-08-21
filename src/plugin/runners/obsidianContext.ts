import { dirname } from "path";
import { Notice, TFile, normalizePath, type App } from "obsidian";
import type { lotusCodeBlock, lotusDisplayOutput, lotusDisplayRole, lotusPluginSettings, lotusRunContext, lotusRunResult, lotusRunner } from "../../engine/types";
import { formatTimeoutMs } from "../../engine/utils/timeout";
import { lotusClearTimeout, lotusSetTimeout, type LotusTimeoutHandle } from "../../engine/utils/timers";
import {
  CYTOSCAPE_MIME,
  ELK_MIME,
  LOTUS_CYTOSCAPE_MIME,
  LOTUS_D3_MIME,
  LOTUS_ELK_MIME,
  LOTUS_HWSCHEMATIC_MIME,
  LOTUS_JSXGRAPH_MIME,
  LOTUS_PLOTLY_MIME,
  PLOTLY_MIME,
} from "../visualization/javascriptGraphs";

const OBSIDIAN_CONTEXT_WARNING = "No but seriously, you are risking your life";

type AsyncUserFunction = (...args: unknown[]) => Promise<unknown>;
type AsyncFunctionConstructor = new (...args: string[]) => AsyncUserFunction;

const AsyncFunction = readAsyncFunctionConstructor();

interface ObsidianContextRunnerHost {
  app: App;
  plugin: unknown;
}

interface ObsidianContextNoteHelper {
  read(): Promise<string>;
  replace(transform: (text: string) => string): Promise<string>;
  replaceBetween(startMarker: string, endMarker: string, replacement: string | ((current: string) => string)): Promise<string>;
  updateJsonBetween(startMarker: string, endMarker: string, updater: (value: unknown) => unknown): Promise<unknown>;
  updateFrontmatter(updater: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  setFrontmatter(key: string, value: unknown): Promise<void>;
}

interface ObsidianContextDisplayOptions {
  title?: string;
  role?: lotusDisplayRole;
  alt?: string;
  width?: number;
  height?: number;
  mimeType?: string;
  metadata?: Record<string, unknown>;
}

interface ObsidianContextDisplayHelper {
  mime(data: Record<string, unknown>, options?: ObsidianContextDisplayOptions): void;
  svg(svg: string, options?: ObsidianContextDisplayOptions): void;
  graphviz(dot: string, options?: ObsidianContextDisplayOptions): void;
  png(data: string, options?: ObsidianContextDisplayOptions): void;
  jpeg(data: string, options?: ObsidianContextDisplayOptions): void;
  image(data: string, options?: ObsidianContextDisplayOptions): void;
  d3(spec: unknown, options?: ObsidianContextDisplayOptions): void;
  plotly(figure: unknown, options?: ObsidianContextDisplayOptions & { standardMime?: boolean }): void;
  jsxgraph(spec: unknown, options?: ObsidianContextDisplayOptions): void;
  elk(graph: unknown, options?: ObsidianContextDisplayOptions & { standardMime?: boolean }): void;
  hwschematic(graph: unknown, options?: ObsidianContextDisplayOptions): void;
  cytoscape(spec: unknown, options?: ObsidianContextDisplayOptions & { standardMime?: boolean }): void;
  jsonFile(path: string): Promise<unknown>;
  d3File(path: string, options?: ObsidianContextDisplayOptions): Promise<void>;
  plotlyFile(path: string, options?: ObsidianContextDisplayOptions & { standardMime?: boolean }): Promise<void>;
  jsxgraphFile(path: string, options?: ObsidianContextDisplayOptions): Promise<void>;
  elkFile(path: string, options?: ObsidianContextDisplayOptions & { standardMime?: boolean }): Promise<void>;
  hwschematicFile(path: string, options?: ObsidianContextDisplayOptions): Promise<void>;
  cytoscapeFile(path: string, options?: ObsidianContextDisplayOptions & { standardMime?: boolean }): Promise<void>;
}

export class ObsidianContextRunner implements lotusRunner {
  id = "obsidian-js";
  displayName = "Obsidian JavaScript";
  languages = ["obsidian-js"] as const;

  constructor(private readonly host: ObsidianContextRunnerHost) {}

  canRun(block: lotusCodeBlock, _settings: lotusPluginSettings): boolean {
    return block.language === "obsidian-js";
  }

  async run(block: lotusCodeBlock, context: lotusRunContext, _settings: lotusPluginSettings): Promise<lotusRunResult> {
    const startedAt = new Date();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const displays: lotusDisplayOutput[] = [];
    let exitCode: number | null = 0;
    let timedOut = false;
    let cancelled = false;
    let timeoutHandle: LotusTimeoutHandle | null = null;
    let abortHandler: (() => void) | null = null;

    try {
      const userFunction = new AsyncFunction(
        "app",
        "plugin",
        "file",
        "block",
        "Notice",
        "console",
        "note",
        "input",
        "display",
        `"use strict";\n${block.content}`,
      );
      const capturedConsole = createCapturedConsole(stdout, stderr);
      const file = context.file instanceof TFile ? context.file : null;
      if (!file) {
        throw new Error("Obsidian context blocks require an Obsidian note file.");
      }
      const note = createNoteHelper(this.host.app, file);
      const display = createDisplayHelper(this.host.app, file, displays);
      const execution = Promise.resolve(userFunction.call(
        this.host.plugin,
        this.host.app,
        this.host.plugin,
        file,
        block,
        Notice,
        capturedConsole,
        note,
        context.stdin ?? "",
        display,
      ));

      const timeoutMs = context.timeoutMs;
      const timeout = timeoutMs === null
        ? new Promise<never>(() => undefined)
        : new Promise<never>((_resolve, reject) => {
          timeoutHandle = lotusSetTimeout(() => {
            timedOut = true;
            reject(new Error(`Execution timed out after ${formatTimeoutMs(timeoutMs)}. Obsidian-context JavaScript cannot be force-killed once started.`));
          }, timeoutMs);
        });

      const abort = new Promise<never>((_resolve, reject) => {
        abortHandler = () => {
          cancelled = true;
          reject(new Error("Execution cancelled."));
        };
        if (context.signal.aborted) {
          abortHandler();
        } else {
          context.signal.addEventListener("abort", abortHandler, { once: true });
        }
      });

      const result = await Promise.race([execution, timeout, abort]);
      if (result !== undefined) {
        stdout.push(formatValue(result));
      }
    } catch (error) {
      exitCode = -1;
      stderr.push(formatError(error));
    } finally {
      if (timeoutHandle !== null) {
        lotusClearTimeout(timeoutHandle);
      }
      if (abortHandler) {
        context.signal.removeEventListener("abort", abortHandler);
      }
    }

    const finishedAt = new Date();
    const success = !timedOut && !cancelled && exitCode === 0;

    return {
      runnerId: this.id,
      runnerName: this.displayName,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      exitCode,
      stdout: joinStream(stdout),
      stderr: joinStream(stderr),
      success,
      timedOut,
      cancelled,
      warning: _settings.showObsidianContextWarning ? OBSIDIAN_CONTEXT_WARNING : undefined,
      ...(displays.length ? { displays } : {}),
    };
  }
}

function createNoteHelper(app: App, file: TFile): ObsidianContextNoteHelper {
  return {
    read: () => app.vault.cachedRead(file),
    replace: (transform) => app.vault.process(file, transform),
    replaceBetween: (startMarker, endMarker, replacement) =>
      app.vault.process(file, (text) => replaceMarkedContent(text, startMarker, endMarker, replacement)),
    updateJsonBetween: async (startMarker, endMarker, updater) => {
      let updatedValue: unknown;
      await app.vault.process(file, (text) =>
        replaceMarkedContent(text, startMarker, endMarker, (current) => {
          const parsed: unknown = current.trim() ? JSON.parse(current) : {};
          const next = updater(parsed);
          updatedValue = next === undefined ? parsed : next;
          return JSON.stringify(updatedValue, null, 2);
        }),
      );
      return updatedValue;
    },
    updateFrontmatter: (updater) =>
      app.fileManager.processFrontMatter(file, (frontmatter) => {
        updater(frontmatter as Record<string, unknown>);
      }),
    setFrontmatter: (key, value) =>
      app.fileManager.processFrontMatter(file, (frontmatter) => {
        (frontmatter as Record<string, unknown>)[key] = value;
      }),
  };
}

function readAsyncFunctionConstructor(): AsyncFunctionConstructor {
  const prototype: unknown = Object.getPrototypeOf(async function () {});
  if (prototype === null || typeof prototype !== "object") {
    throw new Error("Unable to access AsyncFunction constructor.");
  }
  const constructor = (prototype as { constructor?: unknown }).constructor;
  if (typeof constructor !== "function") {
    throw new Error("Unable to access AsyncFunction constructor.");
  }
  return constructor as AsyncFunctionConstructor;
}

function replaceMarkedContent(
  text: string,
  startMarker: string,
  endMarker: string,
  replacement: string | ((current: string) => string),
): string {
  const startIndex = text.indexOf(startMarker);
  if (startIndex < 0) {
    throw new Error(`Start marker not found: ${startMarker}`);
  }
  const startLineEnd = text.indexOf("\n", startIndex);
  const contentStart = startLineEnd < 0 ? startIndex + startMarker.length : startLineEnd + 1;
  const endIndex = text.indexOf(endMarker, contentStart);
  if (endIndex < 0) {
    throw new Error(`End marker not found: ${endMarker}`);
  }

  const currentRaw = text.slice(contentStart, endIndex);
  const keepTrailingNewline = currentRaw.endsWith("\n");
  const current = keepTrailingNewline ? currentRaw.slice(0, -1) : currentRaw;
  const next = typeof replacement === "function" ? replacement(current) : replacement;
  const nextRaw = keepTrailingNewline ? `${next.replace(/\n$/, "")}\n` : next;
  return `${text.slice(0, contentStart)}${nextRaw}${text.slice(endIndex)}`;
}

function createCapturedConsole(stdout: string[], stderr: string[]): Pick<Console, "debug" | "error" | "info" | "log" | "warn"> {
  return {
    debug: (...values: unknown[]) => stdout.push(formatConsoleLine(values)),
    error: (...values: unknown[]) => stderr.push(formatConsoleLine(values)),
    info: (...values: unknown[]) => stdout.push(formatConsoleLine(values)),
    log: (...values: unknown[]) => stdout.push(formatConsoleLine(values)),
    warn: (...values: unknown[]) => stderr.push(formatConsoleLine(values)),
  };
}

function createDisplayHelper(app: App, file: TFile, displays: lotusDisplayOutput[]): ObsidianContextDisplayHelper {
  const add = (data: Record<string, unknown>, options: ObsidianContextDisplayOptions = {}) => {
    const metadata = normalizeDisplayMetadata(options);
    displays.push({
      ...(options.title?.trim() ? { title: options.title.trim() } : {}),
      role: options.role ?? "result",
      data,
      ...(Object.keys(metadata).length ? { metadata } : {}),
    });
  };

  return {
    mime: (data, options = {}) => add(data, options),
    svg: (svg, options = {}) => add({
      "image/svg+xml": svg,
      "text/plain": options.alt ?? options.title ?? "SVG output",
    }, { ...options, role: options.role ?? "visualization" }),
    graphviz: (dot, options = {}) => add({
      "text/vnd.graphviz": dot,
      "text/plain": options.alt ?? options.title ?? "Graphviz DOT output",
    }, { ...options, role: options.role ?? "visualization" }),
    png: (data, options = {}) => add({
      "image/png": data,
      "text/plain": options.alt ?? options.title ?? "PNG output",
    }, { ...options, role: options.role ?? "visualization" }),
    jpeg: (data, options = {}) => add({
      "image/jpeg": data,
      "text/plain": options.alt ?? options.title ?? "JPEG output",
    }, { ...options, role: options.role ?? "visualization" }),
    image: (data, options = {}) => {
      const mimeType = options.mimeType ?? mimeTypeFromDataUri(data) ?? "image/png";
      add({
        [mimeType]: stripDataUriPrefix(data),
        "text/plain": options.alt ?? options.title ?? "Image output",
      }, { ...options, role: options.role ?? "visualization" });
    },
    d3: (spec, options = {}) => add({
      [LOTUS_D3_MIME]: spec,
      "text/plain": options.alt ?? options.title ?? "D3 display",
    }, { ...options, role: options.role ?? "visualization" }),
    plotly: (figure, options = {}) => add({
      [options.standardMime ? PLOTLY_MIME : LOTUS_PLOTLY_MIME]: figure,
      "text/plain": options.alt ?? options.title ?? "Plotly display",
    }, { ...options, role: options.role ?? "visualization" }),
    jsxgraph: (spec, options = {}) => add({
      [LOTUS_JSXGRAPH_MIME]: spec,
      "text/plain": options.alt ?? options.title ?? "JSXGraph display",
    }, { ...options, role: options.role ?? "visualization" }),
    elk: (graph, options = {}) => add({
      [options.standardMime ? ELK_MIME : LOTUS_ELK_MIME]: graph,
      "text/plain": options.alt ?? options.title ?? "ELK display",
    }, { ...options, role: options.role ?? "visualization" }),
    hwschematic: (graph, options = {}) => add({
      [LOTUS_HWSCHEMATIC_MIME]: graph,
      "text/plain": options.alt ?? options.title ?? "Hardware schematic display",
    }, { ...options, role: options.role ?? "visualization" }),
    cytoscape: (spec, options = {}) => add({
      [options.standardMime ? CYTOSCAPE_MIME : LOTUS_CYTOSCAPE_MIME]: spec,
      "text/plain": options.alt ?? options.title ?? "Cytoscape.js display",
    }, { ...options, role: options.role ?? "visualization" }),
    jsonFile: (path) => readDisplayJsonFile(app, file, path),
    d3File: async (path, options = {}) => add({
      [LOTUS_D3_MIME]: await readDisplayJsonFile(app, file, path),
      "text/plain": options.alt ?? options.title ?? "D3 display",
    }, { ...options, role: options.role ?? "visualization" }),
    plotlyFile: async (path, options = {}) => add({
      [options.standardMime ? PLOTLY_MIME : LOTUS_PLOTLY_MIME]: await readDisplayJsonFile(app, file, path),
      "text/plain": options.alt ?? options.title ?? "Plotly display",
    }, { ...options, role: options.role ?? "visualization" }),
    jsxgraphFile: async (path, options = {}) => add({
      [LOTUS_JSXGRAPH_MIME]: await readDisplayJsonFile(app, file, path),
      "text/plain": options.alt ?? options.title ?? "JSXGraph display",
    }, { ...options, role: options.role ?? "visualization" }),
    elkFile: async (path, options = {}) => add({
      [options.standardMime ? ELK_MIME : LOTUS_ELK_MIME]: await readDisplayJsonFile(app, file, path),
      "text/plain": options.alt ?? options.title ?? "ELK display",
    }, { ...options, role: options.role ?? "visualization" }),
    hwschematicFile: async (path, options = {}) => add({
      [LOTUS_HWSCHEMATIC_MIME]: await readDisplayJsonFile(app, file, path),
      "text/plain": options.alt ?? options.title ?? "Hardware schematic display",
    }, { ...options, role: options.role ?? "visualization" }),
    cytoscapeFile: async (path, options = {}) => add({
      [options.standardMime ? CYTOSCAPE_MIME : LOTUS_CYTOSCAPE_MIME]: await readDisplayJsonFile(app, file, path),
      "text/plain": options.alt ?? options.title ?? "Cytoscape.js display",
    }, { ...options, role: options.role ?? "visualization" }),
  };
}

async function readDisplayJsonFile(app: App, file: TFile, rawPath: string): Promise<unknown> {
  const path = resolveDisplayJsonPath(file, rawPath);
  if (!(await app.vault.adapter.exists(path))) {
    throw new Error(`Display JSON file not found: ${path}`);
  }
  return JSON.parse(await app.vault.adapter.read(path)) as unknown;
}

function resolveDisplayJsonPath(file: TFile, rawPath: string): string {
  const trimmed = rawPath.trim();
  if (!trimmed) {
    throw new Error("Display JSON file path is empty.");
  }
  if (trimmed.startsWith("/")) {
    return normalizePath(trimmed.slice(1));
  }
  const baseDir = dirname(file.path);
  return normalizePath(baseDir === "." ? trimmed : `${baseDir}/${trimmed}`);
}

function normalizeDisplayMetadata(options: ObsidianContextDisplayOptions): Record<string, unknown> {
  return {
    ...(options.metadata ?? {}),
    ...(options.alt ? { alt: options.alt } : {}),
    ...(Number.isFinite(options.width) ? { width: options.width } : {}),
    ...(Number.isFinite(options.height) ? { height: options.height } : {}),
  };
}

function mimeTypeFromDataUri(value: string): string | null {
  const match = value.match(/^data:([^;,]+)[;,]/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function stripDataUriPrefix(value: string): string {
  const commaIndex = value.indexOf(",");
  return value.startsWith("data:") && commaIndex >= 0 ? value.slice(commaIndex + 1) : value;
}

function formatConsoleLine(values: unknown[]): string {
  return values.map(formatValue).join(" ");
}

function formatValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "undefined") {
    return "undefined";
  }
  if (typeof value === "function") {
    return `[Function ${value.name || "anonymous"}]`;
  }
  if (value instanceof Error) {
    return value.stack || value.message;
  }
  try {
    const json = JSON.stringify(value, null, 2);
    return json ?? String(value);
  } catch {
    return String(value);
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.stack || error.message : formatValue(error);
}

function joinStream(lines: string[]): string {
  return lines.length ? `${lines.join("\n")}\n` : "";
}
