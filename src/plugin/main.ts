import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath, parseYaml, requestUrl, type DataAdapter, type MarkdownPostProcessorContext } from "obsidian";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { join } from "path";
import { lotusContainerRunner, type lotusContainerGroupSummary } from "../engine/execution/containerRunner";
import { isCompileContainerGroupAllowed, isCompileFeatureAllowed } from "../engine/buildProfile";
import { addLlvmDecorations, highlightLlvmElement } from "./llvmHighlight";
import { lotusLogger } from "../engine/logging";
import { resolveBlockHighlightLanguage } from "../engine/languageHighlight";
import { findBlockAtLine, normalizeLanguage, parseMarkdownCodeBlocks } from "../engine/parser";
import { ObsidianContextRunner } from "./runners/obsidianContext";
import { CustomLanguageRunner } from "../engine/runners/custom";
import { createBuiltInRunners } from "../engine/runners/builtIn";
import { lotusRunnerRegistry } from "../engine/runners/registry";
import { DEFAULT_SETTINGS } from "../engine/defaultSettings";
import { lotusSettingTab } from "./settings";
import { parseDynamicInputDirectives, resolveDynamicInputValues, type lotusDynamicInput } from "../engine/dynamicInputs";
import { createCodeBlockToolbar } from "./ui/codeBlockToolbar";
import { LOTUS_LOG_VIEW_TYPE, lotusLogView } from "./ui/logView";
import { createOutputPanel, createRunningPanel, renderDisplayOutput } from "./ui/outputPanel";
import { createJavaScriptGraphDisplayRenderers } from "./visualization/javascriptGraphs";
import { addSyntaxLanguageClass, highlightCodeElement, normalizeSyntaxLanguage } from "./syntaxHighlight";
import { sha256Hash } from "../engine/utils/hash";
import { isRecord } from "../engine/utils/record";
import { formatErrorMessage } from "../engine/utils/errors";
import { LOTUS_MANAGED_DISPLAY_LANGUAGE, parseManagedDisplaySource } from "../engine/managedOutput";
import { canonicalizeNoteForHash, readHashPolicy, readReproducibilityFrontmatter, readStoredNoteHash, setFrontmatterYamlParser } from "../engine/reproducibility";
import { lotusApiServer, readApiLogEvents, type lotusApiHost } from "../engine/apiServer";
import type { lotusCodeBlock, lotusDisplayRenderer, lotusExternalLanguagePack, lotusPluginSettings } from "../engine/types";
import { createHtmlExportSummary, formatByteSize, lotusHtmlExportSummaryModal, renderLotusHtmlExport, type lotusHtmlExportSummary } from "./htmlExport";
import { LANGUAGE_PACK_MANIFEST_NAMES, findBundleManifest, isPathWithin, normalizeBundleEntries, normalizeManifestId, parseExternalLanguagePack, readBundleManifest, readLanguageBundleArchive, readString, toArrayBuffer } from "../engine/languagePackBundle";
import { normalizeSettings, readStoredSettings } from "../engine/settingsNormalize";
import { ExecutionConsentModal, ReproducibilityPolicyModal, SignatureMaterialModal } from "./ui/modals";
import { lotusSigningService, formatSignatureScheme, readStoredSignature, type lotusSignatureMaterial } from "../engine/signingService";
import { lotusReproducibilityService } from "../engine/reproducibilityService";
import { lotusRunCoordinator } from "../engine/runCoordinator";
import { lotusEventLog } from "../engine/eventLog";
import type { lotusServiceHost } from "../engine/serviceHost";
import { createObsidianLogHost, createObsidianVaultHost } from "./obsidianHost";
import { ensureVaultFolder, ensureVaultParentFolder } from "../engine/vaultHost";
import { sanitizeArtifactSegment } from "../engine/utils/vaultPath";
import { lotusOutputWidget, lotusRefreshEffect, lotusToolbarRenderChild, lotusToolbarWidget } from "./ui/editorWidgets";
import type { lotusRunBlockOptions } from "../engine/runCoordinator";

const EXTERNAL_LANGUAGE_PACK_DIR = "language-packs";

async function listLanguagePackManifestPaths(adapter: DataAdapter, root: string): Promise<string[]> {
  const manifests: string[] = [];

  async function walk(folder: string, depth: number): Promise<void> {
    const listed = await adapter.list(folder);
    for (const file of listed.files) {
      const lower = file.toLowerCase();
      if (!lower.endsWith(".json")) {
        continue;
      }

      const relative = normalizePath(file.slice(root.length + 1));
      const nested = relative.includes("/");
      const fileName = relative.split("/").pop()?.toLowerCase() ?? "";
      if (!nested || LANGUAGE_PACK_MANIFEST_NAMES.has(fileName)) {
        manifests.push(file);
      }
    }

    for (const child of listed.folders) {
      if (depth < 4) {
        await walk(child, depth + 1);
      }
    }
  }

  await walk(root, 0);
  return manifests;
}

function readAdapterBasePath(adapter: DataAdapter): string {
  const maybeAdapter = adapter as unknown as { basePath?: unknown };
  return typeof maybeAdapter.basePath === "string"
    ? maybeAdapter.basePath
    : "";
}

function getRenderedCodeElements(root: HTMLElement): HTMLElement[] {
  const elements: HTMLElement[] = [];
  if (root.matches("pre > code")) {
    elements.push(root);
  } else if (root.matches("pre")) {
    const code = root.querySelector(":scope > code");
    if (code instanceof HTMLElement) {
      elements.push(code);
    }
  }

  elements.push(...Array.from(root.querySelectorAll<HTMLElement>("pre > code")));
  return [...new Set(elements)];
}

function renderedCodeMatchesBlock(renderedSource: string, blockSource: string): boolean {
  const renderedVariants = codeTextVariants(renderedSource);
  const blockVariants = codeTextVariants(blockSource);
  return renderedVariants.some((rendered) => blockVariants.includes(rendered));
}

function codeTextVariants(value: string): string[] {
  const normalized = value.replace(/\r\n?/g, "\n");
  const withoutSingleTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return normalized === withoutSingleTrailingNewline
    ? [normalized]
    : [normalized, withoutSingleTrailingNewline];
}

