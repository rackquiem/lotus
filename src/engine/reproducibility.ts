import { parseMarkdownCodeBlocks } from "./parser";
import { sha256Hash } from "./utils/hash";
import type { lotusCodeBlock, lotusPluginSettings } from "./types";

type lotusYamlParser = (yaml: string) => unknown;

let parseYaml: lotusYamlParser = () => {
  throw new Error("Lotus reproducibility requires a YAML parser. Call setFrontmatterYamlParser() first.");
};

export function setFrontmatterYamlParser(parser: lotusYamlParser): void {
  parseYaml = parser;
}
export const NOTE_HASH_FRONTMATTER_KEY = "lotus-note-hash";
export const CODE_BLOCK_HASHES_FRONTMATTER_KEY = "lotus-code-block-hashes";
export const SIGNATURE_FRONTMATTER_KEY = "lotus-signature";
export const REPRODUCIBILITY_FRONTMATTER_KEY = "lotus-reproducibility";
export const HASH_POLICY_FRONTMATTER_KEY = "lotus-hash-policy";
export const HASH_IGNORE_FRONTMATTER_KEY = "lotus-hash-ignore-frontmatter";
export const HASH_IGNORE_BLOCK_ATTRIBUTES_KEY = "lotus-hash-ignore-block-attributes";
export const REPRODUCIBILITY_SNAPSHOT_VERSION = 1;

const LOTUS_HASH_FRONTMATTER_KEYS = new Set([NOTE_HASH_FRONTMATTER_KEY, CODE_BLOCK_HASHES_FRONTMATTER_KEY, SIGNATURE_FRONTMATTER_KEY]);

export type lotusHashPolicyPreset = "strict" | "runtime-flexible" | "runtime-inputs" | "runtime-inputs-outputs" | "custom";
export type lotusReproducibilityStatus = "verified" | "changed" | "missing-snapshot";

export interface lotusHashPolicy {
  preset: lotusHashPolicyPreset;
  ignoreFrontmatter: string[];
  ignoreBlockAttributes: string[];
}

export interface lotusHashPolicyPresetDefinition {
  id: Exclude<lotusHashPolicyPreset, "custom">;
  label: string;
  description: string;
  ignoreFrontmatter: string[];
  ignoreBlockAttributes: string[];
}

export interface lotusCodeBlockHashEntry {
  id: string;
  ordinal: number;
  language: string;
  alias: string;
  hash: string;
  startLine: number;
  endLine: number;
}

export interface lotusReproducibilityVerification {
  status: lotusReproducibilityStatus;
  checkedAt: string;
  summary: string;
  issues: string[];
  note: {
    status: "verified" | "changed" | "missing";
    storedHash: string;
    currentHash: string;
  };
  blocks: {
    verified: number;
    total: number;
    issues: string[];
  };
}

export interface lotusReproducibilitySnapshot {
  version: number;
  updatedAt: string;
  noteHash: string;
  policy: ReturnType<typeof serializeHashPolicy>;
  blocks: lotusCodeBlockHashEntry[];
  verification?: lotusReproducibilityVerification;
}

export interface lotusSignaturePayload {
  version: 1;
  scope: "note";
  noteHash: string;
  policy: ReturnType<typeof serializeHashPolicy>;
  blocks: lotusCodeBlockHashEntry[];
}

export const HASH_POLICY_PRESETS: lotusHashPolicyPresetDefinition[] = [
  {
    id: "strict",
    label: "Strict",
    description: "Any note, execution, input, or output metadata change invalidates the snapshot.",
    ignoreFrontmatter: [],
    ignoreBlockAttributes: [],
  },
  {
    id: "runtime-flexible",
    label: "Runtime Flexible",
    description: "Allow execution target, working directory, and timeout changes while locking code and prose.",
    ignoreFrontmatter: ["lotus-execution", "lotus-container", "lotus-cwd", "lotus-working-directory", "lotus-timeout"],
    ignoreBlockAttributes: ["lotus-execution", "execution", "lotus-container", "container", "lotus-cwd", "cwd", "working-directory", "lotus-timeout", "timeout"],
  },
  {
    id: "runtime-inputs",
    label: "Runtime + Inputs",
    description: "Allow runtime fields plus stdin/input wiring changes.",
    ignoreFrontmatter: ["lotus-execution", "lotus-container", "lotus-cwd", "lotus-working-directory", "lotus-timeout"],
    ignoreBlockAttributes: ["lotus-execution", "execution", "lotus-container", "container", "lotus-cwd", "cwd", "working-directory", "lotus-timeout", "timeout", "lotus-stdin", "stdin", "lotus-stdin-file", "stdin-file", "lotus-input", "input"],
  },
  {
    id: "runtime-inputs-outputs",
    label: "Runtime + Inputs + Outputs",
    description: "Allow runtime, stdin/input, and output destination plumbing changes.",
    ignoreFrontmatter: ["lotus-execution", "lotus-container", "lotus-cwd", "lotus-working-directory", "lotus-timeout"],
    ignoreBlockAttributes: ["lotus-execution", "execution", "lotus-container", "container", "lotus-cwd", "cwd", "working-directory", "lotus-timeout", "timeout", "lotus-stdin", "stdin", "lotus-stdin-file", "stdin-file", "lotus-input", "input", "lotus-output-file", "output-file", "lotus-output-file-mode", "output-file-mode", "lotus-output-file-format", "output-file-format", "lotus-output-file-streams", "output-file-streams", "lotus-output-append", "output-append", "lotus-output-lines", "output-lines"],
  },
];

