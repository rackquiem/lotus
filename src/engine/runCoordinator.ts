
import { ensureVaultParentFolder, readNoteOrThrow } from "./vaultHost";
import { normalizeVaultPath, sanitizeArtifactSegment } from "./utils/vaultPath";
import { EXECUTION_DISABLED_MESSAGE } from "./serviceHost";
import type { lotusRunCoordinatorHost } from "./serviceHost";
import type { lotusEventLog } from "./eventLog";
import type { lotusReproducibilityService } from "./reproducibilityService";
import { dirname, join } from "path";
import { lotusContainerRunner } from "./execution/containerRunner";
import { runProcess } from "./execution/processRunner";
import { isCompileContainerGroupAllowed, isCompileFeatureAllowed } from "./buildProfile";
import { resolveExecutionContext as resolveLotusExecutionContext } from "./executionContext";
import type { lotusLogTarget } from "./logging";
import { parseMarkdownCodeBlocks } from "./parser";
import { getLanguageCapability } from "./languageCapabilities";
import { findEnabledCommandLanguage } from "./languagePackages";
import { lotusRunnerRegistry } from "./runners/registry";
import { resolveReferencedSource, type lotusExternalSourceExtractor } from "./sourceExtract";
import { runExternalSourcePreprocessorPipeline, type lotusExternalSourcePreprocessor, type lotusPreprocessorPipelineSpec } from "./sourcePreprocess";
import { buildSourceReferenceHarness } from "./sourceHarness";
import { parseDynamicInputDirectives, resolveDynamicInputValues, substituteDynamicInputValues } from "./dynamicInputs";
import { createSourceVisualizationDisplay, createStdoutVisualizationDisplay } from "./visualization/codeGraph";
import { splitCommandLine } from "./utils/command";
import { formatErrorMessage } from "./utils/errors";
import { formatTimeoutLabel, formatTimeoutMs } from "./utils/timeout";
import { renderManagedOutputMarkdown } from "./managedOutput";
import { assertRunnableCodePackage } from "./codePackage";
import { apiBlockFromCodeBlock, apiRunFromStoredOutput, type lotusApiBlock, type lotusApiNote, type lotusApiRun, type lotusApiRunner } from "./apiServer";
import type { lotusCodeBlock, lotusDisplayOutput, lotusPluginSettings, lotusResolvedExecutionContext, lotusRunFile, lotusStdinSession, lotusStoredOutput } from "./types";
import { readOutputFileTarget, renderOutputFileJson, renderOutputFileText } from "./outputFiles";

type lotusVisualizationMode = "graphviz" | "svg";

export interface lotusLiveRunState {
  inputSession: lotusLiveStdinSession | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  runnerName: string;
  notePath: string;
  block: lotusCodeBlock;
  target: lotusLogTarget;
}

export interface lotusRunBlockOptions {
  intent?: "run" | "transpile";
  visualize?: boolean;
  writePolicy?: string;
}

class lotusLiveStdinSession implements lotusStdinSession {
  private readonly writers = new Set<(chunk: string | null) => void>();
  private closed = false;

  attachWriter(writer: (chunk: string | null) => void): () => void {
    if (this.closed) {
      writer(null);
      return () => undefined;
    }
    this.writers.add(writer);
    return () => {
      this.writers.delete(writer);
    };
  }

  send(input: string): boolean {
    if (this.closed) {
      return false;
    }
    for (const writer of this.writers) {
      writer(input);
    }
    return this.writers.size > 0;
  }

  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const writer of this.writers) {
      writer(null);
    }
    this.writers.clear();
  }
}

function decodeEscapedAttribute(value: string): string {
  return value.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
}

function trimLiveOutput(value: string): string {
  const maxLength = 120_000;
  if (value.length <= maxLength) {
    return value;
  }
  return value.slice(value.length - maxLength);
}

function appendWarning(existing: string | undefined, line: string): string {
  return existing ? `${existing}\n${line}` : line;
}

export class lotusRunCoordinator {
  readonly outputs = new Map<string, lotusStoredOutput>();
  readonly liveRuns = new Map<string, lotusLiveRunState>();
  readonly running = new Map<string, AbortController>();
  readonly stdinInputs = new Map<string, string>();
  readonly dynamicInputValues = new Map<string, Record<string, string>>();

  constructor(
    private readonly host: lotusRunCoordinatorHost,
    private readonly registry: lotusRunnerRegistry,
    private readonly containerRunner: lotusContainerRunner,
    private readonly events: lotusEventLog,
    private readonly reproducibility: lotusReproducibilityService,
  ) {}

  private get settings(): lotusPluginSettings {
    return this.host.getSettings();
  }

  shouldShowTranspileButton(block: lotusCodeBlock): boolean {
    return findEnabledCommandLanguage(this.settings, block.language, block.languageAlias)?.mode === "transpile";
  }

  isBlockRunning(blockId: string): boolean {
    return this.running.has(blockId);
  }

  async sendLiveInput(blockId: string, input: string): Promise<void> {
    const liveRun = this.liveRuns.get(blockId);
    if (!liveRun?.inputSession) {
      this.host.notify("This running block is not accepting live input.");
      return;
    }

    const sent = liveRun.inputSession.send(input);
    if (!sent) {
      this.host.notify("The process stdin is not ready.");
      return;
    }

    await this.events.logEvent({
      type: "lotus.run.input",
      message: "Input sent to running block",
      notePath: liveRun.notePath,
      block: liveRun.block,
      target: liveRun.target,
      stdin: input,
      data: {
        bytes: input.length,
      },
    });
  }

  async closeLiveInput(blockId: string): Promise<void> {
    const liveRun = this.liveRuns.get(blockId);
    if (!liveRun?.inputSession) {
      return;
    }

    liveRun.inputSession.close();
    liveRun.inputSession = null;
    this.host.onOutputChanged(blockId);
    await this.events.logEvent({
      type: "lotus.run.input.closed",
      message: "Closed running block input",
      notePath: liveRun.notePath,
      block: liveRun.block,
      target: liveRun.target,
    });
  }

