import { spawn } from "child_process";
import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import type { lotusNormalizedLanguage, lotusSourceReference } from "./types";
import { splitCommandLine } from "./utils/command";
import { formatTimeoutMs, type lotusTimeoutMs } from "./utils/timeout";
import { lotusClearTimeout, lotusSetTimeout, type LotusTimeoutHandle } from "./utils/timers";

interface SourceRange {
  start: number;
  end: number;
}

interface SourceDefinition extends SourceRange {
  name: string;
  names?: string[];
}

interface PythonAlias {
  name: string;
  asname: string | null;
}

interface PythonImport extends SourceRange {
  kind: "import" | "from";
  module: string;
  level: number;
  names: PythonAlias[];
}

interface PythonModuleInfo {
  definitions: SourceDefinition[];
  imports: PythonImport[];
}

interface PythonUsage {
  names: string[];
  attributes: Record<string, string[]>;
}

interface PythonDependencyState {
  readonly includedRanges: Set<string>;
  readonly includedImports: Set<string>;
  readonly aliases: Set<string>;
  readonly namespaceBindings: Map<string, Set<string>>;
  readonly visitingSymbols: Set<string>;
  needsNamespaceRuntime: boolean;
}

export interface lotusSourceExtractionHost {
  pythonExecutable?: string;
  externalExtractor?: lotusExternalSourceExtractor;
  readFile(filePath: string): Promise<string | null>;
  resolvePythonImport(fromFilePath: string, moduleName: string, level: number): Promise<string | null>;
}

export interface lotusExternalSourceExtractor {
  mode: "command" | "transpile-c";
  language: string;
  executable: string;
  args: string[];
  workingDirectory: string;
  timeoutMs: lotusTimeoutMs;
}

interface ExternalExtractorResult {
  content?: string;
  selected?: string;
  dependencies?: string[];
  imports?: string[];
  description?: string;
}

interface TranspileToCResult {
  generatedSource: string;
  symbols?: Record<string, string>;
  harness?: string;
  language?: "c" | "cpp";
  description?: string;
}

export interface lotusResolvedSource {
  content: string;
  description: string;
}

export async function resolveReferencedSource(
  source: string,
  reference: lotusSourceReference,
  language: lotusNormalizedLanguage,
  harness: string,
  host?: lotusSourceExtractionHost,
): Promise<lotusResolvedSource> {
  if (host?.externalExtractor?.executable.trim()) {
    return host.externalExtractor.mode === "transpile-c"
      ? resolveTranspileToCReferencedSource(source, reference, language, harness, host.externalExtractor)
      : resolveExternalReferencedSource(source, reference, language, harness, host.externalExtractor);
  }

  if (language === "python" && host) {
    return resolvePythonReferencedSource(source, reference, harness, host);
  }

  return resolveReferencedSourceFallback(source, reference, language, harness);
}

function resolveReferencedSourceFallback(
  source: string,
  reference: lotusSourceReference,
  language: lotusNormalizedLanguage,
  harness: string,
): lotusResolvedSource {
  const lines = source.split(/\r?\n/);
  const selectedRange = reference.symbolName
    ? findSymbolRange(lines, language, reference.symbolName)
    : findLineRange(lines, reference);

  if (!selectedRange) {
    const target = reference.symbolName ? `symbol ${reference.symbolName}` : "line range";
    throw new Error(`Unable to extract ${target} from ${reference.filePath}.`);
  }

  const selected = renderRange(lines, selectedRange);
  const dependencies = reference.traceDependencies
    ? collectDependencySource(lines, language, selectedRange, selected)
    : "";
  const content = [dependencies, selected, harness.trim() ? harness : ""]
    .filter((part) => part.trim())
    .join("\n\n");

  return {
    content,
    description: formatSourceDescription(reference, selectedRange),
  };
}

