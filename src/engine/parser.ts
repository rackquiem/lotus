import { shortHash } from "./utils/hash";
import { findEnabledCommandLanguage, getEnabledCommandLanguages, getEnabledLanguageAliasMap } from "./languagePackages";
import { parseTimeoutMs } from "./utils/timeout";
import type { lotusCodeBlock, lotusNormalizedLanguage, lotusPluginSettings, lotusSourceReference } from "./types";
import { attachCodePackages } from "./codePackage";

const OUTPUT_START = /^<!--\s*lotus:output:start\s+id=([a-f0-9]+)\s*-->$/i;
const OUTPUT_END = /^<!--\s*lotus:output:end\s*-->$/i;
const FENCE_START = /^(```+|~~~+)\s*([^\s`]*)?(.*)$/;

export function normalizeLanguage(rawLanguage: string, settings?: lotusPluginSettings): lotusNormalizedLanguage | null {
  const normalized = rawLanguage.trim().toLowerCase();

  if (!settings) {
    return null;
  }

  const aliases = getEnabledLanguageAliasMap(settings);
  const builtInLanguage = aliases[normalized];
  if (builtInLanguage) {
    return builtInLanguage;
  }

  const commandLanguage = findEnabledCommandLanguage(settings, normalized);
  return commandLanguage?.name.trim() || null;
}

export function getSupportedLanguageAliases(settings?: lotusPluginSettings): string[] {
  if (!settings) {
    return [];
  }

  const customAliases = getEnabledCommandLanguages(settings)
    .flatMap((language) => {
      const name = language.name.trim().toLowerCase();
      return [name, ...parseAliasList(language.aliases)];
    });

  return [
    ...Object.keys(getEnabledLanguageAliasMap(settings)),
    ...customAliases,
  ].map((alias) => alias.toLowerCase()).filter(Boolean);
}