  async cancelBlockRun(blockId: string, source: string, block?: lotusCodeBlock, filePath?: string): Promise<void> {
    const controller = this.running.get(blockId);
    if (!controller) {
      return;
    }

    controller.abort();
    const output = this.outputs.get(blockId);
    await this.events.logEvent({
      type: "lotus.run.cancel.requested",
      message: "Cancellation requested",
      notePath: filePath ?? block?.filePath ?? output?.block.filePath ?? this.host.currentNotePath() ?? undefined,
      block: block ?? output?.block,
      data: {
        source,
        blockId,
      },
    });
    this.host.onOutputChanged(blockId);
    this.host.onRunStateChanged();
    this.host.notify("Lotus cancellation requested.");
  }

  async cancelAllRuns(): Promise<void> {
    const blockIds = [...this.running.keys()];
    for (const blockId of blockIds) {
      this.running.get(blockId)?.abort();
      this.host.onOutputChanged(blockId);
    }
    await this.events.logEvent({
      type: "lotus.run.cancel.requested",
      message: "Cancellation requested for all running blocks",
      notePath: this.host.currentNotePath() ?? undefined,
      data: {
        source: "all",
        count: blockIds.length,
      },
    });
    this.host.onRunStateChanged();
    this.host.notify(`lotus cancellation requested for ${blockIds.length} run${blockIds.length === 1 ? "" : "s"}.`);
  }

  async runAllBlocksInFile(file: lotusRunFile): Promise<void> {
    const source = await readNoteOrThrow(this.host.vault, file.path);
    const blocks = parseMarkdownCodeBlocks(file.path, source, this.settings);
    const supportedBlocks = blocks.filter((block) => {
      const executionContext = this.resolveExecutionContext(file, block);
      return executionContext.containerGroup || this.registry.getRunnerForBlock(block, this.settings);
    });

    if (!supportedBlocks.length) {
      this.host.notify("No supported Lotus blocks found in the current note.");
      return;
    }

    for (const block of supportedBlocks) {
      await this.runBlock(file, block);
    }
  }

  async clearOutputsForFile(file: lotusRunFile): Promise<void> {
    const source = await readNoteOrThrow(this.host.vault, file.path);
    const blocks = parseMarkdownCodeBlocks(file.path, source, this.settings);
    for (const block of blocks) {
      this.outputs.delete(block.id);
      this.host.onOutputChanged(block.id);
      await this.removeManagedOutputBlock(file.path, block.id);
    }
    await this.events.logEvent({
      type: "lotus.note.modified",
      message: "Cleared Lotus outputs",
      notePath: file.path,
      data: {
        action: "outputs.cleared",
        blocks: blocks.length,
      },
    });
    this.host.notify("Lotus outputs cleared.");
  }