async function resolveExternalReferencedSource(
  source: string,
  reference: lotusSourceReference,
  language: lotusNormalizedLanguage,
  harness: string,
  extractor: lotusExternalSourceExtractor,
): Promise<lotusResolvedSource> {
  const tempDir = await mkdtemp(join(tmpdir(), "lotus-extract-"));
  const sourceFile = join(tempDir, "source.txt");
  const harnessFile = join(tempDir, "harness.txt");
  const requestFile = join(tempDir, "request.json");

  try {
    const request = {
      language,
      filePath: reference.filePath,
      symbolName: reference.symbolName ?? null,
      lineStart: reference.lineStart ?? null,
      lineEnd: reference.lineEnd ?? null,
      traceDependencies: reference.traceDependencies,
      sourceFile,
      harnessFile,
    };
    await writeFile(sourceFile, source, "utf8");
    await writeFile(harnessFile, harness, "utf8");
    await writeFile(requestFile, JSON.stringify(request, null, 2), "utf8");

    const output = await runExternalExtractor(extractor, {
      language,
      sourceFile,
      harnessFile,
      requestFile,
      reference,
    });
    const result = parseExternalExtractorResult(output);
    const content = result.content ?? [
      ...(result.imports ?? []),
      ...(result.dependencies ?? []),
      result.selected ?? "",
      harness.trim() ? harness : "",
    ].filter((part) => part.trim()).join("\n\n");

    if (!content.trim()) {
      throw new Error("Custom source extractor returned no content.");
    }

    return {
      content,
      description: result.description?.trim() || formatSourceDescription(reference, null),
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function resolveTranspileToCReferencedSource(
  source: string,
  reference: lotusSourceReference,
  language: lotusNormalizedLanguage,
  harness: string,
  extractor: lotusExternalSourceExtractor,
): Promise<lotusResolvedSource> {
  const tempDir = await mkdtemp(join(tmpdir(), "lotus-extract-"));
  const sourceFile = join(tempDir, "source.txt");
  const harnessFile = join(tempDir, "harness.txt");
  const requestFile = join(tempDir, "request.json");

  try {
    const request = {
      language,
      filePath: reference.filePath,
      symbolName: reference.symbolName ?? null,
      lineStart: reference.lineStart ?? null,
      lineEnd: reference.lineEnd ?? null,
      traceDependencies: reference.traceDependencies,
      sourceFile,
      harnessFile,
      targetLanguage: "c",
    };
    await writeFile(sourceFile, source, "utf8");
    await writeFile(harnessFile, harness, "utf8");
    await writeFile(requestFile, JSON.stringify(request, null, 2), "utf8");

    const output = await runExternalExtractor(extractor, {
      language,
      sourceFile,
      harnessFile,
      requestFile,
      reference,
    });
    const result = parseTranspileToCResult(output);
    const generatedLanguage = result.language === "cpp" ? "cpp" : "c";
    const mappedSymbol = reference.symbolName ? result.symbols?.[reference.symbolName] ?? reference.symbolName : undefined;
    const generatedReference: lotusSourceReference = {
      ...reference,
      filePath: `${reference.filePath}:generated.${generatedLanguage === "cpp" ? "cpp" : "c"}`,
      symbolName: mappedSymbol,
    };
    const resolved = resolveReferencedSourceFallback(result.generatedSource, generatedReference, generatedLanguage, result.harness ?? harness);

    return {
      content: resolved.content,
      description: result.description?.trim() || `${reference.filePath}#${reference.symbolName ?? "generated-c"}`,
    };
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

async function runExternalExtractor(
  extractor: lotusExternalSourceExtractor,
  values: {
    language: string;
    sourceFile: string;
    harnessFile: string;
    requestFile: string;
    reference: lotusSourceReference;
  },
): Promise<string> {
  const args = extractor.args.map((arg) => arg
    .replaceAll("{request}", values.requestFile)
    .replaceAll("{source}", values.sourceFile)
    .replaceAll("{file}", values.sourceFile)
    .replaceAll("{harness}", values.harnessFile)
    .replaceAll("{symbol}", values.reference.symbolName ?? "")
    .replaceAll("{lineStart}", values.reference.lineStart == null ? "" : String(values.reference.lineStart))
    .replaceAll("{lineEnd}", values.reference.lineEnd == null ? "" : String(values.reference.lineEnd))
    .replaceAll("{deps}", values.reference.traceDependencies ? "true" : "false")
    .replaceAll("{language}", values.language));

  return new Promise((resolve, reject) => {
    const child = spawn(extractor.executable, args, {
      cwd: extractor.workingDirectory,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timeout: LotusTimeoutHandle | null = extractor.timeoutMs === null
      ? null
      : lotusSetTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Custom source extractor timed out after ${formatTimeoutMs(extractor.timeoutMs)}.`));
      }, extractor.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      if (timeout !== null) {
        lotusClearTimeout(timeout);
      }
      reject(formatSpawnError(error, extractor.executable, "Custom source extractor"));
    });
    child.on("close", (code) => {
      if (timeout !== null) {
        lotusClearTimeout(timeout);
      }
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Custom source extractor exited with code ${code}.`).trim()));
        return;
      }
      resolve(stdout);
    });

    child.stdin.end(JSON.stringify({
      requestFile: values.requestFile,
      sourceFile: values.sourceFile,
      harnessFile: values.harnessFile,
      language: values.language,
      filePath: values.reference.filePath,
      symbolName: values.reference.symbolName ?? null,
      lineStart: values.reference.lineStart ?? null,
      lineEnd: values.reference.lineEnd ?? null,
      traceDependencies: values.reference.traceDependencies,
    }));
  });
}

function parseExternalExtractorResult(output: string): ExternalExtractorResult {
  try {
    const parsed = JSON.parse(output) as ExternalExtractorResult;
    if (typeof parsed !== "object" || parsed == null) {
      throw new Error("Custom source extractor must return a JSON object.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Custom source extractor returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseTranspileToCResult(output: string): TranspileToCResult {
  try {
    const parsed = JSON.parse(output) as TranspileToCResult;
    if (typeof parsed !== "object" || parsed == null || typeof parsed.generatedSource !== "string") {
      throw new Error("Transpile to C extractor must return generatedSource.");
    }
    if (parsed.language != null && parsed.language !== "c" && parsed.language !== "cpp") {
      throw new Error("Transpile to C language must be c or cpp.");
    }
    if (parsed.symbols != null && (typeof parsed.symbols !== "object" || Array.isArray(parsed.symbols))) {
      throw new Error("Transpile to C symbols must be an object.");
    }
    return parsed;
  } catch (error) {
    throw new Error(`Transpile to C extractor returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function resolvePythonReferencedSource(
  source: string,
  reference: lotusSourceReference,
  harness: string,
  host: lotusSourceExtractionHost,
): Promise<lotusResolvedSource> {
  const lines = source.split(/\r?\n/);
  const moduleInfo = await inspectPythonModule(source, host);
  const selectedRange = reference.symbolName
    ? findPythonSymbolRange(moduleInfo, reference.symbolName)
    : findLineRange(lines, reference);

  if (!selectedRange) {
    const target = reference.symbolName ? `symbol ${reference.symbolName}` : "line range";
    throw new Error(`Unable to extract ${target} from ${reference.filePath}.`);
  }

  const selected = renderRange(lines, selectedRange);
  const state = createPythonDependencyState();
  const dependencies = reference.traceDependencies
    ? await collectPythonDependencySource(source, reference.filePath, selectedRange, selected, harness, host, state)
    : "";
  const content = [dependencies, selected, harness.trim() ? harness : ""]
    .filter((part) => part.trim())
    .join("\n\n");

  return {
    content,
    description: formatSourceDescription(reference, selectedRange),
  };
}

function createPythonDependencyState(): PythonDependencyState {
  return {
    includedRanges: new Set(),
    includedImports: new Set(),
    aliases: new Set(),
    namespaceBindings: new Map(),
    visitingSymbols: new Set(),
    needsNamespaceRuntime: false,
  };
}

async function collectPythonDependencySource(
  source: string,
  filePath: string,
  selectedRange: SourceRange,
  selected: string,
  harness: string,
  host: lotusSourceExtractionHost,
  state: PythonDependencyState,
): Promise<string> {
  const parts: string[] = [];
  await collectPythonDependencies(source, filePath, selectedRange, `${selected}\n${harness}`, host, state, parts);
  const namespace = renderPythonNamespaceBindings(state);
  return [...state.includedImports, ...parts, namespace]
    .filter((part) => part.trim())
    .join("\n\n");
}

async function collectPythonDependencies(
  source: string,
  filePath: string,
  selectedRange: SourceRange,
  seed: string,
  host: lotusSourceExtractionHost,
  state: PythonDependencyState,
  parts: string[],
): Promise<string> {
  const lines = source.split(/\r?\n/);
  const moduleInfo = await inspectPythonModule(source, host);
  let haystack = seed;
  let collected = "";
  let changed = true;

  while (changed) {
    changed = false;
    const usage = await inspectPythonUsage(haystack, host);

    for (const definition of moduleInfo.definitions) {
      if (rangesOverlap(definition, selectedRange) || !pythonDefinitionIsUsed(definition, usage)) {
        continue;
      }
      const text = addPythonRange(lines, filePath, definition, state, parts);
      if (text) {
        const nested = await collectPythonDependencies(source, filePath, definition, text, host, state, parts);
        haystack += `\n${text}\n`;
        if (nested) {
          haystack += `\n${nested}\n`;
        }
        collected += `${nested}\n${text}\n`;
        changed = true;
      }
    }

    for (const importNode of moduleInfo.imports) {
      const text = await resolvePythonImportDependency(importNode, lines, filePath, usage, host, state, parts);
      if (text) {
        haystack += `\n${text}\n`;
        collected += `${text}\n`;
        changed = true;
      }
    }
  }

  return collected;
}

async function resolvePythonImportDependency(
  importNode: PythonImport,
  lines: string[],
  filePath: string,
  usage: PythonUsage,
  host: lotusSourceExtractionHost,
  state: PythonDependencyState,
  parts: string[],
): Promise<string> {
  if (importNode.kind === "from") {
    return resolvePythonFromImportDependency(importNode, lines, filePath, usage, host, state, parts);
  }

  return resolvePythonPlainImportDependency(importNode, lines, filePath, usage, host, state, parts);
}

async function resolvePythonFromImportDependency(
  importNode: PythonImport,
  lines: string[],
  filePath: string,
  usage: PythonUsage,
  host: lotusSourceExtractionHost,
  state: PythonDependencyState,
  parts: string[],
): Promise<string> {
  const localModulePath = await host.resolvePythonImport(filePath, importNode.module, importNode.level);
  let added = "";

  for (const alias of importNode.names) {
    if (alias.name === "*") {
      if (!localModulePath) {
        if (usesUnknownImportedNames(usage) && addPythonImportLine(lines, importNode, state)) {
          added += `${renderRange(lines, importNode)}\n`;
        }
        continue;
      }

      const source = await host.readFile(localModulePath);
      if (!source) {
        continue;
      }
      const moduleInfo = await inspectPythonModule(source, host);
      for (const definition of moduleInfo.definitions) {
        if (!pythonDefinitionIsUsed(definition, usage)) {
          continue;
        }
        added += await extractPythonSymbolFromFile(localModulePath, definition.name, host, state, parts);
      }
      continue;
    }

    const exposedName = alias.asname ?? alias.name;
    if (!usage.names.includes(exposedName)) {
      continue;
    }

    const submodulePath = await host.resolvePythonImport(filePath, joinPythonModule(importNode.module, alias.name), importNode.level);
    const importTargetPath = localModulePath ?? submodulePath;
    if (!importTargetPath) {
      if (addPythonImportLine(lines, importNode, state)) {
        added += `${renderRange(lines, importNode)}\n`;
      }
      continue;
    }

    const extracted = await extractPythonSymbolFromFile(importTargetPath, alias.name, host, state, parts);
    if (extracted) {
      added += extracted;
      if (alias.asname && alias.asname !== alias.name) {
        added += addPythonAlias(alias.name, alias.asname, state, parts);
      }
      continue;
    }

    const moduleBinding = alias.asname ?? alias.name;
    const moduleAttributes = usage.attributes[moduleBinding] ?? [];
    if (submodulePath && moduleAttributes.length) {
      for (const attribute of moduleAttributes) {
        added += await extractPythonSymbolFromFile(submodulePath, attribute, host, state, parts);
        addPythonNamespaceBinding(moduleBinding, attribute, state);
      }
    }
  }

  return added;
}

async function resolvePythonPlainImportDependency(
  importNode: PythonImport,
  lines: string[],
  filePath: string,
  usage: PythonUsage,
  host: lotusSourceExtractionHost,
  state: PythonDependencyState,
  parts: string[],
): Promise<string> {
  let added = "";

  for (const alias of importNode.names) {
    const binding = alias.asname ?? alias.name.split(".")[0];
    const usedAttributes = usage.attributes[binding] ?? [];
    const bindingIsUsed = usage.names.includes(binding) || usedAttributes.length > 0;
    if (!bindingIsUsed) {
      continue;
    }

    const localModulePath = await host.resolvePythonImport(filePath, alias.name, 0);
    if (!localModulePath) {
      if (addPythonImportLine(lines, importNode, state)) {
        added += `${renderRange(lines, importNode)}\n`;
      }
      continue;
    }

    for (const attribute of usedAttributes) {
      added += await extractPythonSymbolFromFile(localModulePath, attribute, host, state, parts);
      addPythonNamespaceBinding(binding, attribute, state);
    }
  }

  return added;
}

async function extractPythonSymbolFromFile(
  filePath: string,
  symbolName: string,
  host: lotusSourceExtractionHost,
  state: PythonDependencyState,
  parts: string[],
): Promise<string> {
  const visitKey = `${filePath}#${symbolName}`;
  if (state.visitingSymbols.has(visitKey)) {
    return "";
  }

  const source = await host.readFile(filePath);
  if (!source) {
    return "";
  }

  state.visitingSymbols.add(visitKey);
  try {
    const lines = source.split(/\r?\n/);
    const moduleInfo = await inspectPythonModule(source, host);
    const definition = moduleInfo.definitions.find((candidate) => (candidate.names ?? [candidate.name]).includes(symbolName));
    if (!definition) {
      return "";
    }

    const text = renderRange(lines, definition);
    const dependencyText = await collectPythonDependencies(source, filePath, definition, text, host, state, parts);
    const added = addPythonRange(lines, filePath, definition, state, parts);
    return [dependencyText, added].filter((part) => part.trim()).join("\n");
  } finally {
    state.visitingSymbols.delete(visitKey);
  }
}

function addPythonRange(
  lines: string[],
  filePath: string,
  range: SourceRange,
  state: PythonDependencyState,
  parts: string[],
): string {
  const key = `${filePath}:L${range.start + 1}-L${range.end + 1}`;
  if (state.includedRanges.has(key)) {
    return "";
  }
  state.includedRanges.add(key);
  const text = renderRange(lines, range);
  parts.push(text);
  return text;
}

function addPythonImportLine(lines: string[], range: SourceRange, state: PythonDependencyState): boolean {
  const text = renderRange(lines, range);
  if (state.includedImports.has(text)) {
    return false;
  }
  state.includedImports.add(text);
  return true;
}

function addPythonAlias(name: string, asname: string, state: PythonDependencyState, parts: string[]): string {
  const key = `${asname}=${name}`;
  if (state.aliases.has(key)) {
    return "";
  }
  state.aliases.add(key);
  const text = `${asname} = ${name}`;
  parts.push(text);
  return `${text}\n`;
}

function addPythonNamespaceBinding(binding: string, attribute: string, state: PythonDependencyState): void {
  state.needsNamespaceRuntime = true;
  const attributes = state.namespaceBindings.get(binding) ?? new Set<string>();
  attributes.add(attribute);
  state.namespaceBindings.set(binding, attributes);
}

function renderPythonNamespaceBindings(state: PythonDependencyState): string {
  if (!state.namespaceBindings.size) {
    return "";
  }

  const lines = state.needsNamespaceRuntime ? ["import types as _lotus_types"] : [];
  for (const [binding, attributes] of state.namespaceBindings) {
    lines.push(`${binding} = _lotus_types.SimpleNamespace()`);
    for (const attribute of attributes) {
      lines.push(`${binding}.${attribute} = ${attribute}`);
    }
  }
  return lines.join("\n");
}

function findPythonSymbolRange(moduleInfo: PythonModuleInfo, symbolName: string): SourceRange | null {
  const exact = moduleInfo.definitions.find((definition) => (definition.names ?? [definition.name]).includes(symbolName));
  return exact ? { start: exact.start, end: exact.end } : null;
}

function pythonDefinitionIsUsed(definition: SourceDefinition, usage: PythonUsage): boolean {
  return (definition.names ?? [definition.name]).some((name) => usage.names.includes(name));
}

function usesUnknownImportedNames(usage: PythonUsage): boolean {
  return usage.names.length > 0;
}

function joinPythonModule(moduleName: string, name: string): string {
  return moduleName ? `${moduleName}.${name}` : name;
}

async function inspectPythonModule(source: string, host: lotusSourceExtractionHost): Promise<PythonModuleInfo> {
  return runPythonAst<PythonModuleInfo>(source, "module", host);
}

async function inspectPythonUsage(source: string, host: lotusSourceExtractionHost): Promise<PythonUsage> {
  return runPythonAst<PythonUsage>(source, "usage", host);
}

async function runPythonAst<T>(source: string, mode: "module" | "usage", host: lotusSourceExtractionHost): Promise<T> {
  const command = splitCommandLine(host.pythonExecutable?.trim() || "python3");
  const executable = command[0] ?? "python3";
  const args = [...command.slice(1), "-c", PYTHON_AST_HELPER];

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      reject(formatSpawnError(error, executable, "Python AST helper"));
    });
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error((stderr || stdout || `Python AST helper exited with code ${code}.`).trim()));
        return;
      }
      try {
        resolve(JSON.parse(stdout) as T);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });

    child.stdin.end(JSON.stringify({ mode, source }));
  });
}