export function parseMarkdownCodeBlocks(filePath: string, source: string, settings?: lotusPluginSettings): lotusCodeBlock[] {
  const lines = source.split(/\r?\n/);
  const blocks: lotusCodeBlock[] = [];
  let ordinal = 0;
  let insideManagedOutput = false;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (insideManagedOutput) {
      if (OUTPUT_END.test(line.trim())) {
        insideManagedOutput = false;
      }
      continue;
    }

    if (OUTPUT_START.test(line.trim())) {
      insideManagedOutput = true;
      continue;
    }

    const fenceMatch = line.match(FENCE_START);
    if (!fenceMatch) {
      continue;
    }

    const startLine = i;
    const fenceIndent = getLeadingWhitespace(line);
    const fenceToken = fenceMatch[1];
    const sourceLanguage = (fenceMatch[2] ?? "").trim();
    const infoAttributes = parseInfoAttributes(fenceMatch[3] ?? "");
    const sourceReference = parseSourceReference(infoAttributes);
    const executionContext = parseExecutionContext(infoAttributes);
    const language = normalizeLanguage(sourceLanguage, settings);

    let endLine = i;
    const contentLines: string[] = [];

    for (let j = i + 1; j < lines.length; j += 1) {
      const innerLine = lines[j];
      const trimmed = innerLine.trim();

      if (trimmed.startsWith(fenceToken) && /^(```+|~~~+)\s*$/.test(trimmed)) {
        endLine = j;
        i = j;
        break;
      }

      contentLines.push(stripFenceIndent(innerLine, fenceIndent));
      endLine = j;
    }

    if (!language) {
      continue;
    }

    ordinal += 1;
    const content = contentLines.join("\n");
    const referenceHash = sourceReference ? `:${JSON.stringify(sourceReference)}` : "";
    const executionHash = executionContextHasValues(executionContext) ? `:${JSON.stringify(executionContext)}` : "";
    const attributeHash = Object.keys(infoAttributes).length ? `:${JSON.stringify(infoAttributes)}` : "";
    const contentHash = shortHash(`${content}${referenceHash}${executionHash}${attributeHash}`);
    const id = shortHash(`${filePath}:${ordinal}:${language}:${contentHash}`);

    blocks.push({
      id,
      ordinal,
      filePath,
      language,
      languageAlias: sourceLanguage.toLowerCase(),
      sourceLanguage,
      content,
      attributes: infoAttributes,
      sourceReference,
      executionContext,
      startLine,
      endLine,
      fenceStart: 0,
      fenceEnd: 0,
    });
  }

  attachCodePackages(blocks);
  return blocks;
}

function executionContextHasValues(context: ReturnType<typeof parseExecutionContext>): boolean {
  return Boolean(context.containerGroup || context.disableContainer || context.workingDirectory || context.timeoutMs !== undefined);
}

function parseAliasList(value: string): string[] {
  return value
    .split(",")
    .map((alias) => alias.trim().toLowerCase())
    .filter(Boolean);
}

function parseSourceReference(attrs: Record<string, string>): lotusSourceReference | undefined {
  const filePath = attrs["lotus-file"] ?? attrs.file ?? attrs.src ?? attrs.source;
  if (!filePath) {
    return undefined;
  }

  const lines = attrs["lotus-lines"] ?? attrs.lines ?? attrs.line;
  const lineRange = lines ? parseLineRange(lines) : null;
  const symbolName = attrs["lotus-symbol"] ?? attrs.symbol ?? attrs.fn ?? attrs.function;
  const traceValue = attrs["lotus-deps"] ?? attrs.deps ?? attrs.trace;
  const callExpression = attrs["lotus-call"] ?? attrs.call;
  const callArgs = attrs["lotus-args"] ?? attrs.args;
  const printValue = attrs["lotus-print"] ?? attrs.print;
  const call = callExpression != null || callArgs != null
    ? {
      expression: normalizeBooleanAttribute(callExpression) === "true" ? undefined : callExpression,
      args: callArgs,
      print: printValue == null ? true : !["0", "false", "no", "off"].includes(printValue.toLowerCase()),
    }
    : undefined;

  return {
    filePath,
    lineStart: lineRange?.start,
    lineEnd: lineRange?.end,
    symbolName,
    traceDependencies: traceValue == null ? true : !["0", "false", "no", "off"].includes(traceValue.toLowerCase()),
    call,
  };
}

function parseExecutionContext(attrs: Record<string, string>) {
  const container = attrs["lotus-execution"] ?? attrs.execution ?? attrs["lotus-container"] ?? attrs.container;
  const timeout = attrs["lotus-timeout"] ?? attrs.timeout;
  const workingDirectory = attrs["lotus-cwd"] ?? attrs.cwd ?? attrs["working-directory"];
  const timeoutMs = timeout ? parseTimeoutMs(timeout) : undefined;

  return {
    containerGroup: container && !isDisabledValue(container) ? container : undefined,
    disableContainer: container ? isDisabledValue(container) : undefined,
    workingDirectory,
    timeoutMs,
  };
}

function isDisabledValue(value: string): boolean {
  return ["0", "false", "no", "off", "none", "native"].includes(value.trim().toLowerCase());
}

function normalizeBooleanAttribute(value: string | undefined): string | undefined {
  return value == null ? undefined : value.trim().toLowerCase();
}

function parseInfoAttributes(input: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const pattern = /([A-Za-z0-9_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s]+))/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(input)) != null) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function parseLineRange(value: string): { start: number; end: number } | null {
  const match = value.trim().match(/^L?(\d+)(?:\s*[-:]\s*L?(\d+))?$/i);
  if (!match) {
    return null;
  }
  const start = Number.parseInt(match[1], 10);
  const end = Number.parseInt(match[2] ?? match[1], 10);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start <= 0 || end < start) {
    return null;
  }
  return { start, end };
}

export function findBlockAtLine(blocks: lotusCodeBlock[], line: number): lotusCodeBlock | null {
  return blocks.find((block) => line >= block.startLine && line <= block.endLine) ?? null;
}

function getLeadingWhitespace(line: string): string {
  const match = line.match(/^[\t ]*/);
  return match?.[0] ?? "";
}

function stripFenceIndent(line: string, fenceIndent: string): string {
  if (!fenceIndent) {
    return line;
  }

  let index = 0;
  while (index < fenceIndent.length && index < line.length && line[index] === fenceIndent[index]) {
    index += 1;
  }

  return line.slice(index);
}