  async listApiNotes(query?: string): Promise<lotusApiNote[]> {
    const normalizedQuery = query?.trim().toLowerCase() ?? "";
    const notes: lotusApiNote[] = [];
    for (const file of this.host.vault.listNotes()) {
      if (normalizedQuery && !file.path.toLowerCase().includes(normalizedQuery) && !file.basename.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      const source = await readNoteOrThrow(this.host.vault, file.path);
      const blocks = parseMarkdownCodeBlocks(file.path, source, this.settings)
        .filter((block) => this.isApiRunnableBlock(file, block));
      if (!blocks.length) {
        continue;
      }
      notes.push({
        path: file.path,
        title: file.basename,
        block_count: blocks.length,
        updated_at: new Date(file.stat.mtime).toISOString(),
      });
    }
    return notes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async listApiBlocks(notePath: string): Promise<lotusApiBlock[]> {
    const file = this.host.vault.listNotes().find((note) => note.path === notePath);
    if (!file) {
      throw new Error(`Note not found: ${notePath}`);
    }
    const source = await readNoteOrThrow(this.host.vault, file.path);
    return parseMarkdownCodeBlocks(file.path, source, this.settings)
      .filter((block) => this.isApiRunnableBlock(file, block))
      .map((block) => apiBlockFromCodeBlock(block, this.getApiBlockStatus(block.id)));
  }

  async getApiBlock(blockId: string): Promise<lotusApiBlock | null> {
    const target = await this.findApiBlockById(blockId);
    if (!target) {
      return null;
    }
    return apiBlockFromCodeBlock(target.block, this.getApiBlockStatus(target.block.id), { includeContent: true });
  }

  async updateApiBlockContent(blockId: string, content: string): Promise<lotusApiBlock | null> {
    const target = await this.findApiBlockById(blockId);
    if (!target) {
      return null;
    }

    const source = await readNoteOrThrow(this.host.vault, target.file.path);
    const lines = source.split(/\r?\n/);
    const replacement = content.split(/\r?\n/);
    lines.splice(
      target.block.startLine + 1,
      Math.max(0, target.block.endLine - target.block.startLine - 1),
      ...replacement,
    );
    const nextSource = lines.join("\n");
    await this.host.vault.writeNote(target.file.path, nextSource);
    this.outputs.delete(target.block.id);
    this.host.onOutputChanged(target.block.id);
    await this.reproducibility.writeCodeBlockHashesIfEnabled(target.file);

    const updatedSource = await readNoteOrThrow(this.host.vault, target.file.path);
    const updatedBlock = parseMarkdownCodeBlocks(target.file.path, updatedSource, this.settings)
      .filter((block) => this.isApiRunnableBlock(target.file, block))
      .find((block) => block.ordinal === target.block.ordinal);
    return updatedBlock
      ? apiBlockFromCodeBlock(updatedBlock, this.getApiBlockStatus(updatedBlock.id), { includeContent: true })
      : null;
  }

  async listApiRunners(): Promise<lotusApiRunner[]> {
    const builtIn = this.registry.getSupportedLanguages()
      .sort((a, b) => a.localeCompare(b))
      .map((language) => ({
        id: `obsidian:${language}`,
        name: `Lotus Obsidian ${language}`,
        language,
        source: "obsidian-plugin",
        command: null,
        executable: null,
        available: true,
        message: "Available through the Obsidian plugin",
      }));
    const custom = this.settings.customLanguages
      .map((language) => ({
        id: `obsidian:custom:${language.name}`,
        name: language.name,
        language: language.name,
        source: "obsidian-custom-language",
        command: [language.executable, language.args].filter(Boolean).join(" ") || null,
        executable: language.executable || null,
        available: true,
        message: "Configured custom Lotus language",
      }));
    return [...builtIn, ...custom];
  }

  async runApiBlock(blockId: string, options: lotusRunBlockOptions = {}): Promise<lotusApiRun> {
    const target = await this.findApiBlockById(blockId);
    if (!target) {
      throw new Error(`Block not found: ${blockId}`);
    }
    const output = await this.runBlock(target.file, target.block, options);
    if (output) {
      return apiRunFromStoredOutput(output);
    }
    const run = await this.getApiRun(blockId);
    if (!run) {
      throw new Error(`Run did not produce output: ${blockId}`);
    }
    return run;
  }

  async cancelApiRun(runId: string): Promise<lotusApiRun | null> {
    const block = await this.findApiBlockById(runId);
    if (this.running.has(runId)) {
      await this.cancelBlockRun(runId, "api", block?.block, block?.file.path);
    }
    return this.getApiRun(runId);
  }

  async listApiRuns(): Promise<lotusApiRun[]> {
    const liveRuns = [...this.liveRuns.entries()].map(([blockId, run]) => ({
      id: blockId,
      block_id: blockId,
      note_path: run.notePath,
      status: "running" as const,
      runner_id: run.target.runnerId ?? "pending",
      runner_name: run.runnerName,
      started_at: run.startedAt,
      finished_at: null,
      exit_code: null,
      duration_ms: null,
      stdout: run.stdout,
      stderr: run.stderr,
      warning: null,
    }));
    const storedRuns = [...this.outputs.values()].map(apiRunFromStoredOutput);
    const seen = new Set(liveRuns.map((run) => run.id));
    return [
      ...liveRuns,
      ...storedRuns.filter((run) => !seen.has(run.id)),
    ];
  }

  async getApiRun(runId: string): Promise<lotusApiRun | null> {
    const liveRun = this.liveRuns.get(runId);
    if (liveRun) {
      return {
        id: runId,
        block_id: runId,
        note_path: liveRun.notePath,
        status: "running",
        runner_id: liveRun.target.runnerId ?? "pending",
        runner_name: liveRun.runnerName,
        started_at: liveRun.startedAt,
        finished_at: null,
        exit_code: null,
        duration_ms: null,
        stdout: liveRun.stdout,
        stderr: liveRun.stderr,
        warning: null,
      };
    }
    const output = this.outputs.get(runId);
    return output ? apiRunFromStoredOutput(output) : null;
  }

  isApiRunnableBlock(file: lotusRunFile, block: lotusCodeBlock): boolean {
    const executionContext = this.resolveExecutionContext(file, block);
    return Boolean(executionContext.containerGroup || this.registry.getRunnerForBlock(block, this.settings));
  }

  getApiBlockStatus(blockId: string): lotusApiBlock["status"] {
    if (this.running.has(blockId)) {
      return "running";
    }
    const output = this.outputs.get(blockId);
    if (!output) {
      return "idle";
    }
    if (output.result.cancelled) {
      return "cancelled";
    }
    return output.result.success ? "succeeded" : "failed";
  }

  async findApiBlockById(blockId: string): Promise<{ file: lotusRunFile; block: lotusCodeBlock } | null> {
    for (const file of this.host.vault.listNotes()) {
      const source = await readNoteOrThrow(this.host.vault, file.path);
      const block = parseMarkdownCodeBlocks(file.path, source, this.settings)
        .find((candidate) => candidate.id === blockId);
      if (block) {
        return { file, block };
      }
    }
    return null;
  }

  async runBlock(file: lotusRunFile, block: lotusCodeBlock, options: lotusRunBlockOptions = {}): Promise<lotusStoredOutput | null> {
    this.host.onRunStarted?.(file);
    if (this.running.has(block.id)) {
      this.host.notify("This Lotus block is already running.");
      return this.outputs.get(block.id) ?? null;
    }

    if (!(await this.host.ensureExecutionEnabled())) {
      this.host.notify(EXECUTION_DISABLED_MESSAGE);
      return null;
    }
    if (options.intent === "transpile" && !this.shouldShowTranspileButton(block)) {
      this.host.notify("This block is not configured for transpile mode.");
      return null;
    }

    const executionContext = this.resolveExecutionContext(file, block);
    const containerGroup = executionContext.containerGroup;
    const controller = new AbortController();
    const stdin = await this.resolveBlockStdin(file, block);
    let runnerName = containerGroup ? `execution group ${containerGroup}` : "preparing";
    let runnerId = containerGroup ? `container:${containerGroup}` : "pending";
    const noteHash = await this.events.readCurrentNoteHash(file.path);
    let logTarget: lotusLogTarget = {
      runnerId,
      runnerName,
      containerGroup,
      workingDirectory: executionContext.workingDirectory,
      timeoutMs: executionContext.timeoutMs,
      source: executionContext.source,
    };
    const inputSession = stdin == null ? new lotusLiveStdinSession() : null;
    const liveRun: lotusLiveRunState = {
      inputSession,
      stdout: "",
      stderr: "",
      startedAt: new Date().toISOString(),
      runnerName,
      notePath: file.path,
      block,
      target: logTarget,
    };
    const appendLiveOutput = (stream: "stdout" | "stderr", chunk: string) => {
      liveRun[stream] = trimLiveOutput(liveRun[stream] + chunk);
      this.host.onOutputChanged(block.id);
    };
    const runContext = {
      file,
      workingDirectory: executionContext.workingDirectory,
      timeoutMs: executionContext.timeoutMs,
      signal: controller.signal,
      stdin,
      stdinSession: inputSession ?? undefined,
      onStdout: (chunk: string) => appendLiveOutput("stdout", chunk),
      onStderr: (chunk: string) => appendLiveOutput("stderr", chunk),
    };
    this.running.set(block.id, controller);
    this.liveRuns.set(block.id, liveRun);
    this.host.onOutputChanged(block.id);
    this.host.onRunStateChanged();

    let storedOutput: lotusStoredOutput | null = null;
    try {
      const resolvedBlock = await this.resolveExecutableBlock(file, block, controller.signal);
      const runner = containerGroup ? null : this.registry.getRunnerForBlock(resolvedBlock.block, this.settings);
      if (!containerGroup && !runner) {
        throw new Error(`No configured runner for ${resolvedBlock.block.language}.`);
      }

      runnerName = containerGroup ? `execution group ${containerGroup}` : runner!.displayName;
      runnerId = containerGroup ? `container:${containerGroup}` : runner!.id;
      logTarget = {
        ...logTarget,
        runnerId,
        runnerName,
      };
      liveRun.runnerName = runnerName;
      liveRun.target = logTarget;
      this.host.onOutputChanged(block.id);
      await this.events.logEvent({
        type: "lotus.run.started",
        message: "Code block started",
        notePath: file.path,
        noteHash,
        block: resolvedBlock.block,
        target: logTarget,
        stdin,
        data: {
          runnerName,
          containerGroup,
          workingDirectory: executionContext.workingDirectory,
          timeoutMs: executionContext.timeoutMs,
          stdinBytes: stdin?.length ?? 0,
          intent: options.intent ?? "run",
          noteHash,
          sourceLanguage: block.language,
          executionLanguage: resolvedBlock.block.language,
        },
      });
      const result = containerGroup
        ? await this.containerRunner.run(resolvedBlock.block, runContext, this.settings, containerGroup)
        : await runner!.run(resolvedBlock.block, runContext, this.settings);

      if (result.timedOut) {
        result.stderr = result.stderr || `Execution timed out after ${formatTimeoutMs(executionContext.timeoutMs)}.`;
      } else if (result.cancelled) {
        result.stderr = result.stderr || "Execution cancelled.";
      } else if (!result.success && !result.stderr.trim()) {
        result.stderr = "Process exited unsuccessfully.";
      }

      if (resolvedBlock.sourcePreview) {
        const sourceNotice = `Ran extracted source from ${resolvedBlock.sourcePreview.description}.`;
        result.warning = result.warning ? `${sourceNotice}\n${result.warning}` : sourceNotice;
      }
      if (resolvedBlock.preprocessDescription) {
        const preprocessorNotice = `Ran preprocessed source with ${resolvedBlock.preprocessDescription}.`;
        result.warning = result.warning ? `${preprocessorNotice}\n${result.warning}` : preprocessorNotice;
      }
      if (this.hasExplicitExecutionContext(executionContext)) {
        const contextNotice = this.formatExecutionContextNotice(executionContext);
        result.warning = result.warning ? `${contextNotice}\n${result.warning}` : contextNotice;
      }
      await this.prepareDisplayOutputs(file, block, result, executionContext, controller.signal, options);
      await this.writeOutputFileIfRequested(file, block, result);

      storedOutput = {
        blockId: block.id,
        block,
        result,
        sourcePreview: resolvedBlock.sourcePreview,
        collapsed: false,
        visible: true,
      };
      this.outputs.set(block.id, storedOutput);

      const requestedWrite = options.writePolicy === "write-replace" || options.writePolicy === "write-append";
      if (this.settings.writeOutputToNote || requestedWrite) {
        await this.writeManagedOutputBlock(file, block, result, options.writePolicy === "write-append" ? "append" : "replace");
      }

      await this.events.logger.logRunFinished(file.path, block, runnerName, result, {
        containerGroup,
        workingDirectory: executionContext.workingDirectory,
        timeoutMs: executionContext.timeoutMs,
        sourceReference: Boolean(block.sourceReference),
        executionLanguage: resolvedBlock.block.language,
        intent: options.intent ?? "run",
        noteHash,
      }, logTarget, await this.events.readCurrentNoteHash(file.path));
      const transpiled = options.intent === "transpile" || result.stdoutRole === "transpiled-source";
      this.host.notify(result.success
        ? transpiled ? `lotus transpiled ${block.language} block.` : `lotus ran ${runnerName} block.`
        : transpiled ? `lotus transpile failed for ${block.language}.` : `lotus run failed for ${runnerName}.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      storedOutput = {
        blockId: block.id,
        block,
        collapsed: false,
        visible: true,
        result: {
          runnerId,
          runnerName,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          durationMs: 0,
          exitCode: -1,
          stdout: "",
          stderr: message,
          success: false,
          timedOut: false,
          cancelled: false,
        },
      };
      this.outputs.set(block.id, storedOutput);
      await this.events.logEvent({
        type: "lotus.run.failed",
        message: "Code block failed before result",
        notePath: file.path,
        noteHash,
        block,
        target: logTarget,
        stdin,
        error: message,
        data: {
          runnerName,
          containerGroup,
          workingDirectory: executionContext.workingDirectory,
          timeoutMs: executionContext.timeoutMs,
        },
      });
      this.host.notify(`lotus error: ${message}`);
    } finally {
      inputSession?.close();
      this.liveRuns.delete(block.id);
      await this.reproducibility.writeCodeBlockHashesIfEnabled(file);
      this.running.delete(block.id);
      this.host.onOutputChanged(block.id);
      this.host.onRunStateChanged();
    }
    return storedOutput;
  }

  async visualizeBlock(file: lotusRunFile, block: lotusCodeBlock): Promise<void> {
    this.host.onRunStarted?.(file);
    if (!isCompileFeatureAllowed("rich-displays")) {
      this.host.notify("Lotus rich displays are not included in this build.");
      return;
    }

    if (this.running.has(block.id)) {
      this.host.notify("This Lotus block is already running.");
      return;
    }

    const executionContext = this.resolveExecutionContext(file, block);
    if ((executionContext.containerGroup || this.settings.graphvizExecutable.trim()) && !(await this.host.ensureExecutionEnabled())) {
      this.host.notify(EXECUTION_DISABLED_MESSAGE);
      return;
    }

    const controller = new AbortController();
    const started = Date.now();
    const startedAt = new Date().toISOString();
    const result: lotusStoredOutput["result"] = {
      runnerId: "visualization:source",
      runnerName: "Code visualization",
      startedAt,
      finishedAt: startedAt,
      durationMs: 0,
      exitCode: 0,
      stdout: "",
      stderr: "",
      success: true,
      timedOut: false,
      cancelled: false,
      displays: [createSourceVisualizationDisplay(block)],
    };

    this.running.set(block.id, controller);
    this.host.onOutputChanged(block.id);
    this.host.onRunStateChanged();

    try {
      result.displays = await Promise.all(
        (result.displays ?? []).map((display) => this.enrichGraphvizDisplay(display, file, block, executionContext, controller.signal, result)),
      );
      result.finishedAt = new Date().toISOString();
      result.durationMs = Date.now() - started;
      this.outputs.set(block.id, {
        blockId: block.id,
        block,
        result,
        collapsed: false,
        visible: true,
      });
      await this.events.logger.logRunFinished(file.path, block, result.runnerName, result, {
        visualization: "source",
        language: block.language,
      }, {
          runnerId: result.runnerId,
          runnerName: result.runnerName,
          containerGroup: executionContext.containerGroup,
          workingDirectory: executionContext.workingDirectory,
          timeoutMs: executionContext.timeoutMs,
          source: executionContext.source,
      }, await this.events.readCurrentNoteHash(file.path));
      this.host.notify(`lotus visualized ${block.language} block.`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result.success = false;
      result.exitCode = -1;
      result.stderr = message;
      result.finishedAt = new Date().toISOString();
      result.durationMs = Date.now() - started;
      this.outputs.set(block.id, {
        blockId: block.id,
        block,
        result,
        collapsed: false,
        visible: true,
      });
      this.host.notify(`lotus visualization failed: ${message}`);
    } finally {
      this.running.delete(block.id);
      this.host.onOutputChanged(block.id);
      this.host.onRunStateChanged();
    }
  }

  async prepareDisplayOutputs(
    file: lotusRunFile,
    block: lotusCodeBlock,
    result: lotusStoredOutput["result"],
    executionContext: lotusResolvedExecutionContext,
    signal: AbortSignal,
    options: lotusRunBlockOptions,
  ): Promise<void> {
    if (!isCompileFeatureAllowed("rich-displays")) {
      delete result.displays;
      return;
    }

    const displays = [...(result.displays ?? [])];
    const requestedMode = this.readVisualizationMode(block, options.visualize);

    if (requestedMode && !displays.length) {
      const synthesized = this.createDisplayFromStdout(result.stdout, requestedMode)
        ?? (requestedMode === "graphviz" ? createSourceVisualizationDisplay(block) : null);
      if (synthesized) {
        displays.push(synthesized);
      }
    }

    const enriched: lotusDisplayOutput[] = [];
    for (const display of displays) {
      enriched.push(await this.enrichGraphvizDisplay(display, file, block, executionContext, signal, result));
    }

    if (enriched.length) {
      result.displays = enriched;
    } else {
      delete result.displays;
    }
  }

  readVisualizationMode(block: lotusCodeBlock, explicitVisualize: boolean | undefined): lotusVisualizationMode | null {
    const raw = block.attributes["lotus-visualize"]
      ?? block.attributes.visualize
      ?? block.attributes["lotus-display"]
      ?? block.attributes.display
      ?? block.attributes["lotus-visualizer"]
      ?? block.attributes.visualizer;
    const normalized = raw?.trim().toLowerCase();

    if (normalized) {
      if (["graphviz", "dot", "gv", "cfg"].includes(normalized)) {
        return "graphviz";
      }
      if (normalized === "svg" || normalized === "image/svg+xml") {
        return "svg";
      }
      if (["0", "false", "no", "off", "none"].includes(normalized)) {
        return null;
      }
    }

    return explicitVisualize ? "graphviz" : null;
  }

  createDisplayFromStdout(stdout: string, mode: lotusVisualizationMode): lotusDisplayOutput | null {
    return createStdoutVisualizationDisplay(stdout, mode);
  }

  async enrichGraphvizDisplay(
    display: lotusDisplayOutput,
    file: lotusRunFile,
    block: lotusCodeBlock,
    executionContext: lotusResolvedExecutionContext,
    signal: AbortSignal,
    result: lotusStoredOutput["result"],
  ): Promise<lotusDisplayOutput> {
    if (display.data["image/svg+xml"] != null) {
      return display;
    }

    const dot = typeof display.data["text/vnd.graphviz"] === "string" ? display.data["text/vnd.graphviz"] : "";
    const executable = this.settings.graphvizExecutable?.trim();
    if (!dot.trim() || (!executionContext.containerGroup && !executable)) {
      return display;
    }

    try {
      const svg = await this.renderGraphvizSvg(dot, executable || "dot", file, block, executionContext, signal);
      return {
        ...display,
        data: {
          ...display.data,
          "image/svg+xml": svg,
        },
      };
    } catch (error) {
      result.warning = appendWarning(result.warning, `Graphviz display render failed: ${formatErrorMessage(error)}`);
      return display;
    }
  }

  async renderGraphvizSvg(
    dot: string,
    executable: string,
    file: lotusRunFile,
    block: lotusCodeBlock,
    executionContext: lotusResolvedExecutionContext,
    signal: AbortSignal,
  ): Promise<string> {
    const containerGroup = executionContext.containerGroup;
    if (containerGroup) {
      const containerResult = await this.containerRunner.run(this.createGraphvizBlock(block, dot), {
        file,
        workingDirectory: executionContext.workingDirectory,
        timeoutMs: executionContext.timeoutMs,
        signal,
      }, this.settings, containerGroup);
      if (!containerResult.success) {
        throw new Error(containerResult.stderr || containerResult.stdout || `Graphviz exited with ${containerResult.exitCode ?? "unknown status"}`);
      }
      const containerSvg = containerResult.stdout.trim();
      if (!containerSvg) {
        throw new Error("Graphviz produced no SVG output.");
      }
      return containerSvg;
    }

    const result = await runProcess({
      runnerId: "display:graphviz",
      runnerName: "Graphviz",
      executable,
      args: ["-Tsvg"],
      workingDirectory: executionContext.workingDirectory,
      timeoutMs: executionContext.timeoutMs,
      signal,
      stdin: dot,
    });

    if (!result.success) {
      throw new Error(result.stderr || result.stdout || `Graphviz exited with ${result.exitCode ?? "unknown status"}`);
    }

    const svg = result.stdout.trim();
    if (!svg) {
      throw new Error("Graphviz produced no SVG output.");
    }
    return svg;
  }

  createGraphvizBlock(block: lotusCodeBlock, dot: string): lotusCodeBlock {
    return {
      ...block,
      id: `${block.id}:graphviz`,
      language: "graphviz",
      languageAlias: "graphviz",
      sourceLanguage: "graphviz",
      content: dot,
      attributes: {},
      executionContext: {},
    };
  }

  async resolveExecutableBlock(file: lotusRunFile, block: lotusCodeBlock, signal?: AbortSignal): Promise<{ block: lotusCodeBlock; sourcePreview?: lotusStoredOutput["sourcePreview"]; preprocessDescription?: string }> {
    assertRunnableCodePackage(block);
    let executableBlock = block;
    let sourcePreview: lotusStoredOutput["sourcePreview"] | undefined;
    const shouldShowPreview = (this.settings.extractedSourcePreviewMode || "collapsed") !== "hidden";

    if (block.sourceReference) {
      const referencePath = this.resolveReferencedVaultPath(file, block.sourceReference.filePath);
      if (!this.host.vault.noteExists(referencePath)) {
        throw new Error(`Referenced source file not found: ${referencePath}`);
      }

      const harness = buildSourceReferenceHarness(block, this.resolveBlockFunctionInput(block));
      const externalExtractor = this.getCustomLanguageExtractor(block, file);
      const resolved = await resolveReferencedSource(
        await readNoteOrThrow(this.host.vault, referencePath),
        { ...block.sourceReference, filePath: referencePath },
        block.language,
        harness,
        {
          pythonExecutable: this.settings.pythonExecutable.trim() || "python3",
          externalExtractor,
          readFile: async (filePath) => {
            return this.host.vault.readNote(normalizeVaultPath(filePath));
          },
          resolvePythonImport: async (fromFilePath, moduleName, level) => this.resolvePythonImportVaultPath(fromFilePath, moduleName, level),
        },
      );
      executableBlock = {
        ...block,
        content: resolved.content,
      };
      const capability = getLanguageCapability(block.language, Boolean(externalExtractor));
      sourcePreview = shouldShowPreview ? {
        description: resolved.description,
        language: block.language,
        content: resolved.content,
        capability,
        expanded: this.settings.extractedSourcePreviewMode === "expanded",
        showCapabilityMetadata: this.settings.showLanguageCapabilityMetadata ?? true,
      } : undefined;
    }

    executableBlock = this.applyDynamicInputPreprocessor(block, executableBlock);
    if (sourcePreview) {
      sourcePreview.content = executableBlock.content;
    }

    const preprocessorPipeline = this.getCustomLanguagePreprocessorPipeline(block, file, signal);
    if (!preprocessorPipeline) {
      return { block: executableBlock, sourcePreview };
    }

    const preprocessed = await runExternalSourcePreprocessorPipeline(executableBlock.content, executableBlock, preprocessorPipeline);
    const preprocessDescription = `${preprocessed.description || preprocessorPipeline.languageName} (artifacts: ${preprocessed.artifactDirectory})`;
    const capability = getLanguageCapability(preprocessed.block.language);
    return {
      block: preprocessed.block,
      sourcePreview: shouldShowPreview
        ? {
          description: sourcePreview
            ? `${sourcePreview.description}; preprocessed by ${preprocessed.description || preprocessorPipeline.languageName}`
            : `preprocessed by ${preprocessed.description || preprocessorPipeline.languageName}`,
          language: preprocessed.block.language,
          content: preprocessed.block.content,
          capability,
          stages: preprocessed.stages,
          expanded: this.settings.extractedSourcePreviewMode === "expanded",
          showCapabilityMetadata: this.settings.showLanguageCapabilityMetadata ?? true,
        }
        : undefined,
      preprocessDescription,
    };
  }

  applyDynamicInputPreprocessor(block: lotusCodeBlock, executableBlock: lotusCodeBlock): lotusCodeBlock {
    const blockDirectives = parseDynamicInputDirectives(block.content);
    const executableDirectives = executableBlock.content === block.content
      ? blockDirectives
      : parseDynamicInputDirectives(executableBlock.content);
    const errors = [...blockDirectives.errors];
    if (executableDirectives !== blockDirectives) {
      errors.push(...executableDirectives.errors);
    }
    if (errors.length) {
      throw new Error(errors.join("\n"));
    }

    const inputs = [...blockDirectives.inputs];
    const knownNames = new Set(inputs.flatMap((input) => input.name ? [input.name] : []));
    if (executableDirectives !== blockDirectives) {
      for (const input of executableDirectives.inputs) {
        if (!input.name || !knownNames.has(input.name)) {
          inputs.push(input);
          if (input.name) knownNames.add(input.name);
        }
      }
    }

    const values = resolveDynamicInputValues(inputs, this.dynamicInputValues.get(block.id));
    if (inputs.length) {
      this.dynamicInputValues.set(block.id, values);
    }
    const content = substituteDynamicInputValues(executableDirectives.source, values);
    const codePackage = executableBlock.codePackage
      ? {
        ...executableBlock.codePackage,
        files: executableBlock.codePackage.files.map((file) => {
          const parsed = parseDynamicInputDirectives(file.content);
          if (parsed.errors.length) {
            throw new Error(parsed.errors.join("\n"));
          }
          const fileValues = resolveDynamicInputValues(parsed.inputs, values);
          return {
            ...file,
            content: substituteDynamicInputValues(parsed.source, { ...fileValues, ...values }),
          };
        }),
      }
      : undefined;

    return {
      ...executableBlock,
      content,
      codePackage,
    };
  }

  resolveReferencedVaultPath(file: lotusRunFile, referencePath: string): string {
    const trimmed = referencePath.trim();
    if (!trimmed) {
      return trimmed;
    }
    if (trimmed.startsWith("/")) {
      return normalizeVaultPath(trimmed.slice(1));
    }

    const baseDir = dirname(file.path);
    return normalizeVaultPath(baseDir === "." ? trimmed : `${baseDir}/${trimmed}`);
  }

  resolvePythonImportVaultPath(fromFilePath: string, moduleName: string, level: number): string | null {
    const modulePath = moduleName
      .split(".")
      .map((part) => part.trim())
      .filter(Boolean)
      .join("/");
    const fromDir = dirname(fromFilePath);
    const baseDirs = level > 0
      ? [this.ascendVaultPath(fromDir === "." ? "" : fromDir, level - 1)]
      : [fromDir === "." ? "" : fromDir, ""];

    for (const baseDir of baseDirs) {
      const candidates = this.getPythonImportCandidates(baseDir, modulePath);
      for (const candidate of candidates) {
        const normalized = normalizeVaultPath(candidate);
        if (this.host.vault.noteExists(normalized)) {
          return normalized;
        }
      }
    }

    return null;
  }

  getPythonImportCandidates(baseDir: string, modulePath: string): string[] {
    const prefix = baseDir ? `${baseDir}/` : "";
    if (!modulePath) {
      return [`${prefix}__init__.py`];
    }
    return [
      `${prefix}${modulePath}.py`,
      `${prefix}${modulePath}/__init__.py`,
    ];
  }

  ascendVaultPath(path: string, levels: number): string {
    let current = path;
    for (let index = 0; index < levels; index += 1) {
      const next = dirname(current);
      current = next === "." ? "" : next;
    }
    return current;
  }

  resolveExecutionContext(file: lotusRunFile, block: lotusCodeBlock): lotusResolvedExecutionContext {
    const context = resolveLotusExecutionContext(this.host.vault, file, block, this.settings);
    if (block.language === "obsidian-js" && context.source.container === "global") {
      return {
        ...context,
        containerGroup: undefined,
        source: {
          ...context.source,
          container: "none",
        },
      };
    }
    if (isCompileFeatureAllowed("container-groups") && (!context.containerGroup || isCompileContainerGroupAllowed(context.containerGroup))) {
      return context;
    }

    return {
      ...context,
      containerGroup: undefined,
      source: {
        ...context.source,
        container: "none",
      },
    };
  }

  hasExplicitExecutionContext(context: lotusResolvedExecutionContext): boolean {
    return context.source.container !== "none" || context.source.workingDirectory !== "default" || context.source.timeout !== "global";
  }

  formatExecutionContextNotice(context: lotusResolvedExecutionContext): string {
    const pieces = [
      `execution=${context.containerGroup ?? "native"} (${context.source.container})`,
      `cwd=${context.workingDirectory} (${context.source.workingDirectory})`,
      `timeout=${formatTimeoutLabel(context.timeoutMs)} (${context.source.timeout})`,
    ];
    return `Execution context: ${pieces.join(", ")}.`;
  }

  getCustomLanguageExtractor(block: lotusCodeBlock, file: lotusRunFile): lotusExternalSourceExtractor | undefined {
    const language = findEnabledCommandLanguage(this.settings, block.language, block.languageAlias);
    if (!language) {
      return undefined;
    }

    const mode = language.extractorMode || "command";
    const executable = mode === "transpile-c" ? language.transpileExecutable?.trim() : language.extractorExecutable?.trim();
    const args = mode === "transpile-c" ? language.transpileArgs || "{request}" : language.extractorArgs || "{request}";
    if (!executable) {
      return undefined;
    }

    const executionContext = this.resolveExecutionContext(file, block);
    return {
      mode,
      language: language.name,
      executable,
      args: splitCommandLine(args),
      workingDirectory: executionContext.workingDirectory,
      timeoutMs: executionContext.timeoutMs,
    };
  }

  getCustomLanguagePreprocessorPipeline(block: lotusCodeBlock, file: lotusRunFile, signal?: AbortSignal): lotusPreprocessorPipelineSpec | undefined {
    const language = findEnabledCommandLanguage(this.settings, block.language, block.languageAlias);
    if (!language) {
      return undefined;
    }

    const stages = this.getCustomLanguagePreprocessorStages(language);
    if (!stages.length) {
      return undefined;
    }
    const executionContext = this.resolveExecutionContext(file, block);
    return {
      languageName: language.name,
      initialExtension: language.extension || language.name,
      stages,
      artifactDirectory: this.getPreprocessorArtifactDirectory(file, block, executionContext),
      workingDirectory: executionContext.workingDirectory,
      timeoutMs: executionContext.timeoutMs,
      signal,
    };
  }

  getCustomLanguagePreprocessorStages(language: NonNullable<ReturnType<typeof findEnabledCommandLanguage>>): lotusExternalSourcePreprocessor[] {
    const stages = (language.preprocessors ?? [])
      .filter((stage) => stage.executable.trim())
      .map((stage, index) => ({
        name: stage.name.trim() || `stage-${index + 1}`,
        executable: stage.executable.trim(),
        args: stage.args || "{request}",
        language: stage.language?.trim(),
        extension: stage.extension?.trim(),
      }));
    if (stages.length) {
      return stages;
    }

    const executable = language.preprocessorExecutable?.trim();
    if (!executable) {
      return [];
    }
    return [{
      name: "preprocess",
      executable,
      args: language.preprocessorArgs || "{request}",
      language: language.preprocessorLanguage?.trim(),
      extension: language.preprocessorExtension?.trim(),
    }];
  }

  getPreprocessorArtifactDirectory(file: lotusRunFile, block: lotusCodeBlock, executionContext: lotusResolvedExecutionContext): string {
    const vaultBasePath = this.host.vault.vaultBasePath;
    const root = vaultBasePath || executionContext.workingDirectory || process.cwd();
    return join(root, ".lotus", "preprocess", sanitizeArtifactSegment(file.path), `block-${block.ordinal}-${sanitizeArtifactSegment(block.sourceLanguage || block.language)}`);
  }

  async writeManagedOutputBlock(file: lotusRunFile, block: lotusCodeBlock, result: lotusStoredOutput["result"], mode: "replace" | "append" = "replace"): Promise<void> {
    await this.host.vault.processNote(file.path, (content) => {
      const lines = content.split(/\r?\n/);
      const blocks = parseMarkdownCodeBlocks(file.path, content, this.settings);
      const currentBlock = blocks.find((candidate) => candidate.id === block.id);
      const rendered = this.renderManagedOutputMarkdown(block.id, result);
      const existingRange = this.findManagedOutputRange(lines, block.id);

      if (existingRange && mode === "replace") {
        lines.splice(existingRange.start, existingRange.end - existingRange.start + 1, ...rendered);
        return lines.join("\n");
      }

      if (!currentBlock) {
        return content;
      }

      lines.splice(currentBlock.endLine + 1, 0, ...rendered);
      return lines.join("\n");
    });
    await this.events.logEvent({
      type: "lotus.output.written",
      message: "Wrote managed output to note",
      notePath: file.path,
      block,
      stdout: result.stdout,
      stderr: result.stderr,
      warning: result.warning,
      data: {
        destination: "note",
        success: result.success,
        exitCode: result.exitCode,
      },
    });
    await this.events.logEvent({
      type: "lotus.note.modified",
      message: "Inserted managed output section",
      notePath: file.path,
      block,
      data: {
        action: "output.written",
      },
    });
  }

  async writeOutputFileIfRequested(file: lotusRunFile, block: lotusCodeBlock, result: lotusStoredOutput["result"]): Promise<void> {
    try {
      const target = readOutputFileTarget(this.host.vault.configDir, file, block);
      if (!target) {
        return;
      }

      await ensureVaultParentFolder(this.host.vault, target.path);
      const rendered = target.format === "json"
        ? renderOutputFileJson(file, block, result, target)
        : renderOutputFileText(result, target);
      const current = target.mode === "append" && await this.host.vault.exists(target.path)
        ? await this.host.vault.read(target.path)
        : "";
      const next = target.mode === "append" && current
        ? `${current.replace(/\s*$/, "\n")}${rendered}`
        : rendered;
      await this.host.vault.write(target.path, next);
      await this.events.logEvent({
        type: "lotus.output.file.written",
        message: "Wrote Lotus output file",
        notePath: file.path,
        block,
        stdout: result.stdout,
        stderr: result.stderr,
        warning: result.warning,
        data: {
          path: target.path,
          mode: target.mode,
          format: target.format,
          streams: target.streams,
          success: result.success,
          exitCode: result.exitCode,
        },
      });

      const streamList = target.streams.join(",");
      const notice = `Wrote output file ${target.path} (${target.mode}, ${target.format}, ${streamList}).`;
      result.warning = result.warning ? `${notice}\n${result.warning}` : notice;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const notice = `Failed to write output file: ${message}`;
      result.warning = result.warning ? `${notice}\n${result.warning}` : notice;
    }
  }

  async removeManagedOutputBlock(filePath: string, blockId: string): Promise<void> {
    if (!this.host.vault.noteExists(filePath)) {
      return;
    }

    await this.host.vault.processNote(filePath, (content) => {
      const lines = content.split(/\r?\n/);
      const range = this.findManagedOutputRange(lines, blockId);
      if (!range) {
        return content;
      }
      lines.splice(range.start, range.end - range.start + 1);
      return lines.join("\n");
    });
  }

  renderManagedOutputMarkdown(blockId: string, result: lotusStoredOutput["result"]): string[] {
    return renderManagedOutputMarkdown(blockId, result);
  }

  findManagedOutputRange(lines: string[], blockId: string): { start: number; end: number } | null {
    const startMarker = `<!-- lotus:output:start id=${blockId} -->`;
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].trim() !== startMarker) {
        continue;
      }

      for (let j = i + 1; j < lines.length; j += 1) {
        if (lines[j].trim() === "<!-- lotus:output:end -->") {
          return { start: i, end: j };
        }
      }
    }
    return null;
  }

  isFunctionInputBlock(block: lotusCodeBlock): boolean {
    return Boolean(block.sourceReference?.call);
  }

  resolveBlockFunctionInput(block: lotusCodeBlock): string | undefined {
    if (!this.isFunctionInputBlock(block)) {
      return undefined;
    }
    if (this.stdinInputs.has(block.id)) {
      return this.stdinInputs.get(block.id);
    }

    const inline = block.attributes["lotus-input"] ?? block.attributes.input;
    return inline != null ? decodeEscapedAttribute(inline) : block.content.trim();
  }

  async resolveBlockStdin(file: lotusRunFile, block: lotusCodeBlock): Promise<string | undefined> {
    if (!this.isFunctionInputBlock(block) && this.stdinInputs.has(block.id)) {
      return this.stdinInputs.get(block.id);
    }

    const inline = block.attributes["lotus-stdin"] ?? block.attributes.stdin;
    if (inline != null) {
      return decodeEscapedAttribute(inline);
    }

    const stdinFile = block.attributes["lotus-stdin-file"] ?? block.attributes["stdin-file"];
    if (!stdinFile?.trim()) {
      return undefined;
    }

    const stdinPath = this.resolveReferencedVaultPath(file, stdinFile);
    const stdin = await this.host.vault.readNote(stdinPath);
    if (stdin == null) {
      throw new Error(`stdin file not found: ${stdinPath}`);
    }
    return stdin;
  }
}
