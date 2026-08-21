
import JSZip from "jszip";
import { dirname, join } from "path";
import { normalizeSyntaxLanguage } from "./syntaxLanguage";
import { normalizeVaultPath } from "./utils/vaultPath";
import { isRecord } from "./utils/record";
import type { lotusCustomPreprocessor, lotusExternalLanguage, lotusExternalLanguagePack } from "./types";

export const LANGUAGE_PACK_MANIFEST_NAMES = new Set(["lotus-language-pack.json", "language-pack.json", "manifest.json"]);

interface lotusArchiveEntry {
  path: string;
  data: Uint8Array;
}

export async function readLanguageBundleArchive(file: File): Promise<lotusArchiveEntry[]> {
  const lowerName = file.name.toLowerCase();
  const bytes = new Uint8Array(await file.arrayBuffer());

  if (lowerName.endsWith(".zip")) {
    return readZipBundle(bytes);
  }
  if (lowerName.endsWith(".tar")) {
    return readTarBundle(bytes);
  }
  if (lowerName.endsWith(".tgz") || lowerName.endsWith(".tar.gz")) {
    return readTarBundle(new Uint8Array(await gunzipBytes(bytes)));
  }

  throw new Error("Language bundle must be a .zip, .tar, .tgz, or .tar.gz archive.");
}

async function readZipBundle(bytes: Uint8Array): Promise<lotusArchiveEntry[]> {
  const zip = await JSZip.loadAsync(bytes);
  const entries: lotusArchiveEntry[] = [];

  for (const entry of Object.values(zip.files)) {
    if (entry.dir) {
      continue;
    }
    entries.push({
      path: entry.name,
      data: await entry.async("uint8array"),
    });
  }

  return entries;
}

function readTarBundle(bytes: Uint8Array): lotusArchiveEntry[] {
  const entries: lotusArchiveEntry[] = [];
  let offset = 0;

  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512);
    if (header.every((byte) => byte === 0)) {
      break;
    }

    const name = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    const path = prefix ? `${prefix}/${name}` : name;
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 48);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;

    if (!Number.isFinite(size) || size < 0 || dataEnd > bytes.length) {
      throw new Error("Invalid tar archive entry size.");
    }

    if (type === "0" || type === "\0") {
      entries.push({ path, data: bytes.slice(dataStart, dataEnd) });
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  return entries;
}

async function gunzipBytes(bytes: Uint8Array): Promise<ArrayBuffer> {
  const Decompression = typeof DecompressionStream === "undefined" ? undefined : DecompressionStream;
  if (!Decompression) {
    throw new Error("This Obsidian runtime cannot decompress tar.gz bundles. Use .zip or .tar instead.");
  }

  const stream = new Blob([toArrayBuffer(bytes)]).stream().pipeThrough(new Decompression("gzip"));
  return new Response(stream).arrayBuffer();
}

export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function readTarString(bytes: Uint8Array, offset: number, length: number): string {
  const end = bytes.indexOf(0, offset);
  const sliceEnd = end >= offset && end < offset + length ? end : offset + length;
  return new TextDecoder().decode(bytes.slice(offset, sliceEnd)).trim();
}

export function normalizeBundleEntries(entries: lotusArchiveEntry[], fileName: string): lotusArchiveEntry[] {
  const cleaned = entries
    .map((entry) => ({
      path: normalizeArchivePath(entry.path),
      data: entry.data,
    }))
    .filter((entry): entry is lotusArchiveEntry => Boolean(entry.path));

  const stripped = stripCommonArchiveRoot(cleaned);
  if (!stripped.length) {
    throw new Error(`Language bundle ${fileName} did not contain any usable files.`);
  }
  return stripped;
}

function normalizeArchivePath(path: string): string {
  const normalized = normalizeVaultPath(path.replace(/\\/g, "/")).replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length || parts[0] === "__MACOSX" || parts[parts.length - 1] === ".DS_Store") {
    return "";
  }
  if (parts.some((part) => part === "." || part === ".." || part.includes("\0") || /^[a-zA-Z]:$/.test(part))) {
    throw new Error(`Invalid bundle path: ${path}`);
  }
  return parts.join("/");
}

