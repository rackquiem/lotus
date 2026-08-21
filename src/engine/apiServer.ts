import { normalizeVaultPath } from "./utils/vaultPath";
import { createHmac, createHash, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunResult, lotusStoredOutput } from "./types";

export interface lotusApiNote {
  path: string;
  title: string;
  block_count: number;
  updated_at: string;
}

export interface lotusApiBlock {
  id: string;
  note_path: string;
  ordinal: number;
  language: string;
  start_line: number;
  end_line: number;
  preview: string;
  status: "idle" | "running" | "succeeded" | "failed" | "cancelled";
  content?: string | null;
}

export interface lotusApiRun {
  id: string;
  block_id: string;
  note_path: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  runner_id: string;
  runner_name: string;
  started_at: string;
  finished_at: string | null;
  exit_code: number | null;
  duration_ms: number | null;
  stdout: string;
  stdout_language?: string | null;
  stdout_role?: "output" | "transpiled-source" | null;
  stderr: string;
  warning: string | null;
  displays?: number;
  artifacts?: number;
}

export interface lotusApiRunner {
  id: string;
  name: string;
  language: string;
  source: string;
  command: string | null;
  executable: string | null;
  available: boolean;
  message: string | null;
}

export interface lotusApiLogEvent {
  timestamp: string;
  type: string;
  message: string;
  note_path?: string;
  block_id?: string;
  raw: Record<string, unknown>;
}

export interface lotusApiHost {
  settings: lotusPluginSettings;
  manifest: { version: string };
  app: {
    vault: {
      getName(): string;
      configDir: string;
      adapter: {
        exists(path: string): Promise<boolean>;
        read(path: string): Promise<string>;
      };
    };
  };
  notify(message: string): void;
  listApiNotes(query?: string): Promise<lotusApiNote[]>;
  listApiBlocks(notePath: string): Promise<lotusApiBlock[]>;
  getApiBlock(blockId: string): Promise<lotusApiBlock | null>;
  updateApiBlockContent(blockId: string, content: string): Promise<lotusApiBlock | null>;
  listApiRunners(): Promise<lotusApiRunner[]>;
  runApiBlock(blockId: string, options?: { visualize?: boolean; writePolicy?: string }): Promise<lotusApiRun>;
  cancelApiRun(runId: string): Promise<lotusApiRun | null>;
  listApiRuns(): Promise<lotusApiRun[]>;
  getApiRun(runId: string): Promise<lotusApiRun | null>;
  listApiLogs(limit: number): Promise<lotusApiLogEvent[]>;
}

interface lotusApiKey {
  id: string;
  secret: string;
  name?: string;
}

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

export class lotusApiServer {
  private server: Server | null = null;
  private bound = "";

  constructor(private readonly host: lotusApiHost) {}

  async configure(): Promise<void> {
    if (!this.host.settings.apiEnabled) {
      await this.stop();
      return;
    }

    const desired = `${this.host.settings.apiHost}:${this.host.settings.apiPort}`;
    if (this.server && this.bound === desired) {
      return;
    }

    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return;
    }