function findLineRange(lines: string[], reference: lotusSourceReference): SourceRange | null {
  const start = Math.max((reference.lineStart ?? 1) - 1, 0);
  const end = Math.min((reference.lineEnd ?? reference.lineStart ?? lines.length) - 1, lines.length - 1);
  if (start > end || start >= lines.length) {
    return null;
  }
  return { start, end };
}

function formatSpawnError(error: unknown, executable: string, label: string): Error {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return new Error(`${label} executable not found: ${executable}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function findSymbolRange(lines: string[], language: lotusNormalizedLanguage, symbolName: string): SourceRange | null {
  const definitions = collectDefinitions(lines, language);
  const exact = definitions.find((definition) => definitionNames(definition).includes(symbolName));
  if (exact) {
    return { start: exact.start, end: exact.end };
  }

  const symbolPattern = new RegExp(`\\b${escapeRegex(symbolName)}\\b`);
  const line = lines.findIndex((candidate) => symbolPattern.test(candidate));
  if (line < 0) {
    return null;
  }
  return lines[line].includes("{") ? { start: line, end: findBraceRangeEnd(lines, line) } : { start: line, end: line };
}

function collectDependencySource(lines: string[], language: lotusNormalizedLanguage, selectedRange: SourceRange, selected: string): string {
  const prologue = collectPrologue(lines, language, selectedRange.start);
  const definitions = collectDefinitions(lines, language)
    .filter((definition) => !rangesOverlap(definition, selectedRange));
  const selectedDefinitions = traceDefinitions(selected, definitions, lines);
  return [...prologue, ...selectedDefinitions.map((definition) => renderRange(lines, definition))]
    .filter((part) => part.trim())
    .join("\n\n");
}

function traceDefinitions(seed: string, definitions: SourceDefinition[], lines: string[]): SourceDefinition[] {
  const selected: SourceDefinition[] = [];
  const selectedKeys = new Set<string>();
  let haystack = seed;
  let changed = true;

  while (changed) {
    changed = false;
    for (const definition of definitions) {
      const key = `${definition.start}:${definition.end}:${definition.name}`;
      if (selectedKeys.has(key)) {
        continue;
      }
      if (!definitionNames(definition).some((name) => sourceUsesName(haystack, name))) {
        continue;
      }
      selectedKeys.add(key);
      selected.push(definition);
      haystack += `\n${renderRange(lines, definition)}\n`;
      changed = true;
    }
  }

  return selected.sort((left, right) => left.start - right.start);
}

function collectPrologue(lines: string[], language: lotusNormalizedLanguage, beforeLine: number): string[] {
  const prologue: string[] = [];
  const max = Math.max(beforeLine, 0);
  for (let index = 0; index < max; index += 1) {
    const line = lines[index];
    if (isPrologueLine(line, language)) {
      prologue.push(line);
    }
  }
  return prologue.length ? [prologue.join("\n")] : [];
}

function isPrologueLine(line: string, language: lotusNormalizedLanguage): boolean {
  const trimmed = line.trim();
  if (!trimmed) {
    return false;
  }
  switch (language) {
    case "python":
      return /^(from\s+\S+\s+import\s+|import\s+)/.test(trimmed);
    case "javascript":
    case "obsidian-js":
    case "typescript":
      return /^(import\s+|export\s+.*\s+from\s+|(?:const|let|var)\s+\w+\s*=\s*require\s*\()/.test(trimmed);
    case "c":
    case "cpp":
    case "llvm-ir":
      return trimmed.startsWith("#") || trimmed.startsWith("target ") || trimmed.startsWith("source_filename");
    case "haskell":
      return /^(module\s+|import\s+)/.test(trimmed);
    case "ocaml":
      return /^(open\s+|include\s+|#use\s+)/.test(trimmed);
    case "java":
      return /^(package\s+|import\s+)/.test(trimmed);
    default:
      return false;
  }
}

function collectDefinitions(lines: string[], language: lotusNormalizedLanguage): SourceDefinition[] {
  switch (language) {
    case "python":
      return collectPythonDefinitions(lines);
    case "javascript":
    case "obsidian-js":
    case "typescript":
      return collectBraceDefinitions(lines, /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\b|^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)\b|^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    case "c":
      return collectCDefinitions(lines, false);
    case "cpp":
      return collectCDefinitions(lines, true);
    case "haskell":
      return collectHaskellDefinitions(lines);
    case "ocaml":
      return collectOcamlDefinitions(lines);
    case "java":
      return collectBraceDefinitions(lines, /^\s*(?:public|private|protected|static|final|abstract|\s)*\s*(?:class|interface|enum|record)\s+([A-Za-z_]\w*)\b|^\s*(?:public|private|protected|static|final|synchronized|native|\s)+[\w<>[\],.?]+\s+([A-Za-z_]\w*)\s*\([^;]*\)\s*\{/);
    case "llvm-ir":
      return collectLlvmDefinitions(lines);
    default:
      return [];
  }
}

function collectPythonDefinitions(lines: string[]): SourceDefinition[] {
  const definitions: SourceDefinition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const assignment = lines[index].match(/^([A-Za-z_]\w*)\s*[:=]/);
    if (assignment) {
      definitions.push({ name: assignment[1], start: index, end: index });
      continue;
    }

    const match = lines[index].match(/^(\s*)(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)\b/);
    if (!match) {
      continue;
    }
    const indent = match[1].length;
    let start = index;
    while (start > 0 && lines[start - 1].trim().startsWith("@") && getIndent(lines[start - 1]) === indent) {
      start -= 1;
    }
    let end = index;
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      if (lines[cursor].trim() && getIndent(lines[cursor]) <= indent) {
        break;
      }
      end = cursor;
    }
    definitions.push({ name: match[2], start, end });
  }
  return definitions;
}

function collectCDefinitions(lines: string[], isCpp: boolean): SourceDefinition[] {
  const definitions: SourceDefinition[] = [];
  let depth = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    const topLevel = depth === 0;

    if (topLevel && trimmed) {
      const macro = trimmed.match(/^#\s*define\s+([A-Za-z_]\w*)\b/);
      if (macro) {
        definitions.push({ name: macro[1], start: index, end: index });
      } else if (!trimmed.startsWith("#") && !isCCommentLine(trimmed)) {
        const typeDefinition = matchCTypeDefinition(lines, index, isCpp);
        if (typeDefinition) {
          definitions.push(typeDefinition);
          index = Math.max(index, typeDefinition.end);
        } else {
          const functionDefinition = matchCFunctionDefinition(lines, index);
          if (functionDefinition) {
            definitions.push(functionDefinition);
            index = Math.max(index, functionDefinition.end);
          } else {
            const globalDefinition = matchCGlobalDefinition(line, index);
            if (globalDefinition) {
              definitions.push(globalDefinition);
            }
          }
        }
      }
    }

    depth += braceDelta(line);
    if (depth < 0) {
      depth = 0;
    }
  }

  return definitions;
}

function matchCTypeDefinition(lines: string[], start: number, isCpp: boolean): SourceDefinition | null {
  const header = lines.slice(start, Math.min(lines.length, start + 8)).join(" ");
  const keywordPattern = isCpp ? "(?:typedef\\s+)?(?:struct|class|enum|union)" : "(?:typedef\\s+)?(?:struct|enum|union)";
  const named = header.match(new RegExp(`^\\s*${keywordPattern}\\s+([A-Za-z_]\\w*)\\b`));
  const anonymousTypedef = header.match(/^\s*typedef\s+(?:struct|enum|union)\b[\s\S]*?\}\s*([A-Za-z_]\w*)\s*;/);
  const name = named?.[1] ?? anonymousTypedef?.[1];
  if (!name) {
    return null;
  }

  const end = findCDeclarationEnd(lines, start);
  return { name, names: [name], start, end };
}

function matchCFunctionDefinition(lines: string[], start: number): SourceDefinition | null {
  const headerLines = lines.slice(start, Math.min(lines.length, start + 12));
  const joined = headerLines.join(" ");
  const braceOffset = headerLines.findIndex((line) => line.includes("{"));
  if (braceOffset < 0 || joined.indexOf(";") >= 0 && joined.indexOf(";") < joined.indexOf("{")) {
    return null;
  }

  const matches = [...joined.matchAll(/([A-Za-z_]\w*(?:::[A-Za-z_]\w*)?|operator\s*[^\s(]+)\s*\([^;{}]*\)\s*(?:const\b[^{}]*)?(?:noexcept\b[^{}]*)?(?:->\s*[^{}]+)?\{/g)];
  const name = matches[0]?.[1]?.replace(/\s+/g, "");
  if (!name || isCControlKeyword(name)) {
    return null;
  }

  const braceLine = start + braceOffset;
  const shortName = name.includes("::") ? name.split("::").pop() ?? name : name;
  return {
    name: shortName,
    names: [...new Set([shortName, name])],
    start,
    end: findBraceRangeEnd(lines, braceLine),
  };
}

function matchCGlobalDefinition(line: string, index: number): SourceDefinition | null {
  const trimmed = line.trim();
  if (!trimmed.endsWith(";") || trimmed.includes("(") || /^(return|using|namespace|template)\b/.test(trimmed)) {
    return null;
  }

  const withoutInitializer = trimmed.split("=")[0].replace(/\[[^\]]*]/g, "");
  const match = withoutInitializer.match(/([A-Za-z_]\w*)\s*(?:[,;]|$)/g)?.pop()?.match(/([A-Za-z_]\w*)/);
  const name = match?.[1];
  if (!name || /^(const|static|extern|volatile|unsigned|signed|long|short|int|char|float|double|void|auto)$/.test(name)) {
    return null;
  }

  return { name, start: index, end: index };
}

function collectLlvmDefinitions(lines: string[]): SourceDefinition[] {
  const definitions: SourceDefinition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const symbol = line.match(/^\s*(?:define|declare)\b.*@([A-Za-z$._-][A-Za-z$._0-9-]*)\s*\(/);
    if (symbol) {
      const end = line.trimStart().startsWith("define") ? findBraceRangeEnd(lines, index) : index;
      definitions.push({ name: symbol[1], names: [symbol[1], `@${symbol[1]}`], start: index, end });
      continue;
    }

    const global = line.match(/^\s*@([A-Za-z$._-][A-Za-z$._0-9-]*)\s*=/);
    if (global) {
      definitions.push({ name: global[1], names: [global[1], `@${global[1]}`], start: index, end: index });
    }
  }
  return definitions;
}

function collectHaskellDefinitions(lines: string[]): SourceDefinition[] {
  const definitions: SourceDefinition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || getIndent(lines[index]) > 0 || /^(module|import)\b/.test(trimmed)) {
      continue;
    }

    const names = getHaskellDefinitionNames(trimmed);
    if (!names.length) {
      continue;
    }

    const end = findHaskellRangeEnd(lines, index, names[0]);
    definitions.push({ name: names[0], names, start: index, end });
    index = end;
  }
  return definitions;
}

function collectOcamlDefinitions(lines: string[]): SourceDefinition[] {
  const definitions: SourceDefinition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = lines[index].trim();
    if (!trimmed || getIndent(lines[index]) > 0 || /^(open|include|#use)\b/.test(trimmed)) {
      continue;
    }

    const names = getOcamlDefinitionNames(trimmed);
    if (!names.length) {
      continue;
    }

    const end = findLayoutRangeEnd(lines, index, isOcamlTopLevelStart);
    definitions.push({ name: names[0], names, start: index, end });
    index = end;
  }
  return definitions;
}

function collectBraceDefinitions(lines: string[], pattern: RegExp): SourceDefinition[] {
  const definitions: SourceDefinition[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index].match(pattern);
    const name = match?.slice(1).find(Boolean);
    if (!name) {
      continue;
    }
    definitions.push({ name, start: index, end: findBraceRangeEnd(lines, index) });
  }
  return definitions;
}

function findBraceRangeEnd(lines: string[], start: number): number {
  if (!lines[start].includes("{")) {
    return start;
  }

  let depth = 0;
  let sawBrace = false;
  for (let index = start; index < lines.length; index += 1) {
    for (const char of lines[index]) {
      if (char === "{") {
        depth += 1;
        sawBrace = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }
    if (sawBrace && depth <= 0) {
      return index;
    }
  }
  return start;
}

function findCDeclarationEnd(lines: string[], start: number): number {
  let sawBrace = false;
  let depth = 0;
  for (let index = start; index < lines.length; index += 1) {
    for (const char of lines[index]) {
      if (char === "{") {
        depth += 1;
        sawBrace = true;
      } else if (char === "}") {
        depth -= 1;
      }
    }

    if ((!sawBrace || depth <= 0) && lines[index].includes(";")) {
      return index;
    }
  }
  return start;
}

function braceDelta(line: string): number {
  let delta = 0;
  for (const char of line) {
    if (char === "{") {
      delta += 1;
    } else if (char === "}") {
      delta -= 1;
    }
  }
  return delta;
}

function isCCommentLine(trimmed: string): boolean {
  return trimmed.startsWith("//") || trimmed.startsWith("/*") || trimmed.startsWith("*");
}

function isCControlKeyword(name: string): boolean {
  return ["if", "for", "while", "switch", "catch"].includes(name);
}

function getHaskellDefinitionNames(trimmed: string): string[] {
  const signature = trimmed.match(/^([a-z_][\w']*)\s*::/);
  if (signature) {
    return [signature[1]];
  }

  const binding = trimmed.match(/^([a-z_][\w']*)\b.*=/);
  if (binding) {
    return [binding[1]];
  }

  const typeLike = trimmed.match(/^(?:data|newtype|type|class)\s+([A-Z][\w']*)\b/);
  if (typeLike) {
    return [typeLike[1]];
  }

  const instance = trimmed.match(/^instance\b.*?\b([A-Z][\w']*)\b/);
  return instance ? [instance[1]] : [];
}

function getOcamlDefinitionNames(trimmed: string): string[] {
  const letBinding = trimmed.match(/^let\s+(?:rec\s+)?(?:\(([^)]+)\)|([a-z_][\w']*))/);
  if (letBinding) {
    return [letBinding[1] ?? letBinding[2]];
  }

  const typeBinding = trimmed.match(/^type\s+([a-z_][\w']*)/);
  if (typeBinding) {
    return [typeBinding[1]];
  }

  const moduleBinding = trimmed.match(/^module\s+([A-Z][\w']*)/);
  if (moduleBinding) {
    return [moduleBinding[1]];
  }

  return [];
}

function findLayoutRangeEnd(lines: string[], start: number, isTopLevelStart: (line: string) => boolean): number {
  let end = start;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() && getIndent(line) === 0 && isTopLevelStart(line.trim())) {
      break;
    }
    end = index;
  }
  return end;
}

function findHaskellRangeEnd(lines: string[], start: number, name: string): number {
  let end = start;
  let allowMatchingEquation = lines[start].trim().startsWith(`${name} ::`);
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed && getIndent(line) === 0 && isHaskellTopLevelStart(trimmed)) {
      if (allowMatchingEquation && trimmed.startsWith(`${name} `) && trimmed.includes("=")) {
        allowMatchingEquation = false;
        end = index;
        continue;
      }
      break;
    }
    end = index;
  }
  return end;
}

function isHaskellTopLevelStart(trimmed: string): boolean {
  return /^(module|import|data|newtype|type|class|instance)\b/.test(trimmed)
    || /^[a-z_][\w']*\s*(?:::|.*=)/.test(trimmed);
}

function isOcamlTopLevelStart(trimmed: string): boolean {
  return /^(open|include|#use|let|type|module)\b/.test(trimmed);
}

function renderRange(lines: string[], range: SourceRange): string {
  return lines.slice(range.start, range.end + 1).join("\n");
}

function rangesOverlap(left: SourceRange, right: SourceRange): boolean {
  return left.start <= right.end && right.start <= left.end;
}

function getIndent(line: string): number {
  return line.match(/^\s*/)?.[0].length ?? 0;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function definitionNames(definition: SourceDefinition): string[] {
  return definition.names?.length ? definition.names : [definition.name];
}

function sourceUsesName(source: string, name: string): boolean {
  if (name.startsWith("@")) {
    return new RegExp(`${escapeRegex(name)}\\b`).test(source);
  }
  return new RegExp(`\\b${escapeRegex(name)}\\b`).test(source);
}

function formatSourceDescription(reference: lotusSourceReference, range: SourceRange | null): string {
  if (reference.symbolName) {
    return `${reference.filePath}#${reference.symbolName}`;
  }
  if (range) {
    return `${reference.filePath}:L${range.start + 1}-L${range.end + 1}`;
  }
  return reference.filePath;
}