export default class lotusPlugin extends Plugin {
  settings: lotusPluginSettings = DEFAULT_SETTINGS;
  readonly registry = new lotusRunnerRegistry([
    ...createBuiltInRunners(),
    new ObsidianContextRunner({ app: this.app, plugin: this }),
    new CustomLanguageRunner(),
  ]);
  // Exposed as public and readonly so the settings panel and modals can access container configurations and default language mapping helpers.
  public readonly containerRunner = new lotusContainerRunner(
    { containersPath: join(readAdapterBasePath(this.app.vault.adapter), this.manifest.dir ?? `${this.app.vault.configDir}/plugins/lotus`, "containers") },
    requestUrl,
  );
  private hasRegisteredMarkdownDecorator = false;
  private readonly displayRenderers = new Set<lotusDisplayRenderer>();
  private cachedSigningPassphrase: string | null = null;
  private readonly stdinPanels = new Set<string>();
  private readonly outputListeners = new Map<string, Set<() => void>>();
  private statusBarItemEl!: HTMLElement;
  private editorViews = new Set<EditorView>();
  private lastMarkdownFilePath: string | null = null;
  private lastHtmlExport: lotusHtmlExportSummary | null = null;
  private readonly vaultHost = createObsidianVaultHost(this.app);
  private readonly events = new lotusEventLog(new lotusLogger(createObsidianLogHost(this.app), () => this.settings), this.vaultHost);
  private readonly repro = new lotusReproducibilityService(this.createServiceHost(), this.events);
  private readonly signing = new lotusSigningService({
    ...this.createServiceHost(),
    requestSignatureMaterial: (title, mode, action) => this.requestSignatureMaterial(title, mode, action),
  }, this.events, this.repro);
  readonly runs = new lotusRunCoordinator({
    ...this.createServiceHost(),
    ensureExecutionEnabled: () => this.ensureExecutionEnabled(),
    onOutputChanged: (blockId) => this.notifyOutputChanged(blockId),
    onRunStateChanged: () => this.updateStatusBar(),
    currentNotePath: () => this.getCurrentEditorFilePath(),
    onRunStarted: (file) => {
      this.lastMarkdownFilePath = file.path;
    },
  }, this.registry, this.containerRunner, this.events, this.repro);
  private readonly apiServer = new lotusApiServer(this.createApiHost());

  async onload(): Promise<void> {
    setFrontmatterYamlParser(parseYaml);
    await this.loadSettings();
    this.addSettingTab(new lotusSettingTab(this));
    this.statusBarItemEl = this.addStatusBarItem();
    this.updateStatusBar();
    this.registerBuiltInDisplayRenderers();
    this.registerView(LOTUS_LOG_VIEW_TYPE, (leaf) => new lotusLogView(leaf, this));
    this.addRibbonIcon("list-filter", "Open Lotus logs", () => {
      void this.openLogView();
    });
    this.app.workspace.onLayoutReady(() => {
      this.lastMarkdownFilePath = this.getActiveMarkdownFile()?.path ?? this.lastMarkdownFilePath;
      void this.enforceSourceModeForActiveView();
    });

    this.addCommand({
      id: "run-current-code-block",
      name: "Run current code block",
      editorCallback: async (editor, view) => {
        const file = view.file;
        if (!file) {
          return;
        }

        const blocks = parseMarkdownCodeBlocks(file.path, editor.getValue(), this.settings);
        const block = findBlockAtLine(blocks, editor.getCursor().line);
        if (!block) {
          new Notice("No supported Lotus block at the current cursor.");
          return;
        }
        await this.runs.runBlock(file, block);
      },
    });

    if (isCompileFeatureAllowed("rich-displays")) {
      this.addCommand({
        id: "visualize-current-code-block",
        name: "Visualize current code block",
        editorCallback: async (editor, view) => {
          const file = view.file;
          if (!file) {
            return;
          }

          const blocks = parseMarkdownCodeBlocks(file.path, editor.getValue(), this.settings);
          const block = findBlockAtLine(blocks, editor.getCursor().line);
          if (!block) {
            new Notice("No supported Lotus block at the current cursor.");
            return;
          }
          await this.runs.visualizeBlock(file, block);
        },
      });
    }

    this.addCommand({
      id: "run-all-code-blocks",
      name: "Run all supported code blocks in current note",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.runs.runAllBlocksInFile(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "cancel-current-code-block",
      name: "Cancel current code block run",
      editorCheckCallback: (checking, editor, view) => {
        const file = view.file;
        if (!file) {
          return false;
        }
        const blocks = parseMarkdownCodeBlocks(file.path, editor.getValue(), this.settings);
        const block = findBlockAtLine(blocks, editor.getCursor().line);
        if (!block || !this.runs.running.has(block.id)) {
          return false;
        }
        if (!checking) {
          void this.runs.cancelBlockRun(block.id, "current block", block, file.path);
        }
        return true;
      },
    });

    this.addCommand({
      id: "cancel-all-code-blocks",
      name: "Cancel all running code blocks",
      checkCallback: (checking) => {
        if (!this.runs.running.size) {
          return false;
        }
        if (!checking) {
          void this.runs.cancelAllRuns();
        }
        return true;
      },
    });

    this.addCommand({
      id: "open-log-viewer",
      name: "Open log viewer",
      callback: () => {
        void this.openLogView();
      },
    });

    this.addCommand({
      id: "clear-note-outputs",
      name: "Clear outputs in current note",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.runs.clearOutputsForFile(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "export-current-note-html",
      name: "Export current note as HTML",
      editorCheckCallback: (checking, editor, view) => {
        const file = view.file;
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.exportCurrentNoteHtml(file, editor.getValue());
        }
        return true;
      },
    });

    this.addCommand({
      id: "open-last-html-export",
      name: "Open last HTML export",
      checkCallback: (checking) => {
        if (!this.lastHtmlExport) {
          return false;
        }
        if (!checking) {
          this.openHtmlExport(this.lastHtmlExport);
        }
        return true;
      },
    });

    this.addCommand({
      id: "copy-last-html-export-path",
      name: "Copy last HTML export path",
      checkCallback: (checking) => {
        if (!this.lastHtmlExport) {
          return false;
        }
        if (!checking) {
          void this.copyHtmlExportPath(this.lastHtmlExport);
        }
        return true;
      },
    });

    this.addCommand({
      id: "save-reproducibility-snapshot",
      name: "Save reproducibility snapshot",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.repro.saveReproducibilitySnapshot(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "verify-reproducibility-snapshot",
      name: "Verify reproducibility snapshot",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.repro.verifyReproducibilitySnapshot(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "set-reproducibility-policy",
      name: "Set reproducibility policy",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.openReproducibilityPolicyModal(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "copy-reproducibility-snapshot",
      name: "Copy reproducibility snapshot",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.copyReproducibilitySnapshot(file);
        }
        return true;
      },
    });

    if (isCompileFeatureAllowed("signing")) {
      this.addCommand({
        id: "sign-current-note",
        name: "Sign current note",
        checkCallback: (checking) => {
          const file = this.getActiveMarkdownFile();
          if (!file) {
            return false;
          }
          if (!checking) {
            void this.signCurrentNote(file);
          }
          return true;
        },
      });

      this.addCommand({
        id: "verify-current-note-signature",
        name: "Verify current note signature",
        checkCallback: (checking) => {
          const file = this.getActiveMarkdownFile();
          if (!file) {
            return false;
          }
          if (!checking) {
            void this.verifyCurrentNoteSignature(file);
          }
          return true;
        },
      });

      this.addCommand({
        id: "copy-current-note-signature",
        name: "Copy current note signature",
        checkCallback: (checking) => {
          const file = this.getActiveMarkdownFile();
          if (!file) {
            return false;
          }
          if (!checking) {
            void this.copyCurrentNoteSignature(file);
          }
          return true;
        },
      });

      this.addCommand({
        id: "sign-all-notes",
        name: "Sign all notes",
        callback: () => {
          void this.signing.signAllNotes();
        },
      });

      this.addCommand({
        id: "verify-all-note-signatures",
        name: "Verify all note signatures",
        callback: () => {
          void this.signing.verifyAllNoteSignatures();
        },
      });

    }

    this.addCommand({
      id: "copy-note-hash",
      name: "Copy note hash",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.copyNoteHash(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "copy-verification-report",
      name: "Copy reproducibility verification report",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.copyReproducibilityVerificationReport(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "hash-current-note",
      name: "Hash current note",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.repro.hashCurrentNote(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "verify-current-note-hash",
      name: "Verify current note hash",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.repro.verifyCurrentNoteHash(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "hash-current-code-block",
      name: "Hash current code block",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view?.file) {
          return false;
        }
        if (!checking) {
          void this.hashCurrentCodeBlock();
        }
        return true;
      },
    });

    this.addCommand({
      id: "verify-code-block-hashes",
      name: "Verify code block hashes in current note",
      checkCallback: (checking) => {
        const file = this.getActiveMarkdownFile();
        if (!file) {
          return false;
        }
        if (!checking) {
          void this.repro.verifyCodeBlockHashes(file);
        }
        return true;
      },
    });

    this.registerCodeBlockProcessors();

    this.registerEditorExtension(this.createLivePreviewExtension());

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        this.lastMarkdownFilePath = file?.path ?? this.lastMarkdownFilePath;
        this.refreshAllViews();
        void this.enforceSourceModeForActiveView();
        if (file && this.settings.autoRunOnFileOpen) {
          void this.runs.runAllBlocksInFile(file);
        }
      }),
    );

    if (isCompileFeatureAllowed("container-groups")) {
      this.addCommand({
        id: "validate-container-groups",
        name: "Validate container groups",
        callback: async () => {
          const groups = await this.getContainerGroupSummaries();
          new Notice(groups.length ? groups.map((group) => `${group.name}: ${group.status}`).join("\n") : "No lotus container groups found.", 8000);
        },
      });
    }

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => {
        this.lastMarkdownFilePath = this.getActiveMarkdownFile()?.path ?? this.lastMarkdownFilePath;
        void this.enforceSourceModeForActiveView();
      }),
    );