    const server = this.server;
    this.server = null;
    this.bound = "";
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });

    const host = this.host.settings.apiHost;
    const port = this.host.settings.apiPort;
    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, host, () => resolve());
    });
    this.bound = `${host}:${port}`;
    this.host.notify(`Lotus API listening on http://${this.bound}/v1`);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      response.setHeader("content-type", "application/json; charset=utf-8");
      response.setHeader("cache-control", "no-store");

      if (request.method === "OPTIONS") {
        this.writeJson(response, 204, null);
        return;
      }

      const body = await readRequestBody(request);
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
      const auth = this.authorize(request, url, body);
      if (!auth.ok) {
        this.writeError(response, auth.status, auth.code, auth.message);
        return;
      }

      await this.route(request, response, url, body);
    } catch (error) {
      this.writeError(response, 500, "internal_error", error instanceof Error ? error.message : String(error));
    }
  }

  private async route(request: IncomingMessage, response: ServerResponse, url: URL, body: string): Promise<void> {
    const method = request.method ?? "GET";
    const path = url.pathname.replace(/\/+$/, "") || "/";

    if (method === "GET" && path === "/v1/health") {
      this.writeJson(response, 200, {
        status: "ok",
        version: this.host.manifest.version,
        vault_id: hashString(`vault:${this.host.app.vault.getName()}`).slice(0, 16),
        features: ["notes", "blocks", "block-detail", "block-edit", "runner-discovery", "runs", "logs", "signed-hmac-auth"],
      });
      return;
    }

    if (method === "GET" && path === "/v1/notes") {
      this.writeJson(response, 200, { notes: await this.host.listApiNotes(url.searchParams.get("query") ?? undefined) });
      return;
    }

    if (method === "GET" && path === "/v1/runners") {
      this.writeJson(response, 200, { runners: await this.host.listApiRunners() });
      return;
    }

    const noteBlocksMatch = path.match(/^\/v1\/notes\/(.+)\/blocks$/);
    if (method === "GET" && noteBlocksMatch) {
      this.writeJson(response, 200, { blocks: await this.host.listApiBlocks(decodeURIComponent(noteBlocksMatch[1])) });
      return;
    }

    const blockMatch = path.match(/^\/v1\/blocks\/([^/]+)$/);
    if (method === "GET" && blockMatch) {
      const block = await this.host.getApiBlock(decodeURIComponent(blockMatch[1]));
      if (!block) {
        this.writeError(response, 404, "not_found", "Block not found");
        return;
      }
      this.writeJson(response, 200, block);
      return;
    }

    if (method === "PUT" && blockMatch) {
      const payload = parseJsonObject(body);
      if (typeof payload.content !== "string") {
        this.writeError(response, 400, "bad_request", "Request body must include string field: content");
        return;
      }
      if (Buffer.byteLength(payload.content, "utf8") > MAX_BODY_BYTES) {
        this.writeError(response, 400, "bad_request", "Block content is too large");
        return;
      }
      const block = await this.host.updateApiBlockContent(decodeURIComponent(blockMatch[1]), payload.content);
      if (!block) {
        this.writeError(response, 404, "not_found", "Block not found");
        return;
      }
      this.writeJson(response, 200, block);
      return;
    }

    const runBlockMatch = path.match(/^\/v1\/blocks\/([^/]+)\/run$/);
    if (method === "POST" && runBlockMatch) {
      const payload = parseJsonObject(body);
      this.writeJson(response, 200, await this.host.runApiBlock(decodeURIComponent(runBlockMatch[1]), {
        visualize: payload.visualize === true,
        writePolicy: typeof payload.write_policy === "string" ? payload.write_policy : undefined,
      }));
      return;
    }

    if (method === "GET" && path === "/v1/runs") {
      this.writeJson(response, 200, { runs: await this.host.listApiRuns() });
      return;
    }

    const runMatch = path.match(/^\/v1\/runs\/([^/]+)$/);
    if (method === "GET" && runMatch) {
      const run = await this.host.getApiRun(decodeURIComponent(runMatch[1]));
      if (!run) {
        this.writeError(response, 404, "not_found", "Run not found");
        return;
      }
      this.writeJson(response, 200, run);
      return;
    }

    const cancelMatch = path.match(/^\/v1\/runs\/([^/]+)\/cancel$/);
    if (method === "POST" && cancelMatch) {
      const run = await this.host.cancelApiRun(decodeURIComponent(cancelMatch[1]));
      if (!run) {
        this.writeError(response, 404, "not_found", "Run not found");
        return;
      }
      this.writeJson(response, 200, run);
      return;
    }

    if (method === "GET" && path === "/v1/logs") {
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
      const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(500, rawLimit)) : 50;
      this.writeJson(response, 200, { events: await this.host.listApiLogs(limit) });
      return;
    }

    this.writeError(response, 404, "not_found", "Route not found");
  }

  private authorize(request: IncomingMessage, url: URL, body: string): { ok: true } | { ok: false; status: number; code: string; message: string } {
    const keys = parseApiKeys(this.host.settings.apiKeys);
    if (!keys.length) {
      return { ok: false, status: 503, code: "api_keys_missing", message: "Lotus API is enabled but no API keys are configured." };
    }

    const keyId = readHeader(request, "x-lotus-key-id");
    const timestamp = readHeader(request, "x-lotus-timestamp");
    const signature = normalizeSignature(readHeader(request, "x-lotus-signature"));
    if (!keyId || !timestamp || !signature) {
      return { ok: false, status: 401, code: "missing_signature", message: "Signed Lotus API headers are required." };
    }

    const key = keys.find((candidate) => candidate.id === keyId);
    if (!key) {
      return { ok: false, status: 401, code: "unknown_key", message: "Unknown Lotus API key id." };
    }

    if (!isFreshTimestamp(timestamp)) {
      return { ok: false, status: 401, code: "stale_signature", message: "Lotus API signature timestamp is outside the allowed clock window." };
    }

    const requestTarget = `${url.pathname}${url.search}`;
    const bodyHash = hashString(body);
    const payload = `${request.method ?? "GET"}\n${requestTarget}\n${timestamp}\n${bodyHash}`;
    const expected = createHmac("sha256", key.secret).update(payload).digest("hex");
    if (!safeEqual(signature, expected)) {
      return { ok: false, status: 401, code: "bad_signature", message: "Lotus API signature did not verify." };
    }

    return { ok: true };
  }

  private writeJson(response: ServerResponse, status: number, value: unknown): void {
    response.statusCode = status;
    response.end(value == null ? "" : JSON.stringify(value));
  }

  private writeError(response: ServerResponse, status: number, code: string, message: string): void {
    this.writeJson(response, status, { error: { code, message } });
  }
}