const PYTHON_AST_HELPER = String.raw`
import ast
import json
import sys

payload = json.loads(sys.stdin.read())
source = payload.get("source", "")
mode = payload.get("mode", "module")

def range_start(node):
    lineno = getattr(node, "lineno", 1)
    decorators = getattr(node, "decorator_list", None) or []
    if decorators:
        lineno = min(lineno, *(getattr(decorator, "lineno", lineno) for decorator in decorators))
    return lineno - 1

def range_end(node):
    return getattr(node, "end_lineno", getattr(node, "lineno", 1)) - 1

def target_names(target):
    if isinstance(target, ast.Name):
        return [target.id]
    if isinstance(target, (ast.Tuple, ast.List)):
        names = []
        for item in target.elts:
            names.extend(target_names(item))
        return names
    return []

def definition_names(node):
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        return [node.name]
    if isinstance(node, ast.Assign):
        names = []
        for target in node.targets:
            names.extend(target_names(target))
        return names
    if isinstance(node, (ast.AnnAssign, ast.AugAssign)):
        return target_names(node.target)
    return []

def inspect_module(tree):
    definitions = []
    imports = []
    for node in tree.body:
        names = definition_names(node)
        if names:
            definitions.append({
                "name": names[0],
                "names": names,
                "start": range_start(node),
                "end": range_end(node),
            })
            continue
        if isinstance(node, ast.Import):
            imports.append({
                "kind": "import",
                "module": "",
                "level": 0,
                "names": [{"name": item.name, "asname": item.asname} for item in node.names],
                "start": range_start(node),
                "end": range_end(node),
            })
            continue
        if isinstance(node, ast.ImportFrom):
            imports.append({
                "kind": "from",
                "module": node.module or "",
                "level": node.level,
                "names": [{"name": item.name, "asname": item.asname} for item in node.names],
                "start": range_start(node),
                "end": range_end(node),
            })
    return {"definitions": definitions, "imports": imports}

def attribute_chain(node):
    chain = []
    current = node
    while isinstance(current, ast.Attribute):
        chain.append(current.attr)
        current = current.value
    if isinstance(current, ast.Name):
        chain.append(current.id)
        chain.reverse()
        return chain
    return []

class UsageVisitor(ast.NodeVisitor):
    def __init__(self):
        self.names = set()
        self.attributes = {}

    def visit_Name(self, node):
        if isinstance(node.ctx, ast.Load):
            self.names.add(node.id)

    def visit_Attribute(self, node):
        chain = attribute_chain(node)
        if len(chain) >= 2:
            self.names.add(chain[0])
            self.attributes.setdefault(chain[0], set()).add(chain[1])
        self.generic_visit(node)

def inspect_usage(tree):
    visitor = UsageVisitor()
    visitor.visit(tree)
    return {
        "names": sorted(visitor.names),
        "attributes": {key: sorted(value) for key, value in visitor.attributes.items()},
    }

try:
    tree = ast.parse(source)
except SyntaxError:
    print(json.dumps({"definitions": [], "imports": []} if mode == "module" else {"names": [], "attributes": {}}))
    raise SystemExit(0)

if mode == "module":
    print(json.dumps(inspect_module(tree)))
else:
    print(json.dumps(inspect_usage(tree)))
`;