function stripCommonArchiveRoot(entries: lotusArchiveEntry[]): lotusArchiveEntry[] {
  const roots = entries.map((entry) => entry.path.split("/"));
  if (!roots.length || roots.some((parts) => parts.length < 2)) {
    return entries;
  }

  const root = roots[0][0];
  if (!roots.every((parts) => parts[0] === root)) {
    return entries;
  }

  return entries.map((entry) => ({
    path: entry.path.split("/").slice(1).join("/"),
    data: entry.data,
  }));
}

export function findBundleManifest(entries: lotusArchiveEntry[]): lotusArchiveEntry | null {
  const named = entries.find((entry) => isBundleManifestCandidate(entry) && readBundleManifest(entry));
  if (named) {
    return named;
  }

  return entries.find((entry) => {
    if (entry.path.includes("/") || !isBundleManifestCandidate(entry)) {
      return false;
    }
    return Boolean(readBundleManifest(entry));
  }) ?? null;
}

function isBundleManifestCandidate(entry: lotusArchiveEntry): boolean {
  const fileName = entry.path.split("/").pop()?.toLowerCase() ?? "";
  return LANGUAGE_PACK_MANIFEST_NAMES.has(fileName) || !entry.path.includes("/") && fileName.endsWith(".json");
}

export function readBundleManifest(entry: lotusArchiveEntry): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(entry.data));
    return isRecord(parsed) && typeof parsed.id === "string" && Array.isArray(parsed.languages) ? parsed : null;
  } catch {
    return null;
  }
}

export function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

export function parseExternalLanguagePack(value: unknown, filePath: string, vaultBasePath: string): lotusExternalLanguagePack | null {
  if (!isRecord(value)) {
    console.warn(`Ignoring lotus language pack ${filePath}: manifest must be an object`);
    return null;
  }

  const rawId = readString(value.id);
  const id = normalizeManifestId(rawId);
  if (!id) {
    console.warn(`Ignoring lotus language pack ${filePath}: missing package id`);
    return null;
  }
  if (!Array.isArray(value.languages)) {
    console.warn(`Ignoring lotus language pack ${filePath}: languages must be an array`);
    return null;
  }

  const languages = value.languages
    .map((language) => parseExternalLanguage(language, filePath, vaultBasePath))
    .filter((language): language is lotusExternalLanguage => Boolean(language));
  if (!languages.length) {
    console.warn(`Ignoring lotus language pack ${filePath}: no valid languages`);
    return null;
  }

  return {
    id: `external:${id}`,
    displayName: readString(value.displayName) || rawId,
    description: readString(value.description) || `External language pack from ${filePath}`,
    languages,
  };
}

function parseExternalLanguage(value: unknown, filePath: string, vaultBasePath: string): lotusExternalLanguage | null {
  if (!isRecord(value)) {
    console.warn(`Ignoring language entry in ${filePath}: entry must be an object`);
    return null;
  }

  const rawName = readString(value.id) || readString(value.name);
  const name = normalizeManifestId(rawName);
  const executable = readString(value.executable);
  if (!name || !executable) {
    console.warn(`Ignoring language entry in ${filePath}: language id/name and executable are required`);
    return null;
  }

  return {
    name,
    displayName: readString(value.displayName) || rawName,
    description: readString(value.description),
    aliases: readAliasList(value.aliases, name).join(", "),
    mode: readString(value.mode) === "transpile" ? "transpile" : "execute",
    highlightLanguage: normalizeManifestLanguageReference(
      readString(value.highlightLanguage)
      || readString(value.highlight)
      || readString(value.highlighting),
    ),
    targetLanguage: normalizeManifestLanguageReference(
      readString(value.targetLanguage)
      || readString(value.target),
    ),
    executable,
    args: readString(value.args) || "{file}",
    extension: normalizeExtension(readString(value.extension), name),
    outputMode: readString(value.outputMode) === "file" ? "file" : "streams",
    outputExtension: normalizeExtension(readString(value.outputExtension), "out"),
    displayOutput: readDisplayOutputMode(value.displayOutput),
    displayMimeType: normalizeDisplayMimeType(readString(value.displayMimeType) || readString(value.displayMime) || readString(value.mimeType)),
    displayTitle: readString(value.displayTitle) || readString(value.title),
    displayRole: readDisplayRole(readString(value.displayRole) || readString(value.role)),
    displayHeight: readPositiveNumber(value.displayHeight ?? value.height),
    packageDirectory: resolveManifestDirectory(filePath, vaultBasePath),
    preprocessors: readPreprocessorList(value.preprocessors, filePath),
    preprocessorExecutable: readString(value.preprocessorExecutable),
    preprocessorArgs: readString(value.preprocessorArgs) || "{request}",
    preprocessorLanguage: normalizeManifestId(readString(value.preprocessorLanguage)),
    preprocessorExtension: readString(value.preprocessorExtension),
    extractorMode: readString(value.extractorMode) === "transpile-c" ? "transpile-c" : "command",
    extractorExecutable: readString(value.extractorExecutable),
    extractorArgs: readString(value.extractorArgs) || "{request}",
    transpileExecutable: readString(value.transpileExecutable),
    transpileArgs: readString(value.transpileArgs) || "{request}",
  };
}