export function createReproducibilitySnapshot(filePath: string, source: string, settings?: lotusPluginSettings): lotusReproducibilitySnapshot {
  const policy = readHashPolicy(source);
  const blocks = parseMarkdownCodeBlocks(filePath, source, settings)
    .map((block) => createCodeBlockHashEntry(block, policy));
  return {
    version: REPRODUCIBILITY_SNAPSHOT_VERSION,
    updatedAt: new Date().toISOString(),
    noteHash: sha256Hash(canonicalizeNoteForHash(source)),
    policy: serializeHashPolicy(policy),
    blocks,
  };
}

export function createSignaturePayload(snapshot: lotusReproducibilitySnapshot): lotusSignaturePayload {
  return {
    version: 1,
    scope: "note",
    noteHash: snapshot.noteHash,
    policy: snapshot.policy,
    blocks: snapshot.blocks,
  };
}

export function createCodeBlockHashEntry(block: lotusCodeBlock, policy: lotusHashPolicy): lotusCodeBlockHashEntry {
  return {
    id: block.id,
    ordinal: block.ordinal,
    language: block.language,
    alias: block.sourceLanguage || block.languageAlias,
    hash: sha256Hash(stableStringify({
      language: block.language,
      sourceLanguage: block.sourceLanguage,
      attributes: filterHashPolicyAttributes(block.attributes, policy),
      content: block.content,
    })),
    startLine: block.startLine + 1,
    endLine: block.endLine + 1,
  };
}

export function canonicalizeNoteForHash(source: string): string {
  const policy = readHashPolicy(source);
  const frontmatter = splitFrontmatter(source);
  const canonicalBody = canonicalizeFenceInfoForHash(frontmatter?.body ?? source, policy);
  if (!frontmatter) {
    return canonicalBody;
  }

  const parsed = parseFrontmatterRecord(frontmatter.yaml);
  const canonicalFrontmatter = Object.fromEntries(
    Object.keys(parsed)
      .sort()
      .filter((key) => !shouldIgnoreFrontmatterKey(key, policy))
      .map((key) => [key, parsed[key]]),
  );

  return stableStringify({
    frontmatter: canonicalFrontmatter,
    body: canonicalBody,
  });
}

export function readHashPolicy(source: string): lotusHashPolicy {
  const frontmatter = splitFrontmatter(source);
  const parsed = frontmatter ? parseFrontmatterRecord(frontmatter.yaml) : {};
  const rawPolicy = parsed[HASH_POLICY_FRONTMATTER_KEY];
  const nestedPolicy = isRecord(rawPolicy) ? rawPolicy : {};
  const presetId = readHashPolicyPreset(typeof rawPolicy === "string" ? rawPolicy : readString(nestedPolicy.preset));
  const basePolicy = hashPolicyFromPreset(presetId ?? "strict");
  const policy = {
    preset: presetId ?? basePolicy.preset,
    ignoreFrontmatter: normalizePolicyList([
      ...basePolicy.ignoreFrontmatter,
      ...readStringList(parsed[HASH_IGNORE_FRONTMATTER_KEY]),
      ...readStringList(nestedPolicy["ignore-frontmatter"] ?? nestedPolicy.ignoreFrontmatter ?? nestedPolicy.frontmatter),
    ]),
    ignoreBlockAttributes: normalizePolicyList([
      ...basePolicy.ignoreBlockAttributes,
      ...readStringList(parsed[HASH_IGNORE_BLOCK_ATTRIBUTES_KEY]),
      ...readStringList(nestedPolicy["ignore-block-attributes"] ?? nestedPolicy.ignoreBlockAttributes ?? nestedPolicy.blockAttributes),
    ]),
  };
  const matchedPreset = matchHashPolicyPreset(policy);

  return {
    ...policy,
    preset: matchedPreset ?? "custom",
  };
}

