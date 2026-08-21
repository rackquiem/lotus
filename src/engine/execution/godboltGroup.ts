
import type { lotusCodeBlock, lotusPluginSettings, lotusRunContext, lotusRunResult } from "../types";
import { lotusClearTimeout, lotusSetTimeout } from "../utils/timers";
import type { lotusTimeoutMs } from "../utils/timeout";
import { DEFAULT_GODBOLT_COMPILER_DEFAULTS, DEFAULT_GODBOLT_OPTIONS_DEFAULTS } from "../defaultSettings";
import { isRecord, optionalString } from "./configValues";
import type { lotusRequestUrl } from "./httpGroup";

export const BUILT_IN_GODBOLT_GROUP = "godbolt";

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

export function isBuiltInGodboltGroup(groupName: string): boolean {
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
      (error: unknown) => finish(() => reject(error instanceof Error ? error : new Error(String(error)))),
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

export async function runGodboltGroup(
  block: lotusCodeBlock,
  context: lotusRunContext,
  settings: lotusPluginSettings,
  requestUrlFn: lotusRequestUrl | undefined,
  compilerCache: Map<string, string | null>,
): Promise<lotusRunResult> {
  const startedAt = new Date();
  const language = readGodboltLanguage(block);
  const baseUrl = readGodboltBaseUrl(block);
  const clientState = await createGodboltClientState(block, language, settings, baseUrl, context.timeoutMs, context.signal, requestUrlFn, compilerCache);
  const url = await postGodboltShortlink(clientState, baseUrl, context.timeoutMs, context.signal, requestUrlFn);
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
