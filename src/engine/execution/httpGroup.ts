
import type { lotusCodeBlock, lotusRunContext, lotusRunResult } from "../types";
import { lotusClearTimeout, lotusSetTimeout } from "../utils/timers";
import type { lotusTimeoutMs } from "../utils/timeout";
import type { lotusContainerConfig, lotusContainerLanguageConfig, lotusContainerRuntime } from "./containerConfig";
import { isRecord, normalizeExtension, optionalString } from "./configValues";

type lotusHttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";

type lotusHttpResponseMode = "auto" | "json" | "text";

interface lotusHttpStatusRange {
  min: number;
  max: number;
}

export interface lotusHttpConfig {
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

export function readHttpPath(parsed: unknown, path: string): unknown {
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

export function readHttpConfig(value: unknown, runtime: lotusContainerRuntime): lotusHttpConfig | undefined {
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

export async function runHttpGroup(
  groupName: string,
  config: lotusContainerConfig,
  block: lotusCodeBlock,
  language: lotusContainerLanguageConfig,
  tempFileName: string,
  context: lotusRunContext,
  requestUrlFn: lotusRequestUrl | undefined,
): Promise<lotusRunResult> {
  if (!requestUrlFn) {
    throw new Error("HTTP execution groups require Obsidian requestUrl.");
  }

  const http = requireHttpConfig(config);
  const templateContext = createHttpTemplateContext(groupName, block, language, tempFileName, context);
  const url = renderHttpTemplateString(http.url, templateContext);
  assertHttpUrl(url, `HTTP execution group ${groupName} url`);
  const headers = renderHttpHeaders(http.headers, templateContext);
  const body = createHttpRequestBody(http, templateContext, headers);
  const startedAt = new Date();
  const request = requestUrlFn({
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

export function requireHttpConfig(config: lotusContainerConfig): lotusHttpConfig {
  if (!config.http) {
    throw new Error("HTTP runtime requires an http config object.");
  }
  return config.http;
}

function readRequiredHttpPath(parsed: unknown, path: string, label: string): unknown {
  const value = readHttpPath(parsed, path);
  if (value === undefined) {
    throw new Error(`HTTP response ${label} did not resolve: ${path}`);
  }
  return value;
}