export function readStoredNoteHash(source: string): string | null {
  const frontmatter = splitFrontmatter(source);
  if (!frontmatter) {
    return null;
  }
  const parsed = parseFrontmatterRecord(frontmatter.yaml);
  const snapshot = isRecord(parsed[REPRODUCIBILITY_FRONTMATTER_KEY]) ? parsed[REPRODUCIBILITY_FRONTMATTER_KEY] : null;
  const value = snapshot?.noteHash ?? parsed[NOTE_HASH_FRONTMATTER_KEY];
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value.trim()) ? value.trim().toLowerCase() : null;
}

export function readReproducibilityFrontmatter(source: string): Record<string, unknown> | null {
  const frontmatter = splitFrontmatter(source);
  if (!frontmatter) {
    return null;
  }
  const value = parseFrontmatterRecord(frontmatter.yaml)[REPRODUCIBILITY_FRONTMATTER_KEY];
  return isRecord(value) ? value : null;
}

export function readStoredSignatureValue(source: string): unknown {
  const frontmatter = splitFrontmatter(source);
  if (!frontmatter) {
    return null;
  }
  return parseFrontmatterRecord(frontmatter.yaml)[SIGNATURE_FRONTMATTER_KEY] ?? null;
}

export function readStoredCodeBlockHashEntries(source: string): lotusCodeBlockHashEntry[] {
  const frontmatter = splitFrontmatter(source);
  if (!frontmatter) {
    return [];
  }
  const parsed = parseFrontmatterRecord(frontmatter.yaml);
  const snapshot = isRecord(parsed[REPRODUCIBILITY_FRONTMATTER_KEY]) ? parsed[REPRODUCIBILITY_FRONTMATTER_KEY] : null;
  const value = snapshot?.blocks ?? parsed[CODE_BLOCK_HASHES_FRONTMATTER_KEY];
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map(readStoredCodeBlockHashEntry)
    .filter((entry): entry is lotusCodeBlockHashEntry => Boolean(entry));
}

export function serializeHashPolicy(policy: lotusHashPolicy): { preset: lotusHashPolicyPreset; "ignore-frontmatter": string[]; "ignore-block-attributes": string[] } {
  return {
    preset: policy.preset,
    "ignore-frontmatter": [...policy.ignoreFrontmatter],
    "ignore-block-attributes": [...policy.ignoreBlockAttributes],
  };
}