export function apiBlockFromCodeBlock(block: lotusCodeBlock, status: lotusApiBlock["status"], options: { includeContent?: boolean } = {}): lotusApiBlock {
  return {
    id: block.id,
    note_path: block.filePath,
    ordinal: block.ordinal,
    language: block.language,
    start_line: block.startLine + 1,
    end_line: block.endLine + 1,
    preview: block.content.trim().split(/\r?\n/).slice(0, 3).join("\n"),
    status,
    ...(options.includeContent ? { content: block.content } : {}),
  };
}

export function apiRunFromStoredOutput(output: lotusStoredOutput): lotusApiRun {
  return apiRunFromResult(output.block.id, output.block.filePath, output.result);
}

export function apiRunFromResult(blockId: string, notePath: string, result: lotusRunResult): lotusApiRun {
  return {
    id: blockId,
    block_id: blockId,
    note_path: notePath,
    status: result.cancelled ? "cancelled" : result.success ? "succeeded" : "failed",
    runner_id: result.runnerId,
    runner_name: result.runnerName,
    started_at: result.startedAt,
    finished_at: result.finishedAt,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    stdout: result.stdout,
    stdout_language: result.stdoutLanguage ?? null,
    stdout_role: result.stdoutRole ?? null,
    stderr: result.stderr,
    warning: result.warning ?? null,
    displays: result.displays?.length ?? 0,
    artifacts: result.artifacts?.length ?? 0,
  };
}

export function normalizeApiLogPath(configDir: string, path: string): string {
  const trimmed = path.trim();
  if (!trimmed) {
    return "";
  }
  return normalizeVaultPath(trimmed.startsWith("/") ? trimmed.slice(1) : trimmed.startsWith(configDir) ? trimmed : trimmed);
}

function parseApiKeys(raw: string): lotusApiKey[] {
  const trimmed = raw.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.flatMap((entry) => {
        if (!entry || typeof entry !== "object") {
          return [];
        }
        const record = entry as Record<string, unknown>;
        const id = typeof record.id === "string" ? record.id.trim() : "";
        const secret = typeof record.secret === "string" ? record.secret.trim() : "";
        const name = typeof record.name === "string" ? record.name.trim() : undefined;
        return id && secret ? [{ id, secret, name }] : [];
      });
    }
  } catch {
    // Fall back to line mode below.
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .flatMap((line) => {
      const [id, secret] = line.split(/[:=]/, 2).map((part) => part.trim());
      return id && secret ? [{ id, secret }] : [];
    });
}

function readHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function normalizeSignature(value: string): string {
  return value.trim().replace(/^sha256=/i, "").toLowerCase();
}

function isFreshTimestamp(value: string): boolean {
  const parsed = /^\d+$/.test(value)
    ? Number.parseInt(value, 10) * (value.length >= 13 ? 1 : 1000)
    : Date.parse(value);
  return Number.isFinite(parsed) && Math.abs(Date.now() - parsed) <= MAX_CLOCK_SKEW_MS;
}

function safeEqual(left: string, right: string): boolean {
  if (!/^[a-f0-9]+$/i.test(left) || !/^[a-f0-9]+$/i.test(right)) {
    return false;
  }
  const leftBuffer = Buffer.from(left, "hex");
  const rightBuffer = Buffer.from(right, "hex");
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function hashString(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseJsonObject(body: string): Record<string, unknown> {
  if (!body.trim()) {
    return {};
  }
  const parsed = JSON.parse(body) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = requestChunkToBuffer(chunk);
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      throw new Error("Request body is too large.");
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function requestChunkToBuffer(chunk: unknown): Buffer {
  if (Buffer.isBuffer(chunk)) {
    return chunk;
  }
  if (typeof chunk === "string" || chunk instanceof Uint8Array) {
    return Buffer.from(chunk);
  }
  throw new Error("Received an unsupported request body chunk.");
}

export async function readApiLogEvents(host: lotusApiHost, limit: number): Promise<lotusApiLogEvent[]> {
  const rawPath = host.settings.loggingViewerJsonlPath || host.settings.loggingGlobalJsonlPath;
  const path = normalizeApiLogPath(host.app.vault.configDir, rawPath);
  if (!path || !(await host.app.vault.adapter.exists(path))) {
    return [];
  }
  const lines = (await host.app.vault.adapter.read(path)).split(/\r?\n/).filter((line) => line.trim()).slice(-limit);
  return lines.flatMap((line) => {
    try {
      const raw = JSON.parse(line) as Record<string, unknown>;
      const note = readRecord(raw.note);
      const block = readRecord(raw.block);
      return [{
        timestamp: readString(raw.timestamp),
        type: readString(raw.type),
        message: readString(raw.message),
        note_path: readString(note.path) || undefined,
        block_id: readString(block.id) || undefined,
        raw,
      }];
    } catch {
      return [];
    }
  }).reverse();
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}