    this.registerEvent(
      this.app.workspace.on("editor-change", (_editor, ctx) => {
        if (ctx instanceof MarkdownView) {
          void this.enforceSourceModeForLeaf(ctx.leaf);
        }
      }),
    );
    void this.apiServer.configure();
  }

  onunload(): void {
    for (const controller of this.runs.running.values()) {
      controller.abort();
    }
    void this.apiServer.stop();
    this.events.logger.close();
  }

  async loadSettings(): Promise<void> {
    const loadedData = readStoredSettings(await this.loadData());
    const hadMachineId = typeof loadedData?.loggingMachineId === "string" && loadedData.loggingMachineId.trim().length > 0;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...loadedData,
    };
    await this.loadExternalLanguagePacks();
    normalizeSettings(this.settings);
    if (!hadMachineId) {
      const persistedSettings: Partial<lotusPluginSettings> = { ...this.settings };
      delete persistedSettings.externalLanguagePacks;
      await this.saveData(persistedSettings);
    }
  }

  async loadExternalLanguagePacks(showNotice = false): Promise<void> {
    const packDir = normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/lotus`}/${EXTERNAL_LANGUAGE_PACK_DIR}`);
    const adapter = this.app.vault.adapter;
    const packs: lotusExternalLanguagePack[] = [];
    let failures = 0;

    try {
      if (!(await adapter.exists(packDir))) {
        this.settings.externalLanguagePacks = [];
        if (showNotice) {
          await adapter.mkdir(packDir);
          new Notice(`Created external language pack folder at ${packDir}`);
        }
        return;
      }

      const files = (await listLanguagePackManifestPaths(adapter, packDir))
        .sort((a, b) => a.localeCompare(b));

      for (const filePath of files) {
        try {
          const parsed = parseExternalLanguagePack(JSON.parse(await adapter.read(filePath)), filePath, readAdapterBasePath(adapter));
          if (parsed) {
            packs.push(parsed);
          } else {
            failures += 1;
          }
        } catch (error) {
          failures += 1;
          console.warn(`Failed to load lotus language pack ${filePath}`, error);
        }
      }
    } catch (error) {
      this.settings.externalLanguagePacks = [];
      console.warn(`Failed to scan lotus language packs in ${packDir}`, error);
      if (showNotice) {
        new Notice(`Failed to load external language packs from ${packDir}`);
      }
      return;
    }

    this.settings.externalLanguagePacks = packs;
    if (showNotice) {
      const suffix = failures ? `, ${failures} failed` : "";
      new Notice(`Loaded ${packs.length} external language pack${packs.length === 1 ? "" : "s"}${suffix}`);
    }
  }

  async importExternalLanguageBundle(file: File): Promise<{ packId: string; fileCount: number }> {
    const entries = normalizeBundleEntries(await readLanguageBundleArchive(file), file.name);
    if (!entries.length) {
      throw new Error("Language bundle archive did not contain any importable files.");
    }

    const manifestEntry = findBundleManifest(entries);
    if (!manifestEntry) {
      throw new Error("Language bundle archive must include lotus-language-pack.json, language-pack.json, manifest.json, or a valid root JSON pack manifest.");
    }

    const manifest = readBundleManifest(manifestEntry);
    if (!manifest || !Array.isArray(manifest.languages)) {
      throw new Error("Language bundle manifest must be valid JSON with a languages array.");
    }

    const packId = normalizeManifestId(readString(manifest.id)) || normalizeManifestId(file.name.replace(/\.(tar\.gz|tgz|zip|tar)$/i, ""));
    if (!packId) {
      throw new Error("Language bundle manifest is missing a package id.");
    }

    const adapter = this.app.vault.adapter;
    const packDir = normalizePath(`${this.manifest.dir ?? `${this.app.vault.configDir}/plugins/lotus`}/${EXTERNAL_LANGUAGE_PACK_DIR}`);
    const bundleDir = normalizePath(`${packDir}/${packId}`);
    await ensureVaultFolder(this.vaultHost, bundleDir);

    for (const entry of entries) {
      const targetPath = normalizePath(`${bundleDir}/${entry.path}`);
      if (!isPathWithin(targetPath, bundleDir)) {
        throw new Error(`Invalid bundle path: ${entry.path}`);
      }
      await ensureVaultParentFolder(this.vaultHost, targetPath);
      await adapter.writeBinary(targetPath, toArrayBuffer(entry.data));
    }

    await this.loadExternalLanguagePacks();
    return { packId, fileCount: entries.length };
  }

  async saveSettings(): Promise<void> {
    normalizeSettings(this.settings);
    const persistedSettings: Partial<lotusPluginSettings> = { ...this.settings };
    delete persistedSettings.externalLanguagePacks;
    await this.saveData(persistedSettings);
    await this.events.logEvent({
      type: "lotus.settings.changed",
      message: "Lotus settings saved",
      data: {
        loggingEnabled: this.settings.loggingEnabled,
        enableLocalExecution: this.settings.enableLocalExecution,
      },
    });
    this.registerCodeBlockProcessors();
    this.notifyAllOutputsChanged();
    await this.apiServer.configure();
  }

  notify(message: string, timeoutMs?: number): void {
    new Notice(message, timeoutMs);
  }

  isBlockRunning(blockId: string): boolean {
    return this.runs.isBlockRunning(blockId);
  }

  private createServiceHost(): lotusServiceHost {
    return {
      vault: this.vaultHost,
      getSettings: () => this.settings,
      notify: (message, timeoutMs) => this.notify(message, timeoutMs),
    };
  }

  private createApiHost(): lotusApiHost {
    const runs = this.runs;
    const host: lotusApiHost = {
      settings: this.settings,
      manifest: this.manifest,
      app: this.app,
      notify: (message) => this.notify(message),
      listApiNotes: (query) => runs.listApiNotes(query),
      listApiBlocks: (notePath) => runs.listApiBlocks(notePath),
      getApiBlock: (blockId) => runs.getApiBlock(blockId),
      updateApiBlockContent: (blockId, content) => runs.updateApiBlockContent(blockId, content),
      listApiRunners: () => runs.listApiRunners(),
      runApiBlock: (blockId, options) => runs.runApiBlock(blockId, options),
      cancelApiRun: (runId) => runs.cancelApiRun(runId),
      listApiRuns: () => runs.listApiRuns(),
      getApiRun: (runId) => runs.getApiRun(runId),
      listApiLogs: (limit) => readApiLogEvents(host, limit),
    };
    Object.defineProperty(host, "settings", { get: () => this.settings });
    return host;
  }

  registerOutputListener(blockId: string, listener: () => void): () => void {
    if (!this.outputListeners.has(blockId)) {
      this.outputListeners.set(blockId, new Set());
    }
    this.outputListeners.get(blockId)?.add(listener);
    return () => {
      this.outputListeners.get(blockId)?.delete(listener);
    };
  }

  registerDisplayRenderer(renderer: lotusDisplayRenderer): () => void {
    if (!isCompileFeatureAllowed("rich-displays")) {
      return () => undefined;
    }
    this.validateDisplayRenderer(renderer);
    this.displayRenderers.add(renderer);
    this.notifyAllOutputsChanged();
    return () => {
      this.displayRenderers.delete(renderer);
      this.notifyAllOutputsChanged();
    };
  }

  private registerBuiltInDisplayRenderers(): void {
    if (!isCompileFeatureAllowed("rich-displays")) {
      return;
    }
    for (const renderer of createJavaScriptGraphDisplayRenderers()) {
      this.validateDisplayRenderer(renderer);
      this.displayRenderers.add(renderer);
    }
  }

  async openLogView(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(LOTUS_LOG_VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getRightLeaf(false);
    if (!leaf) {
      new Notice("Unable to open Lotus log viewer.");
      return;
    }

    await leaf.setViewState({ type: LOTUS_LOG_VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof lotusLogView) {
      await view.refresh();
    }
  }

  createToolbarElement(block: lotusCodeBlock): HTMLElement {
    const isFunctionInput = this.runs.isFunctionInputBlock(block);
    return createCodeBlockToolbar(block.id, this.runs.isBlockRunning(block.id), {
      onRun: () => void this.runOrCancelBlockById(block.id),
      onTranspile: () => void this.runOrCancelBlockById(block.id, { intent: "transpile" }),
      onVisualize: () => void this.visualizeActiveBlockById(block.id),
      onEdit: () => void this.editBlock(block),
      onCopy: () => {
        void navigator.clipboard.writeText(block.content).then(() => {
          new Notice("Code copied");
        }).catch(() => {
          new Notice("Clipboard write failed.");
        });
      },
      onRemove: () => void this.removeSnippetById(block.id),
      onToggleInput: () => {
        if (this.stdinPanels.has(block.id)) {
          this.stdinPanels.delete(block.id);
        } else {
          this.stdinPanels.add(block.id);
        }
        this.notifyOutputChanged(block.id);
      },
      onToggleOutput: () => {
        const output = this.runs.outputs.get(block.id);
        if (!output) {
          return;
        }
        output.visible = !output.visible;
        this.notifyOutputChanged(block.id);
      },
    }, {
      inputButtonLabel: isFunctionInput ? "Toggle function input" : "Toggle stdin input",
      showTranspile: this.shouldShowTranspileButton(block),
      showVisualize: this.shouldShowCodeVisualizationButton(),
    });
  }

  shouldShowTranspileButton(block: lotusCodeBlock): boolean {
    return this.runs.shouldShowTranspileButton(block);
  }

  shouldShowCodeVisualizationButton(): boolean {
    return isCompileFeatureAllowed("rich-displays") && (this.settings.showCodeVisualizationButton ?? true);
  }

  async editBlockById(blockId: string): Promise<void> {
    const block = this.findActiveBlockById(blockId);
    if (!block) {
      new Notice("Could not find this Lotus block.");
      return;
    }

    await this.editBlock(block);
  }

  private async editBlock(block: lotusCodeBlock): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(block.filePath);
    if (!(file instanceof TFile)) {
      new Notice("Could not open the note for this Lotus block.");
      return;
    }

    let leaf = this.app.workspace.getLeavesOfType("markdown")
      .find((candidate) => {
        const view = candidate.view;
        return view instanceof MarkdownView && view.file?.path === file.path;
      }) ?? this.app.workspace.getLeaf(false);

    await leaf.openFile(file);
    await this.setSourceModeForLeaf(leaf, true);
    leaf = this.app.workspace.getActiveViewOfType(MarkdownView)?.leaf ?? leaf;

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.editor) {
      new Notice("Open the note in editing mode to edit this Lotus block.");
      return;
    }

    view.editor.focus();
    view.editor.setCursor({ line: block.startLine, ch: 0 });
    view.editor.scrollIntoView({
      from: { line: block.startLine, ch: 0 },
      to: { line: block.endLine, ch: 0 },
    }, true);
  }

  renderOutputInto(block: lotusCodeBlock, container: HTMLElement): void {
    container.empty();
    const blockId = block.id;

    if (this.hasDynamicInputs(block)) {
      container.appendChild(this.createDynamicInputPanel(block));
    }

    if (this.shouldRenderStdinPanel(block)) {
      container.appendChild(this.createStdinPanel(block));
    }

    const output = this.runs.outputs.get(blockId);
    if (this.runs.running.has(blockId)) {
      const liveRun = this.runs.liveRuns.get(blockId);
      container.appendChild(createRunningPanel({
        runnerName: liveRun?.runnerName,
        stdout: liveRun?.stdout,
        stderr: liveRun?.stderr,
        inputEnabled: Boolean(liveRun?.inputSession),
        onSendInput: (input) => void this.runs.sendLiveInput(blockId, input),
        onCloseInput: () => void this.runs.closeLiveInput(blockId),
      }));
      return;
    }

    if (!output || !output.visible) {
      return;
    }

    container.appendChild(createOutputPanel(output, {
      defaultVisibleLines: this.settings.outputVisibleLines ?? 0,
      displayRenderers: [...this.displayRenderers],
    }));
  }

  async runActiveBlockById(blockId: string, options: lotusRunBlockOptions = {}): Promise<void> {
    const block = this.findActiveBlockById(blockId);
    const file = this.getActiveMarkdownFile();
    if (!block || !file) {
      return;
    }
    await this.runs.runBlock(file, block, options);
  }

  async runOrCancelBlockById(blockId: string, options: lotusRunBlockOptions = {}): Promise<void> {
    if (this.runs.running.has(blockId)) {
      const block = this.findActiveBlockById(blockId);
      await this.runs.cancelBlockRun(blockId, "toolbar", block ?? undefined, block?.filePath);
      return;
    }
    await this.runActiveBlockById(blockId, options);
  }

  async visualizeActiveBlockById(blockId: string): Promise<void> {
    const block = this.findActiveBlockById(blockId);
    const file = this.getActiveMarkdownFile();
    if (!block || !file) {
      return;
    }
    await this.runs.visualizeBlock(file, block);
  }

  async removeSnippetById(blockId: string): Promise<void> {
    const block = this.findActiveBlockById(blockId);
    if (!block) {
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(block.filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    this.runs.running.get(blockId)?.abort();
    this.runs.running.delete(blockId);
    this.runs.outputs.delete(blockId);
    this.runs.dynamicInputValues.delete(blockId);

    await this.app.vault.process(file, (content) => {
      const lines = content.split(/\r?\n/);
      const blocks = parseMarkdownCodeBlocks(file.path, content, this.settings);
      const currentBlock = blocks.find((candidate) => candidate.id === blockId);
      if (!currentBlock) {
        return content;
      }

      const managedRange = this.runs.findManagedOutputRange(lines, blockId);
      const removalStart = currentBlock.startLine;
      const removalEnd = managedRange ? managedRange.end : currentBlock.endLine;
      lines.splice(removalStart, removalEnd - removalStart + 1);

      while (removalStart < lines.length - 1 && lines[removalStart] === "" && lines[removalStart + 1] === "") {
        lines.splice(removalStart, 1);
      }

      return lines.join("\n");
    });
    await this.events.logEvent({
      type: "lotus.note.modified",
      message: "Removed Lotus snippet",
      notePath: file.path,
      block,
      data: {
        action: "snippet.removed",
      },
    });

    this.notifyOutputChanged(blockId);
    this.updateStatusBar();
    new Notice("Lotus snippet removed.");
  }

  async signCurrentNote(file: TFile): Promise<void> {
    const material = await this.requestSignatureMaterial("Sign Current Note", this.settings.signingMode || "passphrase", "sign");
    if (!material) {
      return;
    }

    try {
      const signature = await this.signing.signNote(file, material);
      new Notice(`lotus note signed with ${formatSignatureScheme(signature.scheme)} (${signature.keyId}).`);
    } catch (error) {
      new Notice(`lotus signing failed: ${formatErrorMessage(error)}`, 12000);
    }
  }

  async verifyCurrentNoteSignature(file: TFile): Promise<void> {
    try {
      const source = await this.app.vault.cachedRead(file);
      const signature = readStoredSignature(source);
      if (!signature) {
        new Notice("No Lotus-signature found. Run Lotus: Sign current note first.");
        return;
      }

      const material = signature.scheme === "passphrase-hmac-sha256"
        ? await this.requestSignatureMaterial("Verify Current Note Signature", "passphrase", "verify")
        : null;
      if (signature.scheme === "passphrase-hmac-sha256" && !material) {
        return;
      }

      const result = await this.signing.verifyNoteSignature(file, source, signature, material ?? undefined);
      new Notice(result.summary, result.verified ? 6000 : 12000);
    } catch (error) {
      new Notice(`lotus signature verification failed: ${formatErrorMessage(error)}`, 12000);
    }
  }

  async copyCurrentNoteSignature(file: TFile): Promise<void> {
    const signature = readStoredSignature(await this.app.vault.cachedRead(file));
    if (!signature) {
      new Notice("No valid Lotus-signature found. Run Lotus: Sign current note first.");
      return;
    }
    await this.copyTextToClipboard(JSON.stringify(signature, null, 2), "Note signature copied.");
  }

  private async requestSignatureMaterial(title: string, mode: "passphrase" | "rsa" | "ssh", action: "sign" | "verify"): Promise<lotusSignatureMaterial | null> {
    if (mode === "ssh" || (mode === "rsa" && action === "verify")) {
      return { mode };
    }

    return await new Promise<lotusSignatureMaterial | null>((resolve) => {
      new SignatureMaterialModal(this.app, {
        title,
        mode,
        action,
        hasPrivateKeyPath: false,
        cachedPassphrase: mode === "passphrase" ? this.cachedSigningPassphrase ?? undefined : undefined,
        onSubmit: (material) => {
          if (material.mode === "passphrase" && material.rememberForSession && material.passphrase) {
            this.cachedSigningPassphrase = material.passphrase;
          }
          resolve(material);
        },
        onCancel: () => resolve(null),
      }).open();
    });
  }

  async openReproducibilityPolicyModal(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    new ReproducibilityPolicyModal(this.app, readHashPolicy(source), async (preset) => {
      await this.repro.applyReproducibilityPolicyPreset(file, preset);
    }).open();
  }

  async copyReproducibilitySnapshot(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const existing = readReproducibilityFrontmatter(source);
    const snapshot = existing ?? this.repro.createReproducibilitySnapshot(file.path, source);
    await this.copyTextToClipboard(JSON.stringify(snapshot, null, 2), "Reproducibility snapshot copied.");
  }

  async copyNoteHash(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const hash = readStoredNoteHash(source) ?? sha256Hash(canonicalizeNoteForHash(source));
    await this.copyTextToClipboard(hash, "Note hash copied.");
  }

  async copyReproducibilityVerificationReport(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const existing = readReproducibilityFrontmatter(source);
    const report = isRecord(existing?.verification)
      ? existing.verification
      : this.repro.createReproducibilityVerification(file.path, source);
    await this.copyTextToClipboard(JSON.stringify(report, null, 2), "Reproducibility verification report copied.");
  }

  private async copyTextToClipboard(text: string, successMessage: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      new Notice(successMessage);
    } catch {
      new Notice("Clipboard write failed.");
    }
  }

  async hashCurrentCodeBlock(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    const editor = view?.editor;
    if (!file || !editor) {
      new Notice("Open a markdown note in editing mode to hash the current code block.");
      return;
    }

    const source = editor.getValue();
    const blocks = parseMarkdownCodeBlocks(file.path, source, this.settings);
    const block = findBlockAtLine(blocks, editor.getCursor().line);
    if (!block) {
      new Notice("No supported Lotus block at the current cursor.");
      return;
    }

    const entries = await this.repro.writeCodeBlockHashesToFrontmatter(file, source);
    const currentEntry = entries.find((entry) => entry.ordinal === block.ordinal);
    await this.events.logEvent({
      type: "lotus.note.modified",
      message: "Wrote code block hashes",
      notePath: file.path,
      block,
      data: {
        action: "hash.code-blocks",
        blocks: entries.length,
        currentHash: currentEntry?.hash ?? this.repro.createCodeBlockHashEntry(block, readHashPolicy(source)).hash,
      },
    });
    new Notice(`lotus block hash: ${currentEntry?.hash ?? this.repro.createCodeBlockHashEntry(block, readHashPolicy(source)).hash}`);
  }

  private async ensureExecutionEnabled(): Promise<boolean> {
    if (this.settings.enableLocalExecution && this.settings.hasAcknowledgedExecutionRisk) {
      return true;
    }

    return await new Promise<boolean>((resolve) => {
      let settled = false;
      const settle = (value: boolean) => {
        if (!settled) {
          settled = true;
          resolve(value);
        }
      };

      const modal = new ExecutionConsentModal(this.app, async () => {
        this.settings.enableLocalExecution = true;
        this.settings.hasAcknowledgedExecutionRisk = true;
        await this.saveSettings();
        settle(true);
      });

      const originalClose = modal.close.bind(modal);
      modal.close = () => {
        originalClose();
        settle(this.settings.enableLocalExecution && this.settings.hasAcknowledgedExecutionRisk);
      };
      modal.open();
    });
  }

  async getContainerGroupSummaries(): Promise<lotusContainerGroupSummary[]> {
    if (!isCompileFeatureAllowed("container-groups")) {
      return [];
    }
    return (await this.containerRunner.getGroupSummaries())
      .filter((group) => isCompileContainerGroupAllowed(group.name));
  }

  async buildContainerGroup(name: string): Promise<void> {
    if (!isCompileFeatureAllowed("container-groups")) {
      new Notice("Lotus container groups are not included in this build.");
      return;
    }
    if (!isCompileContainerGroupAllowed(name)) {
      new Notice(`lotus container group ${name} is not included in this build.`);
      return;
    }
    const controller = new AbortController();
    const result = await this.containerRunner.buildGroup(name, Math.max(this.settings.defaultTimeoutMs, 120_000), controller.signal);
    new Notice(result.success ? `lotus built container group ${name}.` : `lotus container build failed for ${name}.`, 8000);
  }

  registerCodeBlockProcessors(): void {
    if (this.hasRegisteredMarkdownDecorator) {
      return;
    }

    this.hasRegisteredMarkdownDecorator = true;
    if (isCompileFeatureAllowed("rich-displays")) {
      this.registerMarkdownCodeBlockProcessor(LOTUS_MANAGED_DISPLAY_LANGUAGE, (source, el) => {
        el.addClass("lotus-managed-display");
        try {
          for (const display of parseManagedDisplaySource(source)) {
            renderDisplayOutput(el, display, {
              defaultVisibleLines: this.settings.outputVisibleLines,
              displayRenderers: [...this.displayRenderers],
            });
          }
        } catch (error) {
          el.createEl("pre", {
            cls: "lotus-output-pre",
            text: `Invalid managed Lotus display: ${formatErrorMessage(error)}`,
          });
        }
      });
    }
    this.registerMarkdownPostProcessor(async (el, ctx) => {
      await this.decorateRenderedCodeBlocks(el, ctx);
    });
  }

  private async decorateRenderedCodeBlocks(el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const filePath = ctx.sourcePath;
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    const codeElements = getRenderedCodeElements(el);
    if (!codeElements.length) {
      return;
    }

    const fullText = await this.app.vault.cachedRead(file);
    const blocks = parseMarkdownCodeBlocks(filePath, fullText, this.settings);
    if (!blocks.length) {
      return;
    }

    const usedBlockIds = new Set<string>();
    for (const code of codeElements) {
      const pre = code.parentElement;
      if (!(pre instanceof HTMLElement) || pre.dataset.lotusDecorated === "true") {
        continue;
      }

      const block = this.findRenderedCodeBlock(blocks, code, pre, ctx, usedBlockIds);
      if (!block) {
        continue;
      }

      usedBlockIds.add(block.id);
      const inheritedHighlightLanguage = this.getCustomHighlightLanguage(block);
      if (inheritedHighlightLanguage) {
        this.applyRenderedCodeHighlightInheritance(code, block.content, inheritedHighlightLanguage);
      } else if (block.language === "llvm-ir") {
        highlightLlvmElement(code, block.content);
      }
      pre.dataset.lotusDecorated = "true";
      ctx.addChild(new lotusToolbarRenderChild(pre, this, block, pre));
    }
  }

  private findRenderedCodeBlock(
    blocks: lotusCodeBlock[],
    code: HTMLElement,
    pre: HTMLElement,
    ctx: MarkdownPostProcessorContext,
    usedBlockIds: Set<string>,
  ): lotusCodeBlock | null {
    const renderedLanguage = this.getRenderedCodeLanguage(code, pre);
    const renderedSource = code.textContent ?? "";
    const candidates = blocks.filter((block) =>
      !usedBlockIds.has(block.id) &&
      this.renderedLanguageMatchesBlock(renderedLanguage, block) &&
      renderedCodeMatchesBlock(renderedSource, block.content),
    );
    if (!candidates.length) {
      return null;
    }

    const section = ctx.getSectionInfo(pre) ?? ctx.getSectionInfo(code);
    if (section) {
      return candidates.find((block) => block.startLine === section.lineStart)
        ?? candidates.find((block) => block.startLine >= section.lineStart && block.endLine <= section.lineEnd)
        ?? candidates[0];
    }

    return candidates[0];
  }

  private getRenderedCodeLanguage(code: HTMLElement, pre: HTMLElement): string | null {
    for (const element of [code, pre]) {
      for (const className of Array.from(element.classList)) {
        const match = className.match(/^language-(.+)$/i);
        if (match) {
          return match[1].trim().toLowerCase();
        }
      }
    }

    return null;
  }

  private renderedLanguageMatchesBlock(renderedLanguage: string | null, block: lotusCodeBlock): boolean {
    if (!renderedLanguage) {
      return true;
    }

    const normalizedRenderedLanguage = normalizeLanguage(renderedLanguage, this.settings);
    return renderedLanguage === block.sourceLanguage.toLowerCase()
      || renderedLanguage === block.languageAlias
      || renderedLanguage === block.language
      || normalizedRenderedLanguage === block.language;
  }

  private getCustomHighlightLanguage(block: lotusCodeBlock): string | null {
    return resolveBlockHighlightLanguage(this.settings, block);
  }

  private applyRenderedCodeHighlightInheritance(code: HTMLElement, source: string, language: string): void {
    const normalized = normalizeSyntaxLanguage(language);
    if (!normalized) {
      return;
    }
    addSyntaxLanguageClass(code, normalized);
    if (code.parentElement instanceof HTMLElement) {
      addSyntaxLanguageClass(code.parentElement, normalized);
    }
    highlightCodeElement(code, source, normalized);
  }

  private updateStatusBar(): void {
    const activeRuns = this.runs.running.size;
    this.statusBarItemEl.setText(activeRuns ? `lotus: ${activeRuns} Active Run${activeRuns === 1 ? "" : "s"}` : "lotus: Idle");
  }

  private notifyOutputChanged(blockId: string): void {
    this.outputListeners.get(blockId)?.forEach((listener) => listener());
    this.refreshAllViews();
  }

  private notifyAllOutputsChanged(): void {
    for (const listeners of this.outputListeners.values()) {
      for (const listener of listeners) {
        listener();
      }
    }
    this.refreshAllViews();
  }

  private validateDisplayRenderer(renderer: lotusDisplayRenderer): void {
    if (!renderer || typeof renderer.render !== "function") {
      throw new Error("Lotus display renderer must provide a render function.");
    }
    if (
      !Array.isArray(renderer.mimeTypes)
      || !renderer.mimeTypes.some((mime) => typeof mime === "string" && mime.trim())
    ) {
      throw new Error("Lotus display renderer must provide at least one MIME type.");
    }
  }

  private refreshAllViews(): void {
    this.app.workspace.getLeavesOfType("markdown").forEach((leaf) => {
      const view = leaf.view as MarkdownView;
      const previewMode = (view as { previewMode?: { rerender?: (force?: boolean) => void } }).previewMode;
      previewMode?.rerender?.(true);
    });

    for (const editorView of this.editorViews) {
      editorView.dispatch({ effects: lotusRefreshEffect.of(undefined) });
    }
  }

  private getActiveMarkdownFile(): TFile | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    return view?.file ?? null;
  }

  private getCurrentEditorFilePath(): string | null {
    return this.getActiveMarkdownFile()?.path ?? this.lastMarkdownFilePath;
  }

  async enforceSourceModeForActiveView(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }

    await this.enforceSourceModeForLeaf(view.leaf);
  }

  async disableSourceModeForActiveView(): Promise<void> {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view) {
      return;
    }

    const leaf = view.leaf;
    const viewState = leaf.getViewState();
    const state = { ...(viewState.state ?? {}) } as Record<string, unknown>;
    
    if (state.mode === "source" && state.source === true) {
      state.source = false;
      await leaf.setViewState({
        ...viewState,
        state,
      });
    }
  }

  private async enforceSourceModeForLeaf(leaf: WorkspaceLeaf): Promise<void> {
    if (!this.settings.preserveSourceMode) {
      return;
    }

    await this.setSourceModeForLeaf(leaf, false);
  }

  private async setSourceModeForLeaf(leaf: WorkspaceLeaf, force: boolean): Promise<void> {
    if (leaf.isDeferred) {
      await leaf.loadIfDeferred();
    }

    const view = leaf.view;
    if (!(view instanceof MarkdownView) || !view.file) {
      return;
    }

    const source = view.editor?.getValue?.() ?? (await this.app.vault.cachedRead(view.file));
    const blocks = parseMarkdownCodeBlocks(view.file.path, source, this.settings);
    if (!force && !blocks.length) {
      return;
    }

    const viewState = leaf.getViewState();
    const state = { ...(viewState.state ?? {}) } as Record<string, unknown>;
    if (state.mode === "source" && state.source === true) {
      return;
    }

    state.mode = "source";
    state.source = true;

    await leaf.setViewState({
      ...viewState,
      state,
    });
  }

  private findActiveBlockById(blockId: string): lotusCodeBlock | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    const file = view?.file;
    const editor = view?.editor;
    if (!file || !editor) {
      return this.runs.outputs.get(blockId)?.block ?? null;
    }

    const blocks = parseMarkdownCodeBlocks(file.path, editor.getValue(), this.settings);
    return blocks.find((block) => block.id === blockId) ?? this.runs.outputs.get(blockId)?.block ?? null;
  }

  private createLivePreviewExtension() {
    const addEditorView = (view: EditorView) => this.editorViews.add(view);
    const deleteEditorView = (view: EditorView) => this.editorViews.delete(view);
    const getCurrentEditorFilePath = () => this.getCurrentEditorFilePath();
    const getSettings = () => this.settings;
    const hasOutput = (blockId: string) => this.runs.outputs.has(blockId);
    const isRunning = (blockId: string) => this.runs.running.has(blockId);
    const shouldRenderStdinPanel = (block: lotusCodeBlock) => this.shouldRenderStdinPanel(block);
    const hasDynamicInputs = (block: lotusCodeBlock) => this.hasDynamicInputs(block);
    const createToolbarWidget = (block: lotusCodeBlock) => new lotusToolbarWidget(this, block);
    const createOutputWidget = (block: lotusCodeBlock) => new lotusOutputWidget(this, block);

    return ViewPlugin.fromClass(
      class {
        decorations;

        constructor(private readonly view: EditorView) {
          addEditorView(view);
          this.decorations = this.buildDecorations();
        }

        update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(lotusRefreshEffect)))) {
            this.decorations = this.buildDecorations();
          }
        }

        destroy(): void {
          deleteEditorView(this.view);
        }

        private buildDecorations() {
          const filePath = getCurrentEditorFilePath();
          if (!filePath) {
            return Decoration.none;
          }

          const source = this.view.state.doc.toString();
          const blocks = parseMarkdownCodeBlocks(filePath, source, getSettings());
          const builder = new RangeSetBuilder<Decoration>();

          for (const block of blocks) {
            const startLine = this.view.state.doc.line(block.startLine + 1);
            builder.add(
              startLine.from,
              startLine.from,
              Decoration.widget({
                widget: createToolbarWidget(block),
                side: -1,
              }),
            );

            if (hasOutput(block.id) || isRunning(block.id) || shouldRenderStdinPanel(block) || hasDynamicInputs(block)) {
              const endLine = this.view.state.doc.line(block.endLine + 1);
              builder.add(
                endLine.to,
                endLine.to,
                Decoration.widget({
                  widget: createOutputWidget(block),
                  side: 1,
                }),
              );
            }

            if (block.language === "llvm-ir") {
              addLlvmDecorations(builder, this.view, block);
            }
          }

          return builder.finish();
        }
      },
      {
        decorations: (value) => value.decorations,
      },
    );
  }

  private async exportCurrentNoteHtml(file: TFile, source: string): Promise<void> {
    try {
      const targetPath = normalizePath(`.lotus/exports/${sanitizeArtifactSegment(file.path)}.html`);
      const blocks = parseMarkdownCodeBlocks(file.path, source, this.settings);
      const html = renderLotusHtmlExport(this.runs.outputs, this.settings.htmlExportGraphAssetMode, file, source, blocks);
      await ensureVaultParentFolder(this.vaultHost, targetPath);
      await this.app.vault.adapter.write(targetPath, html);
      const summary = createHtmlExportSummary(this.runs.outputs, this.getVaultResourceUrl(targetPath), this.settings.htmlExportGraphAssetMode, targetPath, html, blocks);
      this.lastHtmlExport = summary;
      new Notice(`Exported Lotus HTML: ${formatByteSize(summary.bytes)}, ${summary.blocks} blocks, ${summary.outputs} outputs.`);
      new lotusHtmlExportSummaryModal(this, summary).open();
      await this.events.logEvent({
        type: "lotus.html.exported",
        message: "Exported current note as HTML",
        notePath: file.path,
        data: {
          path: targetPath,
          bytes: summary.bytes,
          blocks: summary.blocks,
          outputs: summary.outputs,
          displays: summary.displays,
          artifacts: summary.artifacts,
          graphAssetMode: summary.graphAssetMode,
        },
      });
    } catch (error) {
      new Notice(`Failed to export Lotus HTML: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private getVaultResourceUrl(path: string): string {
    const adapter = this.app.vault.adapter as DataAdapter & { getResourcePath?: (path: string) => string };
    return adapter.getResourcePath?.(path) ?? path;
  }

  openHtmlExport(summary: lotusHtmlExportSummary): void {
    window.open(summary.resourceUrl, "_blank", "noopener,noreferrer");
  }

  async copyHtmlExportPath(summary: lotusHtmlExportSummary): Promise<void> {
    await this.copyTextToClipboard(summary.path, "HTML export path copied.");
  }

  shouldRenderStdinPanel(block: lotusCodeBlock): boolean {
    return this.stdinPanels.has(block.id) || this.hasEnabledStdinAttribute(block);
  }

  hasDynamicInputs(block: lotusCodeBlock): boolean {
    const parsed = parseDynamicInputDirectives(block.content);
    return parsed.inputs.length > 0 || parsed.errors.length > 0;
  }

  private createDynamicInputPanel(block: lotusCodeBlock): HTMLElement {
    const parsed = parseDynamicInputDirectives(block.content);
    const panel = createEl("div", { cls: "lotus-dynamic-input-panel" });

    if (parsed.errors.length) {
      const errors = panel.createDiv({ cls: "lotus-dynamic-input-errors" });
      for (const error of parsed.errors) {
        errors.createDiv({ text: error });
      }
      return panel;
    }

    const values = resolveDynamicInputValues(parsed.inputs, this.runs.dynamicInputValues.get(block.id));
    this.runs.dynamicInputValues.set(block.id, values);
    const fields = parsed.inputs.some((input) => input.kind !== "button")
      ? panel.createDiv({ cls: "lotus-dynamic-input-fields" })
      : null;
    const buttons = parsed.inputs.filter((input) => input.kind === "button");

    for (const input of parsed.inputs) {
      if (input.kind === "button") {
        continue;
      }
      fields?.appendChild(this.createDynamicInputField(block, input, values));
    }

    const actions = panel.createDiv({ cls: "lotus-dynamic-input-actions" });
    if (buttons.length) {
      for (const input of buttons) {
        const button = actions.createEl("button", { text: input.label });
        button.type = "button";
        button.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          if (input.name) {
            values[input.name] = input.defaultValue;
            this.runs.dynamicInputValues.set(block.id, values);
          }
          void this.runActiveBlockById(block.id);
        });
      }
    } else {
      const runButton = actions.createEl("button", { text: "Run", cls: "mod-cta" });
      runButton.type = "button";
      runButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.runActiveBlockById(block.id);
      });
    }

    return panel;
  }

  private createDynamicInputField(
    block: lotusCodeBlock,
    input: lotusDynamicInput,
    values: Record<string, string>,
  ): HTMLElement {
    const field = createEl("label", { cls: `lotus-dynamic-input-field is-${input.kind}` });
    field.createSpan({ cls: "lotus-dynamic-input-label", text: input.label });
    const name = input.name!;
    const currentValue = values[name] ?? input.defaultValue;
    const updateValue = (value: string) => {
      values[name] = value;
      this.runs.dynamicInputValues.set(block.id, values);
    };
    const runOnChange = () => {
      if (input.runOnChange) {
        void this.runActiveBlockById(block.id);
      }
    };

    if (input.kind === "checkbox") {
      const checkbox = field.createEl("input", { attr: { type: "checkbox" } });
      checkbox.checked = currentValue === input.checkedValue;
      checkbox.addEventListener("change", () => {
        updateValue(checkbox.checked ? input.checkedValue! : input.uncheckedValue!);
        runOnChange();
      });
      return field;
    }

    if (input.kind === "select") {
      const select = field.createEl("select");
      for (const option of input.options ?? []) {
        select.createEl("option", {
          text: option.label,
          attr: { value: option.value },
        });
      }
      select.value = currentValue;
      select.addEventListener("change", () => {
        updateValue(select.value);
        runOnChange();
      });
      return field;
    }

    const control = field.createEl("input", {
      attr: {
        type: input.kind === "slider" ? "range" : input.kind,
      },
    });
    control.value = currentValue;
    if (input.min != null) control.min = String(input.min);
    if (input.max != null) control.max = String(input.max);
    if (input.step != null) control.step = String(input.step);
    if (input.placeholder != null) control.placeholder = input.placeholder;

    if (input.kind === "slider") {
      const value = field.createEl("output", {
        cls: "lotus-dynamic-input-value",
        text: currentValue,
      });
      control.addEventListener("input", () => {
        updateValue(control.value);
        value.textContent = control.value;
      });
      control.addEventListener("change", () => {
        updateValue(control.value);
        value.textContent = control.value;
        runOnChange();
      });
    } else {
      control.addEventListener("input", () => updateValue(control.value));
      control.addEventListener("change", () => {
        updateValue(control.value);
        runOnChange();
      });
    }

    return field;
  }

  private hasEnabledStdinAttribute(block: lotusCodeBlock): boolean {
    const input = block.attributes["lotus-input"] ?? block.attributes.input;
    if (this.runs.isFunctionInputBlock(block) && input && !["0", "false", "no", "off"].includes(input.trim().toLowerCase())) {
      return true;
    }
    return block.attributes["lotus-stdin"] != null ||
      block.attributes.stdin != null ||
      block.attributes["lotus-stdin-file"] != null ||
      block.attributes["stdin-file"] != null;
  }

  private createStdinPanel(block: lotusCodeBlock): HTMLElement {
    const panel = createEl("div", { cls: "lotus-stdin-panel" });
    const isFunctionInput = this.runs.isFunctionInputBlock(block);

    const header = panel.createDiv({ cls: "lotus-stdin-header" });
    header.createSpan({ text: isFunctionInput ? "function input" : "stdin" });
    const actions = header.createDiv({ cls: "lotus-stdin-actions" });
    const runButton = actions.createEl("button", { text: isFunctionInput ? "Run function" : "Run" });
    const clearButton = actions.createEl("button", { text: "Clear" });

    const textarea = panel.createEl("textarea", { cls: "lotus-stdin-input" });
    textarea.placeholder = this.getStdinPlaceholder(block);
    textarea.value = this.getInputPanelValue(block);
    textarea.addEventListener("input", () => {
      this.runs.stdinInputs.set(block.id, textarea.value);
    });
    runButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.runs.stdinInputs.set(block.id, textarea.value);
      void this.runActiveBlockById(block.id);
    });
    clearButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      textarea.value = "";
      this.runs.stdinInputs.set(block.id, "");
    });

    return panel;
  }

  private getStdinPlaceholder(block: lotusCodeBlock): string {
    if (this.runs.isFunctionInputBlock(block)) {
      return "input passed to {input} in lotus-call";
    }
    const stdinFile = block.attributes["lotus-stdin-file"] ?? block.attributes["stdin-file"];
    return stdinFile ? `stdin file: ${stdinFile}` : "standard input for this block";
  }

  private getInputPanelValue(block: lotusCodeBlock): string {
    if (this.runs.stdinInputs.has(block.id)) {
      return this.runs.stdinInputs.get(block.id) ?? "";
    }
    if (this.runs.isFunctionInputBlock(block)) {
      return this.runs.resolveBlockFunctionInput(block) ?? "";
    }
    return block.attributes["lotus-stdin"] ?? block.attributes.stdin ?? "";
  }

}