export function compareCodeBlockHashEntries(storedEntries: lotusCodeBlockHashEntry[], currentEntries: lotusCodeBlockHashEntry[]): { verified: number; issues: string[] } {
  const storedByOrdinal = new Map(storedEntries.map((entry) => [entry.ordinal, entry]));
  const currentByOrdinal = new Map(currentEntries.map((entry) => [entry.ordinal, entry]));
  let verified = 0;
  const issues: string[] = [];

  for (const current of currentEntries) {
    const stored = storedByOrdinal.get(current.ordinal);
    if (!stored) {
      issues.push(`block #${current.ordinal} missing stored hash`);
      continue;
    }
    if (stored.hash !== current.hash || stored.language !== current.language) {
      issues.push(`block #${current.ordinal} changed`);
      continue;
    }
    verified += 1;
  }

  for (const stored of storedEntries) {
    if (!currentByOrdinal.has(stored.ordinal)) {
      issues.push(`block #${stored.ordinal} stored hash has no current block`);
    }
  }

  return { verified, issues };
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableStringify(entry)).join(",")}]`;
  }
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function readStoredCodeBlockHashEntry(value: unknown): lotusCodeBlockHashEntry | null {
  if (!isRecord(value)) {
    return null;
  }

  const ordinal = readPositiveNumber(value.ordinal);
  const startLine = readPositiveNumber(value.startLine);
  const endLine = readPositiveNumber(value.endLine);
  const hash = typeof value.hash === "string" ? value.hash.trim().toLowerCase() : "";
  const language = typeof value.language === "string" ? value.language.trim() : "";
  if (!ordinal || !startLine || !endLine || !/^[a-f0-9]{64}$/i.test(hash) || !language) {
    return null;
  }

  return {
    id: typeof value.id === "string" ? value.id.trim() : "",
    ordinal,
    language,
    alias: typeof value.alias === "string" ? value.alias.trim() : language,
    hash,
    startLine,
    endLine,
  };
}

function readPositiveNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : Number.NaN;
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function splitFrontmatter(source: string): { yaml: string; body: string } | null {
  const lines = source.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return null;
  }

  let frontmatterEnd = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "---") {
      frontmatterEnd = i;
      break;
    }
  }
  if (frontmatterEnd < 0) {
    return null;
  }

  return {
    yaml: lines.slice(1, frontmatterEnd).join("\n"),
    body: lines.slice(frontmatterEnd + 1).join("\n"),
  };
}

function parseFrontmatterRecord(yaml: string): Record<string, unknown> {
  try {
    const parsed: unknown = parseYaml(yaml);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function shouldIgnoreFrontmatterKey(key: string, policy: lotusHashPolicy): boolean {
  const normalized = normalizeHashPolicyToken(key);
  if (LOTUS_HASH_FRONTMATTER_KEYS.has(normalized) || normalized === REPRODUCIBILITY_FRONTMATTER_KEY) {
    return true;
  }
  if (normalized === HASH_POLICY_FRONTMATTER_KEY || normalized === HASH_IGNORE_FRONTMATTER_KEY || normalized === HASH_IGNORE_BLOCK_ATTRIBUTES_KEY) {
    return false;
  }
  return policy.ignoreFrontmatter.includes(normalized);
}

export function hashPolicyFromPreset(presetId: Exclude<lotusHashPolicyPreset, "custom">): lotusHashPolicy {
  const preset = getHashPolicyPresetDefinition(presetId);
  return {
    preset: preset.id,
    ignoreFrontmatter: normalizePolicyList(preset.ignoreFrontmatter),
    ignoreBlockAttributes: normalizePolicyList(preset.ignoreBlockAttributes),
  };
}

export function getHashPolicyPresetDefinition(presetId: Exclude<lotusHashPolicyPreset, "custom">): lotusHashPolicyPresetDefinition {
  return HASH_POLICY_PRESETS.find((preset) => preset.id === presetId) ?? HASH_POLICY_PRESETS[0];
}

function readHashPolicyPreset(value: string): Exclude<lotusHashPolicyPreset, "custom"> | null {
  const normalized = normalizeHashPolicyToken(value);
  return HASH_POLICY_PRESETS.some((preset) => preset.id === normalized)
    ? normalized as Exclude<lotusHashPolicyPreset, "custom">
    : null;
}

function matchHashPolicyPreset(policy: Pick<lotusHashPolicy, "ignoreFrontmatter" | "ignoreBlockAttributes">): lotusHashPolicyPreset | null {
  const frontmatter = normalizePolicyList(policy.ignoreFrontmatter);
  const blockAttributes = normalizePolicyList(policy.ignoreBlockAttributes);
  for (const preset of HASH_POLICY_PRESETS) {
    if (sameStringSet(frontmatter, normalizePolicyList(preset.ignoreFrontmatter)) && sameStringSet(blockAttributes, normalizePolicyList(preset.ignoreBlockAttributes))) {
      return preset.id;
    }
  }
  return frontmatter.length || blockAttributes.length ? "custom" : "strict";
}

function sameStringSet(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const rightSet = new Set(right);
  return left.every((value) => rightSet.has(value));
}

function canonicalizeFenceInfoForHash(source: string, policy: lotusHashPolicy): string {
  if (!policy.ignoreBlockAttributes.length) {
    return source;
  }

  const ignored = new Set(policy.ignoreBlockAttributes);
  const lines = source.split(/\r?\n/);
  let fenceToken: string | null = null;

  return lines.map((line) => {
    const trimmed = line.trim();
    if (fenceToken) {
      if (trimmed.startsWith(fenceToken) && /^(```+|~~~+)\s*$/.test(trimmed)) {
        fenceToken = null;
      }
      return line;
    }

    const match = line.match(/^(\s*)(```+|~~~+)(\s*)([^\s`]*)?(.*)$/);
    if (!match) {
      return line;
    }

    fenceToken = match[2];
    const language = match[4] ?? "";
    const attributes = removeIgnoredInfoAttributes(match[5] ?? "", ignored);
    const languagePart = language ? `${match[3]}${language}` : match[3];
    return `${match[1]}${match[2]}${languagePart}${attributes ? ` ${attributes}` : ""}`;
  }).join("\n");
}

function removeIgnoredInfoAttributes(input: string, ignored: Set<string>): string {
  return input
    .replace(/([A-Za-z0-9_-]+)\s*=\s*(?:"[^"]*"|'[^']*'|[^\s]+)/g, (full, key: string) =>
      ignored.has(normalizeHashPolicyToken(key)) ? "" : full,
    )
    .replace(/\s+/g, " ")
    .trim();
}

function filterHashPolicyAttributes(attributes: Record<string, string>, policy: lotusHashPolicy): Record<string, string> {
  const ignored = new Set(policy.ignoreBlockAttributes);
  return Object.fromEntries(
    Object.entries(attributes).filter(([key]) => !ignored.has(normalizeHashPolicyToken(key))),
  );
}

function readStringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => readStringList(entry));
  }
  if (typeof value === "string") {
    return value.split(",");
  }
  return [];
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizePolicyList(values: string[]): string[] {
  return [...new Set(values.map(normalizeHashPolicyToken).filter(Boolean))];
}

function normalizeHashPolicyToken(value: string): string {
  return value.trim().toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