function readPreprocessorList(value: unknown, filePath: string): lotusCustomPreprocessor[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((stage, index) => readPreprocessorStage(stage, index, filePath))
    .filter((stage): stage is lotusCustomPreprocessor => Boolean(stage));
}

function readPreprocessorStage(value: unknown, index: number, filePath: string): lotusCustomPreprocessor | null {
  if (!isRecord(value)) {
    console.warn(`Ignoring preprocessor stage ${index + 1} in ${filePath}: stage must be an object`);
    return null;
  }

  const executable = readString(value.executable);
  if (!executable) {
    console.warn(`Ignoring preprocessor stage ${index + 1} in ${filePath}: executable is required`);
    return null;
  }

  const rawName = readString(value.id) || readString(value.name) || `stage-${index + 1}`;
  return {
    name: normalizeManifestId(rawName) || `stage-${index + 1}`,
    executable,
    args: readString(value.args) || "{request}",
    language: normalizeManifestId(readString(value.language)),
    extension: readString(value.extension),
  };
}

export function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function resolveManifestDirectory(filePath: string, vaultBasePath: string): string {
  const directory = dirname(filePath);
  if (!vaultBasePath) {
    return directory;
  }
  return join(vaultBasePath, directory);
}

function readDisplayOutputMode(value: unknown): "none" | "copy-stdout" | "replace-stdout" {
  const normalized = readString(value).toLowerCase();
  if (normalized === "copy" || normalized === "copy-stdout" || normalized === "stdout") {
    return "copy-stdout";
  }
  if (normalized === "replace" || normalized === "replace-stdout" || normalized === "display") {
    return "replace-stdout";
  }
  return "none";
}

function normalizeDisplayMimeType(value: string): string {
  const normalized = value.trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+(?:\+[a-z0-9!#$&^_.+-]+)?$/.test(normalized) ? normalized : "";
}

function readDisplayRole(value: string): "result" | "visualization" | "diagnostic" | "artifact" | undefined {
  if (value === "result" || value === "visualization" || value === "diagnostic" || value === "artifact") {
    return value;
  }
  return undefined;
}

function readAliasList(value: unknown, name: string): string[] {
  const aliases = Array.isArray(value)
    ? value.flatMap((alias) => readString(alias).split(","))
    : readString(value).split(",");
  return aliases
    .map((alias) => normalizeManifestId(alias))
    .filter((alias, index, list) => Boolean(alias) && alias !== name && list.indexOf(alias) === index);
}

export function normalizeManifestId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

function normalizeManifestLanguageReference(value: string): string {
  return normalizeSyntaxLanguage(value) ?? "";
}

function normalizeExtension(value: string, name: string): string {
  if (!value) {
    return `.${name}`;
  }
  return value.startsWith(".") ? value : `.${value}`;
}
