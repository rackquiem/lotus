import { MarkdownView, Notice, Plugin, TFile, WorkspaceLeaf, normalizePath, parseYaml, requestUrl, type DataAdapter, type MarkdownPostProcessorContext } from "obsidian";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, ViewUpdate } from "@codemirror/view";
import { readFile } from "fs/promises";
import { dirname, isAbsolute, join } from "path";
import { homedir } from "os";
import { lotusContainerRunner, type lotusContainerGroupSummary } from "../engine/execution/containerRunner";
import { runProcess } from "../engine/execution/processRunner";
import { isCompileContainerGroupAllowed, isCompileFeatureAllowed } from "../engine/buildProfile";
import { resolveExecutionContext as resolveLotusExecutionContext } from "./executionContext";
import { addLlvmDecorations, highlightLlvmElement } from "./llvmHighlight";
import { lotusLogger, type lotusLogHost, type lotusLogInput, type lotusLogTarget } from "../engine/logging";
import { resolveBlockHighlightLanguage } from "../engine/languageHighlight";
import { findBlockAtLine, normalizeLanguage, parseMarkdownCodeBlocks } from "../engine/parser";
import { getLanguageCapability } from "../engine/languageCapabilities";
import { findEnabledCommandLanguage } from "../engine/languagePackages";
import { ObsidianContextRunner } from "./runners/obsidianContext";
import { CustomLanguageRunner } from "../engine/runners/custom";
import { createBuiltInRunners } from "../engine/runners/builtIn";
import { lotusRunnerRegistry } from "../engine/runners/registry";
import { DEFAULT_SETTINGS } from "../engine/defaultSettings";
import { lotusSettingTab, showExecutionDisabledNotice } from "./settings";
import { resolveReferencedSource, type lotusExternalSourceExtractor } from "../engine/sourceExtract";
import { runExternalSourcePreprocessorPipeline, type lotusExternalSourcePreprocessor, type lotusPreprocessorPipelineSpec } from "../engine/sourcePreprocess";
import { buildSourceReferenceHarness } from "../engine/sourceHarness";
import { parseDynamicInputDirectives, resolveDynamicInputValues, substituteDynamicInputValues, type lotusDynamicInput } from "../engine/dynamicInputs";
import { createCodeBlockToolbar } from "./ui/codeBlockToolbar";
import { LOTUS_LOG_VIEW_TYPE, lotusLogView } from "./ui/logView";
import { createOutputPanel, createRunningPanel, renderDisplayOutput } from "./ui/outputPanel";
import { createSourceVisualizationDisplay, createStdoutVisualizationDisplay } from "../engine/visualization/codeGraph";
import { createJavaScriptGraphDisplayRenderers } from "./visualization/javascriptGraphs";
import { addSyntaxLanguageClass, highlightCodeElement, normalizeSyntaxLanguage } from "./syntaxHighlight";
import { splitCommandLine } from "../engine/utils/command";
import { sha256Hash } from "../engine/utils/hash";
import { isRecord } from "../engine/utils/record";
import { formatTimeoutLabel, formatTimeoutMs } from "../engine/utils/timeout";
import { LOTUS_MANAGED_DISPLAY_LANGUAGE, parseManagedDisplaySource, renderManagedOutputMarkdown } from "../engine/managedOutput";
import { assertRunnableCodePackage } from "../engine/codePackage";
import { createOpenSshSignature, createPassphraseSignature, createRsaSignature, readSignatureRecord, verifyOpenSshSignature, verifyPassphraseSignature, verifyRsaSignature, type lotusSignatureRecord } from "../engine/signing";
import { CODE_BLOCK_HASHES_FRONTMATTER_KEY, HASH_POLICY_FRONTMATTER_KEY, NOTE_HASH_FRONTMATTER_KEY, REPRODUCIBILITY_FRONTMATTER_KEY, REPRODUCIBILITY_SNAPSHOT_VERSION, SIGNATURE_FRONTMATTER_KEY, canonicalizeNoteForHash, compareCodeBlockHashEntries, createCodeBlockHashEntry as buildCodeBlockHashEntry, createReproducibilitySnapshot as buildReproducibilitySnapshot, createSignaturePayload as buildSignaturePayload, getHashPolicyPresetDefinition, hashPolicyFromPreset, readHashPolicy, readReproducibilityFrontmatter, readStoredCodeBlockHashEntries, readStoredNoteHash, readStoredSignatureValue, serializeHashPolicy, setFrontmatterYamlParser, stableStringify, type lotusCodeBlockHashEntry, type lotusHashPolicy, type lotusHashPolicyPreset, type lotusReproducibilityStatus, type lotusReproducibilityVerification, type lotusReproducibilitySnapshot, type lotusSignaturePayload } from "../engine/reproducibility";
import { apiBlockFromCodeBlock, apiRunFromStoredOutput, lotusApiServer, readApiLogEvents, type lotusApiBlock, type lotusApiLogEvent, type lotusApiNote, type lotusApiRun, type lotusApiRunner } from "../engine/apiServer";
import type { lotusCodeBlock, lotusDisplayOutput, lotusDisplayRenderer, lotusExternalLanguagePack, lotusPluginSettings, lotusResolvedExecutionContext, lotusStdinSession, lotusStoredOutput } from "../engine/types";
import { createHtmlExportSummary, formatByteSize, lotusHtmlExportSummaryModal, renderLotusHtmlExport, type lotusHtmlExportSummary } from "./htmlExport";
import { LANGUAGE_PACK_MANIFEST_NAMES, findBundleManifest, isPathWithin, normalizeBundleEntries, normalizeManifestId, parseExternalLanguagePack, readBundleManifest, readLanguageBundleArchive, readString, toArrayBuffer } from "../engine/languagePackBundle";
import { normalizeSettings, readStoredSettings } from "../engine/settingsNormalize";
import { readOutputFileTarget, renderOutputFileJson, renderOutputFileText } from "../engine/outputFiles";
import { ExecutionConsentModal, ReproducibilityPolicyModal, SignatureMaterialModal, type lotusSignatureMaterial } from "./ui/modals";
import { lotusOutputWidget, lotusRefreshEffect, lotusToolbarRenderChild, lotusToolbarWidget } from "./ui/editorWidgets";

const EXTERNAL_LANGUAGE_PACK_DIR = "language-packs";

type lotusVisualizationMode = "graphviz" | "svg";

interface lotusLiveRunState {
  inputSession: lotusLiveStdinSession | null;
  stdout: string;
  stderr: string;
  startedAt: string;
  runnerName: string;
  notePath: string;
  block: lotusCodeBlock;
  target: lotusLogTarget;
}

interface lotusRunBlockOptions {
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

function sanitizeArtifactSegment(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "") || "note";
}

function readStoredSignature(source: string): lotusSignatureRecord | null {
  return readSignatureRecord(readStoredSignatureValue(source));
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

function formatSignatureScheme(scheme: string): string {
  if (scheme === "rsa-pss-sha256") {
    return "RSA-PSS/SHA-256";
  }
  if (scheme === "openssh-sshsig") {
    return "OpenSSH SSHSIG";
  }
  return "passphrase HMAC/SHA-256";
}

function formatErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function appendWarning(existing: string | undefined, line: string): string {
  return existing ? `${existing}\n${line}` : line;
}

function createObsidianLogHost(app: lotusPlugin["app"]): lotusLogHost {
  const adapter = app.vault.adapter;
  return {
    get vaultName() {
      return app.vault.getName();
    },
    get configDir() {
      return app.vault.configDir;
    },
    get vaultBasePath() {
      return (adapter as { basePath?: string }).basePath;
    },
    exists: (path) => adapter.exists(path),
    read: (path) => adapter.read(path),
    append: (path, content) => adapter.append(path, content),
    write: (path, content) => adapter.write(path, content),
    mkdir: (path) => adapter.mkdir(path),
    postJson: async (url, headers, body) => {
      await requestUrl({ url, method: "POST", contentType: "application/json", headers, body });
    },
  };
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
  private readonly outputs = new Map<string, lotusStoredOutput>();
  private readonly liveRuns = new Map<string, lotusLiveRunState>();
  private cachedSigningPassphrase: string | null = null;
  private readonly stdinInputs = new Map<string, string>();
  private readonly stdinPanels = new Set<string>();
  private readonly dynamicInputValues = new Map<string, Record<string, string>>();
  private readonly running = new Map<string, AbortController>();
  private readonly outputListeners = new Map<string, Set<() => void>>();
  private readonly apiServer = new lotusApiServer(this);
  private statusBarItemEl!: HTMLElement;
  private editorViews = new Set<EditorView>();
  private lastMarkdownFilePath: string | null = null;
  private lastHtmlExport: lotusHtmlExportSummary | null = null;
  private readonly logger = new lotusLogger(createObsidianLogHost(this.app), () => this.settings);

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
        await this.runBlock(file, block);
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
          await this.visualizeBlock(file, block);
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
          void this.runAllBlocksInFile(file);
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
        if (!block || !this.running.has(block.id)) {
          return false;
        }
        if (!checking) {
          void this.cancelBlockRun(block.id, "current block", block, file.path);
        }
        return true;
      },
    });

    this.addCommand({
      id: "cancel-all-code-blocks",
      name: "Cancel all running code blocks",
      checkCallback: (checking) => {
        if (!this.running.size) {
          return false;
        }
        if (!checking) {
          void this.cancelAllRuns();
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
          void this.clearOutputsForFile(file);
        }
        return true;
      },
    });

    this.addCommand({
      id: "export-current-note-html",
      name: "Export current note as Lotus HTML",
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
      name: "Open last Lotus HTML export",
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
      name: "Copy last Lotus HTML export path",
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
          void this.saveReproducibilitySnapshot(file);
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
          void this.verifyReproducibilitySnapshot(file);
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
          void this.signAllNotes();
        },
      });

      this.addCommand({
        id: "verify-all-note-signatures",
        name: "Verify all note signatures",
        callback: () => {
          void this.verifyAllNoteSignatures();
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
          void this.hashCurrentNote(file);
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
          void this.verifyCurrentNoteHash(file);
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
          void this.verifyCodeBlockHashes(file);
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
          void this.runAllBlocksInFile(file);
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
    for (const controller of this.running.values()) {
      controller.abort();
    }
    void this.apiServer.stop();
    this.logger.close();
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
    await this.ensureVaultFolder(bundleDir);

    for (const entry of entries) {
      const targetPath = normalizePath(`${bundleDir}/${entry.path}`);
      if (!isPathWithin(targetPath, bundleDir)) {
        throw new Error(`Invalid bundle path: ${entry.path}`);
      }
      await this.ensureVaultParentFolder(targetPath);
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
    await this.logEvent({
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

  notify(message: string): void {
    new Notice(message);
  }

  isBlockRunning(blockId: string): boolean {
    return this.running.has(blockId);
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

  private async logEvent(input: lotusLogInput): Promise<void> {
    await this.logger.log(await this.enrichLogEvent(input));
  }

  private async enrichLogEvent(input: lotusLogInput): Promise<lotusLogInput> {
    if (!input.notePath || input.noteHash) {
      return input;
    }

    const noteHash = await this.readCurrentNoteHash(input.notePath);
    return noteHash ? { ...input, noteHash } : input;
  }

  private async readCurrentNoteHash(notePath: string): Promise<string | undefined> {
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      return undefined;
    }

    try {
      return sha256Hash(canonicalizeNoteForHash(await this.app.vault.cachedRead(file)));
    } catch (error) {
      console.warn("lotus: failed to compute note hash for log event", error);
      return undefined;
    }
  }

  createToolbarElement(block: lotusCodeBlock): HTMLElement {
    const isFunctionInput = this.isFunctionInputBlock(block);
    return createCodeBlockToolbar(block.id, this.isBlockRunning(block.id), {
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
        const output = this.outputs.get(block.id);
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
    return findEnabledCommandLanguage(this.settings, block.language, block.languageAlias)?.mode === "transpile";
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

    const output = this.outputs.get(blockId);
    if (this.running.has(blockId)) {
      const liveRun = this.liveRuns.get(blockId);
      container.appendChild(createRunningPanel({
        runnerName: liveRun?.runnerName,
        stdout: liveRun?.stdout,
        stderr: liveRun?.stderr,
        inputEnabled: Boolean(liveRun?.inputSession),
        onSendInput: (input) => void this.sendLiveInput(blockId, input),
        onCloseInput: () => void this.closeLiveInput(blockId),
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

  private async sendLiveInput(blockId: string, input: string): Promise<void> {
    const liveRun = this.liveRuns.get(blockId);
    if (!liveRun?.inputSession) {
      new Notice("This running block is not accepting live input.");
      return;
    }

    const sent = liveRun.inputSession.send(input);
    if (!sent) {
      new Notice("The process stdin is not ready.");
      return;
    }

    await this.logEvent({
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

  private async closeLiveInput(blockId: string): Promise<void> {
    const liveRun = this.liveRuns.get(blockId);
    if (!liveRun?.inputSession) {
      return;
    }

    liveRun.inputSession.close();
    liveRun.inputSession = null;
    this.notifyOutputChanged(blockId);
    await this.logEvent({
      type: "lotus.run.input.closed",
      message: "Closed running block input",
      notePath: liveRun.notePath,
      block: liveRun.block,
      target: liveRun.target,
    });
  }

  async runActiveBlockById(blockId: string, options: lotusRunBlockOptions = {}): Promise<void> {
    const block = this.findActiveBlockById(blockId);
    const file = this.getActiveMarkdownFile();
    if (!block || !file) {
      return;
    }
    await this.runBlock(file, block, options);
  }

  async runOrCancelBlockById(blockId: string, options: lotusRunBlockOptions = {}): Promise<void> {
    if (this.running.has(blockId)) {
      const block = this.findActiveBlockById(blockId);
      await this.cancelBlockRun(blockId, "toolbar", block ?? undefined, block?.filePath);
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
    await this.visualizeBlock(file, block);
  }

  async cancelBlockRun(blockId: string, source: string, block?: lotusCodeBlock, filePath?: string): Promise<void> {
    const controller = this.running.get(blockId);
    if (!controller) {
      return;
    }

    controller.abort();
    const output = this.outputs.get(blockId);
    await this.logEvent({
      type: "lotus.run.cancel.requested",
      message: "Cancellation requested",
      notePath: filePath ?? block?.filePath ?? output?.block.filePath ?? this.getCurrentEditorFilePath() ?? undefined,
      block: block ?? output?.block,
      data: {
        source,
        blockId,
      },
    });
    this.notifyOutputChanged(blockId);
    this.updateStatusBar();
    new Notice("Lotus cancellation requested.");
  }

  async cancelAllRuns(): Promise<void> {
    const blockIds = [...this.running.keys()];
    for (const blockId of blockIds) {
      this.running.get(blockId)?.abort();
      this.notifyOutputChanged(blockId);
    }
    await this.logEvent({
      type: "lotus.run.cancel.requested",
      message: "Cancellation requested for all running blocks",
      notePath: this.getCurrentEditorFilePath() ?? undefined,
      data: {
        source: "all",
        count: blockIds.length,
      },
    });
    this.updateStatusBar();
    new Notice(`lotus cancellation requested for ${blockIds.length} run${blockIds.length === 1 ? "" : "s"}.`);
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

    this.running.get(blockId)?.abort();
    this.running.delete(blockId);
    this.outputs.delete(blockId);
    this.dynamicInputValues.delete(blockId);

    await this.app.vault.process(file, (content) => {
      const lines = content.split(/\r?\n/);
      const blocks = parseMarkdownCodeBlocks(file.path, content, this.settings);
      const currentBlock = blocks.find((candidate) => candidate.id === blockId);
      if (!currentBlock) {
        return content;
      }

      const managedRange = this.findManagedOutputRange(lines, blockId);
      const removalStart = currentBlock.startLine;
      const removalEnd = managedRange ? managedRange.end : currentBlock.endLine;
      lines.splice(removalStart, removalEnd - removalStart + 1);

      while (removalStart < lines.length - 1 && lines[removalStart] === "" && lines[removalStart + 1] === "") {
        lines.splice(removalStart, 1);
      }

      return lines.join("\n");
    });
    await this.logEvent({
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

  async runAllBlocksInFile(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const blocks = parseMarkdownCodeBlocks(file.path, source, this.settings);
    const supportedBlocks = blocks.filter((block) => {
      const executionContext = this.resolveExecutionContext(file, block);
      return executionContext.containerGroup || this.registry.getRunnerForBlock(block, this.settings);
    });

    if (!supportedBlocks.length) {
      new Notice("No supported Lotus blocks found in the current note.");
      return;
    }

    for (const block of supportedBlocks) {
      await this.runBlock(file, block);
    }
  }

  async clearOutputsForFile(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const blocks = parseMarkdownCodeBlocks(file.path, source, this.settings);
    for (const block of blocks) {
      this.outputs.delete(block.id);
      this.notifyOutputChanged(block.id);
      await this.removeManagedOutputBlock(file.path, block.id);
    }
    await this.logEvent({
      type: "lotus.note.modified",
      message: "Cleared Lotus outputs",
      notePath: file.path,
      data: {
        action: "outputs.cleared",
        blocks: blocks.length,
      },
    });
    new Notice("Lotus outputs cleared.");
  }

  async listApiNotes(query?: string): Promise<lotusApiNote[]> {
    const normalizedQuery = query?.trim().toLowerCase() ?? "";
    const notes: lotusApiNote[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (normalizedQuery && !file.path.toLowerCase().includes(normalizedQuery) && !file.basename.toLowerCase().includes(normalizedQuery)) {
        continue;
      }
      const source = await this.app.vault.cachedRead(file);
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
    const file = this.app.vault.getAbstractFileByPath(notePath);
    if (!(file instanceof TFile)) {
      throw new Error(`Note not found: ${notePath}`);
    }
    const source = await this.app.vault.cachedRead(file);
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

    const source = await this.app.vault.cachedRead(target.file);
    const lines = source.split(/\r?\n/);
    const replacement = content.split(/\r?\n/);
    lines.splice(
      target.block.startLine + 1,
      Math.max(0, target.block.endLine - target.block.startLine - 1),
      ...replacement,
    );
    const nextSource = lines.join("\n");
    await this.app.vault.modify(target.file, nextSource);
    this.outputs.delete(target.block.id);
    this.notifyOutputChanged(target.block.id);
    await this.writeCodeBlockHashesIfEnabled(target.file);

    const updatedSource = await this.app.vault.cachedRead(target.file);
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

  async listApiLogs(limit: number): Promise<lotusApiLogEvent[]> {
    return readApiLogEvents(this, limit);
  }

  private isApiRunnableBlock(file: TFile, block: lotusCodeBlock): boolean {
    const executionContext = this.resolveExecutionContext(file, block);
    return Boolean(executionContext.containerGroup || this.registry.getRunnerForBlock(block, this.settings));
  }

  private getApiBlockStatus(blockId: string): lotusApiBlock["status"] {
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

  private async findApiBlockById(blockId: string): Promise<{ file: TFile; block: lotusCodeBlock } | null> {
    for (const file of this.app.vault.getMarkdownFiles()) {
      const source = await this.app.vault.cachedRead(file);
      const block = parseMarkdownCodeBlocks(file.path, source, this.settings)
        .find((candidate) => candidate.id === blockId);
      if (block) {
        return { file, block };
      }
    }
    return null;
  }

  async saveReproducibilitySnapshot(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const snapshot = this.createReproducibilitySnapshot(file.path, source);

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const target = frontmatter as Record<string, unknown>;
      target[REPRODUCIBILITY_FRONTMATTER_KEY] = snapshot;
      target[NOTE_HASH_FRONTMATTER_KEY] = snapshot.noteHash;
      target[CODE_BLOCK_HASHES_FRONTMATTER_KEY] = snapshot.blocks;
    });
    await this.logEvent({
      type: "lotus.repro.snapshot.saved",
      message: "Reproducibility snapshot saved",
      notePath: file.path,
      data: {
        noteHash: snapshot.noteHash,
        blocks: snapshot.blocks.length,
        policy: snapshot.policy.preset,
      },
    });
    await this.logEvent({
      type: "lotus.note.modified",
      message: "Wrote reproducibility snapshot frontmatter",
      notePath: file.path,
      data: {
        action: "reproducibility.snapshot.saved",
      },
    });

    new Notice(`lotus reproducibility snapshot saved (${snapshot.blocks.length} block${snapshot.blocks.length === 1 ? "" : "s"}).`);
  }

  async verifyReproducibilitySnapshot(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const verification = this.createReproducibilityVerification(file.path, source);
    await this.writeReproducibilityVerification(file, verification);
    await this.logEvent({
      type: "lotus.repro.verify.finished",
      message: verification.summary,
      notePath: file.path,
      data: {
        status: verification.status,
        issues: verification.issues.length,
        verifiedBlocks: verification.blocks.verified,
        totalBlocks: verification.blocks.total,
      },
    });
    await this.logEvent({
      type: "lotus.note.modified",
      message: "Wrote reproducibility verification frontmatter",
      notePath: file.path,
      data: {
        action: "reproducibility.verify.finished",
        status: verification.status,
      },
    });
    new Notice(verification.summary, verification.status === "verified" ? 6000 : 12000);
  }

  async signCurrentNote(file: TFile): Promise<void> {
    const material = await this.requestSignatureMaterial("Sign Current Note", this.settings.signingMode || "passphrase", "sign");
    if (!material) {
      return;
    }

    try {
      const signature = await this.signNote(file, material);
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

      const result = await this.verifyNoteSignature(file, source, signature, material ?? undefined);
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

  async signAllNotes(): Promise<void> {
    const material = await this.requestSignatureMaterial("Sign All Notes", this.settings.signingMode || "passphrase", "sign");
    if (!material) {
      return;
    }

    const files = this.app.vault.getMarkdownFiles();
    let signed = 0;
    const failures: string[] = [];
    for (const file of files) {
      try {
        await this.signNote(file, material);
        signed += 1;
      } catch (error) {
        failures.push(`${file.path}: ${formatErrorMessage(error)}`);
      }
    }

    const summary = failures.length
      ? `lotus signed ${signed}/${files.length} notes; ${failures.length} failed.`
      : `lotus signed ${signed} note${signed === 1 ? "" : "s"}.`;
    await this.logEvent({
      type: "lotus.signature.all.created",
      message: summary,
      data: {
        signed,
        total: files.length,
        failures: failures.length,
      },
    });
    new Notice(summary, failures.length ? 12000 : 6000);
  }

  async verifyAllNoteSignatures(): Promise<void> {
    const files = this.app.vault.getMarkdownFiles();
    const signatures = new Map<TFile, lotusSignatureRecord>();
    let needsPassphrase = false;
    for (const file of files) {
      const signature = readStoredSignature(await this.app.vault.cachedRead(file));
      if (signature) {
        signatures.set(file, signature);
        needsPassphrase = needsPassphrase || signature.scheme === "passphrase-hmac-sha256";
      }
    }

    const material = needsPassphrase
      ? await this.requestSignatureMaterial("Verify All Note Signatures", "passphrase", "verify")
      : undefined;
    if (needsPassphrase && !material) {
      return;
    }

    let verified = 0;
    const failures: string[] = [];
    for (const file of files) {
      const signature = signatures.get(file);
      if (!signature) {
        failures.push(`${file.path}: missing signature`);
        continue;
      }
      const source = await this.app.vault.cachedRead(file);
      const result = await this.verifyNoteSignature(file, source, signature, material ?? undefined);
      if (result.verified) {
        verified += 1;
      } else {
        failures.push(`${file.path}: ${result.summary}`);
      }
    }

    const summary = failures.length
      ? `lotus verified ${verified}/${files.length} note signatures; ${failures.length} failed.`
      : `lotus verified ${verified} note signature${verified === 1 ? "" : "s"}.`;
    await this.logEvent({
      type: "lotus.signature.all.verify.finished",
      message: summary,
      data: {
        verified,
        total: files.length,
        failures: failures.length,
      },
    });
    new Notice(summary, failures.length ? 12000 : 6000);
  }

  private async signNote(file: TFile, material: lotusSignatureMaterial): Promise<lotusSignatureRecord> {
    const source = await this.app.vault.cachedRead(file);
    const snapshot = this.createReproducibilitySnapshot(file.path, source);
    const payload = this.createSignaturePayload(snapshot);
    const payloadText = stableStringify(payload);
    const signature = material.mode === "passphrase"
      ? createPassphraseSignature(payloadText, material.passphrase ?? "", this.settings.signingSignerId)
      : material.mode === "ssh"
        ? await createOpenSshSignature(
          payloadText,
          await this.resolveSshSigningKeyPath(),
          this.settings.signingSshNamespace,
          this.readSshSignerIdentity(),
          await this.createSshKeyId(),
          this.createSigningSshEnv(),
        )
        : createRsaSignature(payloadText, await this.resolvePrivateKeyPem(material), material.privateKeyPassphrase, this.settings.signingSignerId);

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const target = frontmatter as Record<string, unknown>;
      target[REPRODUCIBILITY_FRONTMATTER_KEY] = snapshot;
      target[NOTE_HASH_FRONTMATTER_KEY] = snapshot.noteHash;
      target[CODE_BLOCK_HASHES_FRONTMATTER_KEY] = snapshot.blocks;
      target[SIGNATURE_FRONTMATTER_KEY] = signature;
    });
    await this.logEvent({
      type: "lotus.signature.created",
      message: "Note signature written",
      notePath: file.path,
      data: {
        scheme: signature.scheme,
        keyId: signature.keyId,
        payloadHash: signature.payloadHash,
        blocks: snapshot.blocks.length,
      },
    });
    await this.logEvent({
      type: "lotus.note.modified",
      message: "Wrote note signature frontmatter",
      notePath: file.path,
      data: {
        action: "signature.created",
        scheme: signature.scheme,
      },
    });
    return signature;
  }

  private createSignaturePayload(snapshot: lotusReproducibilitySnapshot): lotusSignaturePayload {
    return buildSignaturePayload(snapshot);
  }

  private async verifyNoteSignature(file: TFile, source: string, signature: lotusSignatureRecord, material?: lotusSignatureMaterial): Promise<{ verified: boolean; summary: string }> {
    const snapshot = this.createReproducibilitySnapshot(file.path, source);
    const payloadText = stableStringify(this.createSignaturePayload(snapshot));
    const payloadHash = sha256Hash(payloadText);
    let verified = false;

    if (signature.payloadHash !== payloadHash) {
      verified = false;
    } else if (signature.scheme === "passphrase-hmac-sha256") {
      verified = typeof material?.passphrase === "string" && material.passphrase.length > 0
        ? verifyPassphraseSignature(signature, payloadText, material.passphrase)
        : false;
    } else if (signature.scheme === "openssh-sshsig") {
      verified = signature.ssh?.namespace === this.settings.signingSshNamespace
        && await verifyOpenSshSignature(signature, payloadText, await this.resolveSshAllowedSigners(signature));
    } else {
      verified = verifyRsaSignature(signature, payloadText, await this.resolvePublicKeyPem());
    }

    const summary = verified
      ? `lotus signature verified (${formatSignatureScheme(signature.scheme)}, ${signature.keyId}).`
      : signature.payloadHash !== payloadHash
        ? `lotus signature payload changed. stored=${signature.payloadHash.slice(0, 12)} current=${payloadHash.slice(0, 12)}`
        : signature.scheme === "openssh-sshsig" && signature.ssh?.namespace !== this.settings.signingSshNamespace
          ? `lotus signature namespace mismatch. stored=${signature.ssh?.namespace ?? "(missing)"} expected=${this.settings.signingSshNamespace}`
        : `lotus signature cryptographic check failed (${formatSignatureScheme(signature.scheme)}, ${signature.keyId}).`;
    await this.logEvent({
      type: "lotus.signature.verify.finished",
      message: summary,
      notePath: file.path,
      data: {
        status: verified ? "verified" : "changed",
        scheme: signature.scheme,
        keyId: signature.keyId,
        payloadHash,
      },
    });
    return { verified, summary };
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

  private async resolvePrivateKeyPem(material: lotusSignatureMaterial): Promise<string> {
    const pasted = material.privateKeyPem?.trim();
    if (pasted) {
      return pasted;
    }
    throw new Error("No RSA private key was provided.");
  }

  private async resolvePublicKeyPem(): Promise<string> {
    const path = this.settings.signingPublicKeyPath.trim();
    if (path) {
      return await this.readConfiguredTextPath(path);
    }
    const pasted = this.settings.signingPublicKey.trim();
    if (pasted) {
      return pasted;
    }
    throw new Error("No RSA public key is configured.");
  }

  private async resolveSshSigningKeyPath(): Promise<string> {
    const path = this.settings.signingSshKeyPath.trim();
    if (!path) {
      throw new Error("No OpenSSH signing key file is configured.");
    }
    const resolved = this.resolveConfiguredFsPath(path);
    if (isAbsolute(resolved)) {
      return resolved;
    }
    return this.resolveVaultRelativeFsPath(resolved);
  }

  private async createSshKeyId(): Promise<string> {
    const configuredPath = this.settings.signingSshKeyPath.trim();
    if (!configuredPath) {
      return `ssh:${sha256Hash(this.readSshSignerIdentity()).slice(0, 32)}`;
    }
    const publicKey = await this.readOpenSshPublicKeyForPath(configuredPath);
    return `ssh:${sha256Hash(publicKey ?? configuredPath).slice(0, 32)}`;
  }

  private async resolveSshAllowedSigners(signature: lotusSignatureRecord): Promise<string> {
    const path = this.settings.signingSshAllowedSignersPath.trim();
    if (path) {
      return await this.readConfiguredTextPath(path);
    }
    const pasted = this.settings.signingSshAllowedSigners.trim();
    if (pasted) {
      return pasted.endsWith("\n") ? pasted : `${pasted}\n`;
    }

    const publicKey = await this.resolveOpenSshPublicKey();
    const signer = signature.ssh?.signerIdentity || this.readSshSignerIdentity();
    const namespace = signature.ssh?.namespace || this.settings.signingSshNamespace;
    return `${signer} namespaces="${namespace}" ${publicKey.trim()}\n`;
  }

  private async resolveOpenSshPublicKey(): Promise<string> {
    const path = this.settings.signingPublicKeyPath.trim();
    if (path) {
      return await this.readConfiguredTextPath(path);
    }
    const pasted = this.settings.signingPublicKey.trim();
    if (pasted) {
      return pasted;
    }
    const keyPath = this.settings.signingSshKeyPath.trim();
    const adjacentPublicKey = keyPath ? await this.readOpenSshPublicKeyForPath(keyPath) : null;
    if (adjacentPublicKey) {
      return adjacentPublicKey;
    }
    throw new Error("No OpenSSH allowed signers or public key is configured.");
  }

  private async readOpenSshPublicKeyForPath(rawPath: string): Promise<string | null> {
    const resolved = this.resolveConfiguredFsPath(rawPath);
    const candidates = resolved.endsWith(".pub") ? [resolved] : [`${resolved}.pub`, resolved];
    for (const candidate of candidates) {
      try {
        const text = isAbsolute(candidate)
          ? await readFile(candidate, "utf8")
          : await this.app.vault.adapter.read(candidate);
        if (/^(ssh|ecdsa)-[A-Za-z0-9@.-]+\s+[A-Za-z0-9+/=]+/.test(text.trim())) {
          return text.trim();
        }
      } catch {
        // Try the next public key candidate.
      }
    }
    return null;
  }

  private readSshSignerIdentity(): string {
    const signer = this.settings.signingSignerId.trim();
    return signer || "lotus-signer";
  }

  private createSigningSshEnv(): NodeJS.ProcessEnv | undefined {
    const authSock = this.settings.signingSshAuthSock.trim();
    return authSock ? { ...process.env, SSH_AUTH_SOCK: authSock } : undefined;
  }

  private async readConfiguredTextPath(rawPath: string): Promise<string> {
    const expanded = this.resolveConfiguredFsPath(rawPath);
    if (isAbsolute(expanded)) {
      return await readFile(expanded, "utf8");
    }
    return await this.app.vault.adapter.read(normalizePath(expanded));
  }

  private resolveConfiguredFsPath(rawPath: string): string {
    return rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : normalizePath(rawPath);
  }

  private resolveVaultRelativeFsPath(vaultPath: string): string {
    const basePath = (this.app.vault.adapter as { basePath?: string }).basePath;
    return basePath ? join(basePath, vaultPath) : vaultPath;
  }

  async openReproducibilityPolicyModal(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    new ReproducibilityPolicyModal(this.app, readHashPolicy(source), async (preset) => {
      await this.applyReproducibilityPolicyPreset(file, preset);
    }).open();
  }

  async applyReproducibilityPolicyPreset(file: TFile, presetId: Exclude<lotusHashPolicyPreset, "custom">): Promise<void> {
    const policy = hashPolicyFromPreset(presetId);
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const target = frontmatter as Record<string, unknown>;
      target[HASH_POLICY_FRONTMATTER_KEY] = serializeHashPolicy(policy);
      const existing = isRecord(target[REPRODUCIBILITY_FRONTMATTER_KEY])
        ? { ...target[REPRODUCIBILITY_FRONTMATTER_KEY] }
        : {};
      target[REPRODUCIBILITY_FRONTMATTER_KEY] = {
        ...existing,
        version: REPRODUCIBILITY_SNAPSHOT_VERSION,
        policy: serializeHashPolicy(policy),
      };
    });
    await this.logEvent({
      type: "lotus.note.modified",
      message: "Updated reproducibility policy",
      notePath: file.path,
      data: {
        action: "reproducibility.policy.changed",
        policy: presetId,
      },
    });
    new Notice(`lotus reproducibility policy set to ${getHashPolicyPresetDefinition(presetId).label}.`);
  }

  async copyReproducibilitySnapshot(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const existing = readReproducibilityFrontmatter(source);
    const snapshot = existing ?? this.createReproducibilitySnapshot(file.path, source);
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
      : this.createReproducibilityVerification(file.path, source);
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

  async hashCurrentNote(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const noteHash = sha256Hash(canonicalizeNoteForHash(source));

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const target = frontmatter as Record<string, unknown>;
      target[NOTE_HASH_FRONTMATTER_KEY] = noteHash;
      if (isRecord(target[REPRODUCIBILITY_FRONTMATTER_KEY])) {
        target[REPRODUCIBILITY_FRONTMATTER_KEY] = {
          ...target[REPRODUCIBILITY_FRONTMATTER_KEY],
          version: REPRODUCIBILITY_SNAPSHOT_VERSION,
          updatedAt: new Date().toISOString(),
          noteHash,
          policy: serializeHashPolicy(readHashPolicy(source)),
        };
      }
    });
    await this.logEvent({
      type: "lotus.note.modified",
      message: "Wrote note hash",
      notePath: file.path,
      data: {
        action: "hash.note",
        noteHash,
      },
    });

    if (this.settings.hashCodeBlocks) {
      await this.writeCodeBlockHashesToFrontmatter(file);
    }

    new Notice(`lotus note hash written: ${noteHash}`);
  }

  async verifyCurrentNoteHash(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const storedHash = readStoredNoteHash(source);
    if (!storedHash) {
      new Notice("No Lotus-note-hash found. Run Lotus: Hash current note first.");
      return;
    }

    const currentHash = sha256Hash(canonicalizeNoteForHash(source));
    if (storedHash === currentHash) {
      new Notice("Lotus note hash verified.");
      return;
    }

    new Notice(`lotus note hash mismatch. stored=${storedHash.slice(0, 12)} current=${currentHash.slice(0, 12)}`, 10000);
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

    const entries = await this.writeCodeBlockHashesToFrontmatter(file, source);
    const currentEntry = entries.find((entry) => entry.ordinal === block.ordinal);
    await this.logEvent({
      type: "lotus.note.modified",
      message: "Wrote code block hashes",
      notePath: file.path,
      block,
      data: {
        action: "hash.code-blocks",
        blocks: entries.length,
        currentHash: currentEntry?.hash ?? this.createCodeBlockHashEntry(block, readHashPolicy(source)).hash,
      },
    });
    new Notice(`lotus block hash: ${currentEntry?.hash ?? this.createCodeBlockHashEntry(block, readHashPolicy(source)).hash}`);
  }

  async verifyCodeBlockHashes(file: TFile): Promise<void> {
    const source = await this.app.vault.cachedRead(file);
    const storedEntries = readStoredCodeBlockHashEntries(source);
    if (!storedEntries.length) {
      new Notice("No Lotus-code-block-hashes found. Run Lotus: Hash current code block first.");
      return;
    }

    const policy = readHashPolicy(source);
    const currentEntries = parseMarkdownCodeBlocks(file.path, source, this.settings)
      .map((block) => this.createCodeBlockHashEntry(block, policy));
    const storedByOrdinal = new Map(storedEntries.map((entry) => [entry.ordinal, entry]));
    const currentByOrdinal = new Map(currentEntries.map((entry) => [entry.ordinal, entry]));
    let verified = 0;
    const issues: string[] = [];

    for (const current of currentEntries) {
      const stored = storedByOrdinal.get(current.ordinal);
      if (!stored) {
        issues.push(`#${current.ordinal} missing stored hash`);
        continue;
      }
      if (stored.hash !== current.hash || stored.language !== current.language) {
        issues.push(`#${current.ordinal} changed`);
        continue;
      }
      verified += 1;
    }

    for (const stored of storedEntries) {
      if (!currentByOrdinal.has(stored.ordinal)) {
        issues.push(`#${stored.ordinal} stored hash has no current block`);
      }
    }

    if (!issues.length) {
      new Notice(`lotus verified ${verified} code block hash${verified === 1 ? "" : "es"}.`);
      return;
    }

    new Notice(`lotus block hash verification failed: ${issues.slice(0, 4).join("; ")}${issues.length > 4 ? `; +${issues.length - 4} more` : ""}`, 12000);
  }

  private createReproducibilitySnapshot(filePath: string, source: string): lotusReproducibilitySnapshot {
    return buildReproducibilitySnapshot(filePath, source, this.settings);
  }

  private createReproducibilityVerification(filePath: string, source: string): lotusReproducibilityVerification {
    const storedHash = readStoredNoteHash(source) ?? "";
    const currentHash = sha256Hash(canonicalizeNoteForHash(source));
    const storedEntries = readStoredCodeBlockHashEntries(source);
    const policy = readHashPolicy(source);
    const currentEntries = parseMarkdownCodeBlocks(filePath, source, this.settings)
      .map((block) => this.createCodeBlockHashEntry(block, policy));
    const blockComparison = compareCodeBlockHashEntries(storedEntries, currentEntries);
    const issues: string[] = [];

    const noteStatus = storedHash
      ? storedHash === currentHash ? "verified" : "changed"
      : "missing";
    if (noteStatus === "missing") {
      issues.push("note snapshot is missing");
    } else if (noteStatus === "changed") {
      issues.push("note content changed");
    }
    issues.push(...blockComparison.issues);

    const status: lotusReproducibilityStatus = !storedHash && !storedEntries.length
      ? "missing-snapshot"
      : issues.length ? "changed" : "verified";
    const summary = status === "verified"
      ? `lotus reproducibility verified (${blockComparison.verified} block${blockComparison.verified === 1 ? "" : "s"}).`
      : status === "missing-snapshot"
        ? "No lotus reproducibility snapshot found. Save a snapshot first."
        : `lotus reproducibility changed: ${issues.slice(0, 3).join("; ")}${issues.length > 3 ? `; +${issues.length - 3} more` : ""}`;

    return {
      status,
      checkedAt: new Date().toISOString(),
      summary,
      issues,
      note: {
        status: noteStatus,
        storedHash,
        currentHash,
      },
      blocks: {
        verified: blockComparison.verified,
        total: currentEntries.length,
        issues: blockComparison.issues,
      },
    };
  }

  private async writeReproducibilityVerification(file: TFile, verification: lotusReproducibilityVerification): Promise<void> {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const target = frontmatter as Record<string, unknown>;
      const existing = isRecord(target[REPRODUCIBILITY_FRONTMATTER_KEY])
        ? { ...target[REPRODUCIBILITY_FRONTMATTER_KEY] }
        : { version: REPRODUCIBILITY_SNAPSHOT_VERSION };
      target[REPRODUCIBILITY_FRONTMATTER_KEY] = {
        ...existing,
        version: REPRODUCIBILITY_SNAPSHOT_VERSION,
        verification,
      };
    });
  }

  async runBlock(file: TFile, block: lotusCodeBlock, options: lotusRunBlockOptions = {}): Promise<lotusStoredOutput | null> {
    this.lastMarkdownFilePath = file.path;
    if (this.running.has(block.id)) {
      new Notice("This Lotus block is already running.");
      return this.outputs.get(block.id) ?? null;
    }

    if (!(await this.ensureExecutionEnabled())) {
      showExecutionDisabledNotice();
      return null;
    }
    if (options.intent === "transpile" && !this.shouldShowTranspileButton(block)) {
      new Notice("This block is not configured for transpile mode.");
      return null;
    }

    const executionContext = this.resolveExecutionContext(file, block);
    const containerGroup = executionContext.containerGroup;
    const controller = new AbortController();
    const stdin = await this.resolveBlockStdin(file, block);
    let runnerName = containerGroup ? `execution group ${containerGroup}` : "preparing";
    let runnerId = containerGroup ? `container:${containerGroup}` : "pending";
    const noteHash = await this.readCurrentNoteHash(file.path);
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
      this.notifyOutputChanged(block.id);
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
    this.notifyOutputChanged(block.id);
    this.updateStatusBar();

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
      this.notifyOutputChanged(block.id);
      await this.logEvent({
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

      await this.logger.logRunFinished(file.path, block, runnerName, result, {
        containerGroup,
        workingDirectory: executionContext.workingDirectory,
        timeoutMs: executionContext.timeoutMs,
        sourceReference: Boolean(block.sourceReference),
        executionLanguage: resolvedBlock.block.language,
        intent: options.intent ?? "run",
        noteHash,
      }, logTarget, await this.readCurrentNoteHash(file.path));
      const transpiled = options.intent === "transpile" || result.stdoutRole === "transpiled-source";
      new Notice(result.success
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
      await this.logEvent({
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
      new Notice(`lotus error: ${message}`);
    } finally {
      inputSession?.close();
      this.liveRuns.delete(block.id);
      await this.writeCodeBlockHashesIfEnabled(file);
      this.running.delete(block.id);
      this.notifyOutputChanged(block.id);
      this.updateStatusBar();
    }
    return storedOutput;
  }

  async visualizeBlock(file: TFile, block: lotusCodeBlock): Promise<void> {
    if (!isCompileFeatureAllowed("rich-displays")) {
      new Notice("Lotus rich displays are not included in this build.");
      return;
    }

    this.lastMarkdownFilePath = file.path;
    if (this.running.has(block.id)) {
      new Notice("This Lotus block is already running.");
      return;
    }

    const executionContext = this.resolveExecutionContext(file, block);
    if ((executionContext.containerGroup || this.settings.graphvizExecutable.trim()) && !(await this.ensureExecutionEnabled())) {
      showExecutionDisabledNotice();
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
    this.notifyOutputChanged(block.id);
    this.updateStatusBar();

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
      await this.logger.logRunFinished(file.path, block, result.runnerName, result, {
        visualization: "source",
        language: block.language,
      }, {
          runnerId: result.runnerId,
          runnerName: result.runnerName,
          containerGroup: executionContext.containerGroup,
          workingDirectory: executionContext.workingDirectory,
          timeoutMs: executionContext.timeoutMs,
          source: executionContext.source,
      }, await this.readCurrentNoteHash(file.path));
      new Notice(`lotus visualized ${block.language} block.`);
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
      new Notice(`lotus visualization failed: ${message}`);
    } finally {
      this.running.delete(block.id);
      this.notifyOutputChanged(block.id);
      this.updateStatusBar();
    }
  }

  private async prepareDisplayOutputs(
    file: TFile,
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

  private readVisualizationMode(block: lotusCodeBlock, explicitVisualize: boolean | undefined): lotusVisualizationMode | null {
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

  private createDisplayFromStdout(stdout: string, mode: lotusVisualizationMode): lotusDisplayOutput | null {
    return createStdoutVisualizationDisplay(stdout, mode);
  }

  private async enrichGraphvizDisplay(
    display: lotusDisplayOutput,
    file: TFile,
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

  private async renderGraphvizSvg(
    dot: string,
    executable: string,
    file: TFile,
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

  private createGraphvizBlock(block: lotusCodeBlock, dot: string): lotusCodeBlock {
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

  private async writeCodeBlockHashesIfEnabled(file: TFile): Promise<void> {
    if (!this.settings.hashCodeBlocks) {
      return;
    }

    try {
      const entries = await this.writeCodeBlockHashesToFrontmatter(file);
      await this.logEvent({
        type: "lotus.note.modified",
        message: "Auto-wrote code block hashes",
        notePath: file.path,
        data: {
          action: "hash.code-blocks.auto",
          blocks: entries.length,
        },
      });
    } catch (error) {
      console.warn("lotus: failed to write code block hashes", error);
    }
  }

  private async writeCodeBlockHashesToFrontmatter(file: TFile, source?: string): Promise<lotusCodeBlockHashEntry[]> {
    const text = source ?? await this.app.vault.cachedRead(file);
    const policy = readHashPolicy(text);
    const entries = parseMarkdownCodeBlocks(file.path, text, this.settings)
      .map((block) => this.createCodeBlockHashEntry(block, policy));

    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const target = frontmatter as Record<string, unknown>;
      target[CODE_BLOCK_HASHES_FRONTMATTER_KEY] = entries;
      if (isRecord(target[REPRODUCIBILITY_FRONTMATTER_KEY])) {
        target[REPRODUCIBILITY_FRONTMATTER_KEY] = {
          ...target[REPRODUCIBILITY_FRONTMATTER_KEY],
          version: REPRODUCIBILITY_SNAPSHOT_VERSION,
          updatedAt: new Date().toISOString(),
          policy: serializeHashPolicy(policy),
          blocks: entries,
        };
      }
    });

    return entries;
  }

  private createCodeBlockHashEntry(block: lotusCodeBlock, policy: lotusHashPolicy): lotusCodeBlockHashEntry {
    return buildCodeBlockHashEntry(block, policy);
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

  private async resolveExecutableBlock(file: TFile, block: lotusCodeBlock, signal?: AbortSignal): Promise<{ block: lotusCodeBlock; sourcePreview?: lotusStoredOutput["sourcePreview"]; preprocessDescription?: string }> {
    assertRunnableCodePackage(block);
    let executableBlock = block;
    let sourcePreview: lotusStoredOutput["sourcePreview"] | undefined;
    const shouldShowPreview = (this.settings.extractedSourcePreviewMode || "collapsed") !== "hidden";

    if (block.sourceReference) {
      const referencePath = this.resolveReferencedVaultPath(file, block.sourceReference.filePath);
      const sourceFile = this.app.vault.getAbstractFileByPath(referencePath);
      if (!(sourceFile instanceof TFile)) {
        throw new Error(`Referenced source file not found: ${referencePath}`);
      }

      const harness = buildSourceReferenceHarness(block, this.resolveBlockFunctionInput(block));
      const externalExtractor = this.getCustomLanguageExtractor(block, file);
      const resolved = await resolveReferencedSource(
        await this.app.vault.cachedRead(sourceFile),
        { ...block.sourceReference, filePath: referencePath },
        block.language,
        harness,
        {
          pythonExecutable: this.settings.pythonExecutable.trim() || "python3",
          externalExtractor,
          readFile: async (filePath) => {
            const importedFile = this.app.vault.getAbstractFileByPath(normalizePath(filePath));
            return importedFile instanceof TFile ? this.app.vault.cachedRead(importedFile) : null;
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

  private applyDynamicInputPreprocessor(block: lotusCodeBlock, executableBlock: lotusCodeBlock): lotusCodeBlock {
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

  private resolveReferencedVaultPath(file: TFile, referencePath: string): string {
    const trimmed = referencePath.trim();
    if (!trimmed) {
      return trimmed;
    }
    if (trimmed.startsWith("/")) {
      return normalizePath(trimmed.slice(1));
    }

    const baseDir = dirname(file.path);
    return normalizePath(baseDir === "." ? trimmed : `${baseDir}/${trimmed}`);
  }

  private resolvePythonImportVaultPath(fromFilePath: string, moduleName: string, level: number): string | null {
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
        const normalized = normalizePath(candidate);
        if (this.app.vault.getAbstractFileByPath(normalized) instanceof TFile) {
          return normalized;
        }
      }
    }

    return null;
  }

  private getPythonImportCandidates(baseDir: string, modulePath: string): string[] {
    const prefix = baseDir ? `${baseDir}/` : "";
    if (!modulePath) {
      return [`${prefix}__init__.py`];
    }
    return [
      `${prefix}${modulePath}.py`,
      `${prefix}${modulePath}/__init__.py`,
    ];
  }

  private ascendVaultPath(path: string, levels: number): string {
    let current = path;
    for (let index = 0; index < levels; index += 1) {
      const next = dirname(current);
      current = next === "." ? "" : next;
    }
    return current;
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
    const activeRuns = this.running.size;
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
      return this.outputs.get(blockId)?.block ?? null;
    }

    const blocks = parseMarkdownCodeBlocks(file.path, editor.getValue(), this.settings);
    return blocks.find((block) => block.id === blockId) ?? this.outputs.get(blockId)?.block ?? null;
  }

  private createLivePreviewExtension() {
    const addEditorView = (view: EditorView) => this.editorViews.add(view);
    const deleteEditorView = (view: EditorView) => this.editorViews.delete(view);
    const getCurrentEditorFilePath = () => this.getCurrentEditorFilePath();
    const getSettings = () => this.settings;
    const hasOutput = (blockId: string) => this.outputs.has(blockId);
    const isRunning = (blockId: string) => this.running.has(blockId);
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

  private resolveExecutionContext(file: TFile, block: lotusCodeBlock): lotusResolvedExecutionContext {
    const context = resolveLotusExecutionContext(this.app, file, block, this.settings);
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

  private hasExplicitExecutionContext(context: lotusResolvedExecutionContext): boolean {
    return context.source.container !== "none" || context.source.workingDirectory !== "default" || context.source.timeout !== "global";
  }

  private formatExecutionContextNotice(context: lotusResolvedExecutionContext): string {
    const pieces = [
      `execution=${context.containerGroup ?? "native"} (${context.source.container})`,
      `cwd=${context.workingDirectory} (${context.source.workingDirectory})`,
      `timeout=${formatTimeoutLabel(context.timeoutMs)} (${context.source.timeout})`,
    ];
    return `Execution context: ${pieces.join(", ")}.`;
  }

  private getCustomLanguageExtractor(block: lotusCodeBlock, file: TFile): lotusExternalSourceExtractor | undefined {
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

  private getCustomLanguagePreprocessorPipeline(block: lotusCodeBlock, file: TFile, signal?: AbortSignal): lotusPreprocessorPipelineSpec | undefined {
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

  private getCustomLanguagePreprocessorStages(language: NonNullable<ReturnType<typeof findEnabledCommandLanguage>>): lotusExternalSourcePreprocessor[] {
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

  private getPreprocessorArtifactDirectory(file: TFile, block: lotusCodeBlock, executionContext: lotusResolvedExecutionContext): string {
    const vaultBasePath = (file.vault.adapter as { basePath?: string }).basePath;
    const root = vaultBasePath || executionContext.workingDirectory || process.cwd();
    return join(root, ".lotus", "preprocess", sanitizeArtifactSegment(file.path), `block-${block.ordinal}-${sanitizeArtifactSegment(block.sourceLanguage || block.language)}`);
  }

  private async writeManagedOutputBlock(file: TFile, block: lotusCodeBlock, result: lotusStoredOutput["result"], mode: "replace" | "append" = "replace"): Promise<void> {
    await this.app.vault.process(file, (content) => {
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
    await this.logEvent({
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
    await this.logEvent({
      type: "lotus.note.modified",
      message: "Inserted managed output section",
      notePath: file.path,
      block,
      data: {
        action: "output.written",
      },
    });
  }

  private async writeOutputFileIfRequested(file: TFile, block: lotusCodeBlock, result: lotusStoredOutput["result"]): Promise<void> {
    try {
      const target = readOutputFileTarget(this.app.vault.configDir, file, block);
      if (!target) {
        return;
      }

      await this.ensureVaultParentFolder(target.path);
      const rendered = target.format === "json"
        ? renderOutputFileJson(file, block, result, target)
        : renderOutputFileText(result, target);
      const current = target.mode === "append" && await this.app.vault.adapter.exists(target.path)
        ? await this.app.vault.adapter.read(target.path)
        : "";
      const next = target.mode === "append" && current
        ? `${current.replace(/\s*$/, "\n")}${rendered}`
        : rendered;
      await this.app.vault.adapter.write(target.path, next);
      await this.logEvent({
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

  private async ensureVaultParentFolder(path: string): Promise<void> {
    const folder = dirname(path);
    if (!folder || folder === ".") {
      return;
    }

    await this.ensureVaultFolder(folder);
  }

  private async ensureVaultFolder(folder: string): Promise<void> {
    let current = "";
    for (const part of folder.split("/").filter(Boolean)) {
      current = current ? `${current}/${part}` : part;
      if (!(await this.app.vault.adapter.exists(current))) {
        await this.app.vault.adapter.mkdir(current);
      }
    }
  }

  private async exportCurrentNoteHtml(file: TFile, source: string): Promise<void> {
    try {
      const targetPath = normalizePath(`.lotus/exports/${sanitizeArtifactSegment(file.path)}.html`);
      const blocks = parseMarkdownCodeBlocks(file.path, source, this.settings);
      const html = renderLotusHtmlExport(this.outputs, this.settings.htmlExportGraphAssetMode, file, source, blocks);
      await this.ensureVaultParentFolder(targetPath);
      await this.app.vault.adapter.write(targetPath, html);
      const summary = createHtmlExportSummary(this.outputs, this.getVaultResourceUrl(targetPath), this.settings.htmlExportGraphAssetMode, targetPath, html, blocks);
      this.lastHtmlExport = summary;
      new Notice(`Exported Lotus HTML: ${formatByteSize(summary.bytes)}, ${summary.blocks} blocks, ${summary.outputs} outputs.`);
      new lotusHtmlExportSummaryModal(this, summary).open();
      await this.logEvent({
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

  private async removeManagedOutputBlock(filePath: string, blockId: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) {
      return;
    }

    await this.app.vault.process(file, (content) => {
      const lines = content.split(/\r?\n/);
      const range = this.findManagedOutputRange(lines, blockId);
      if (!range) {
        return content;
      }
      lines.splice(range.start, range.end - range.start + 1);
      return lines.join("\n");
    });
  }

  private renderManagedOutputMarkdown(blockId: string, result: lotusStoredOutput["result"]): string[] {
    return renderManagedOutputMarkdown(blockId, result);
  }

  private findManagedOutputRange(lines: string[], blockId: string): { start: number; end: number } | null {
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

  shouldRenderStdinPanel(block: lotusCodeBlock): boolean {
    return this.stdinPanels.has(block.id) || this.hasEnabledStdinAttribute(block);
  }

  hasDynamicInputs(block: lotusCodeBlock): boolean {
    const parsed = parseDynamicInputDirectives(block.content);
    return parsed.inputs.length > 0 || parsed.errors.length > 0;
  }

  private createDynamicInputPanel(block: lotusCodeBlock): HTMLElement {
    const parsed = parseDynamicInputDirectives(block.content);
    const panel = activeDocument.createElement("div");
    panel.className = "lotus-dynamic-input-panel";

    if (parsed.errors.length) {
      const errors = panel.createDiv({ cls: "lotus-dynamic-input-errors" });
      for (const error of parsed.errors) {
        errors.createDiv({ text: error });
      }
      return panel;
    }

    const values = resolveDynamicInputValues(parsed.inputs, this.dynamicInputValues.get(block.id));
    this.dynamicInputValues.set(block.id, values);
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
            this.dynamicInputValues.set(block.id, values);
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
    const field = activeDocument.createElement("label");
    field.className = `lotus-dynamic-input-field is-${input.kind}`;
    field.createSpan({ cls: "lotus-dynamic-input-label", text: input.label });
    const name = input.name!;
    const currentValue = values[name] ?? input.defaultValue;
    const updateValue = (value: string) => {
      values[name] = value;
      this.dynamicInputValues.set(block.id, values);
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
    if (this.isFunctionInputBlock(block) && input && !["0", "false", "no", "off"].includes(input.trim().toLowerCase())) {
      return true;
    }
    return block.attributes["lotus-stdin"] != null ||
      block.attributes.stdin != null ||
      block.attributes["lotus-stdin-file"] != null ||
      block.attributes["stdin-file"] != null;
  }

  private isFunctionInputBlock(block: lotusCodeBlock): boolean {
    return Boolean(block.sourceReference?.call);
  }

  private createStdinPanel(block: lotusCodeBlock): HTMLElement {
    const panel = activeDocument.createElement("div");
    panel.className = "lotus-stdin-panel";
    const isFunctionInput = this.isFunctionInputBlock(block);

    const header = panel.createDiv({ cls: "lotus-stdin-header" });
    header.createSpan({ text: isFunctionInput ? "function input" : "stdin" });
    const actions = header.createDiv({ cls: "lotus-stdin-actions" });
    const runButton = actions.createEl("button", { text: isFunctionInput ? "Run function" : "Run" });
    const clearButton = actions.createEl("button", { text: "Clear" });

    const textarea = panel.createEl("textarea", { cls: "lotus-stdin-input" });
    textarea.placeholder = this.getStdinPlaceholder(block);
    textarea.value = this.getInputPanelValue(block);
    textarea.addEventListener("input", () => {
      this.stdinInputs.set(block.id, textarea.value);
    });
    runButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.stdinInputs.set(block.id, textarea.value);
      void this.runActiveBlockById(block.id);
    });
    clearButton.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      textarea.value = "";
      this.stdinInputs.set(block.id, "");
    });

    return panel;
  }

  private getStdinPlaceholder(block: lotusCodeBlock): string {
    if (this.isFunctionInputBlock(block)) {
      return "input passed to {input} in lotus-call";
    }
    const stdinFile = block.attributes["lotus-stdin-file"] ?? block.attributes["stdin-file"];
    return stdinFile ? `stdin file: ${stdinFile}` : "standard input for this block";
  }

  private getInputPanelValue(block: lotusCodeBlock): string {
    if (this.stdinInputs.has(block.id)) {
      return this.stdinInputs.get(block.id) ?? "";
    }
    if (this.isFunctionInputBlock(block)) {
      return this.resolveBlockFunctionInput(block) ?? "";
    }
    return block.attributes["lotus-stdin"] ?? block.attributes.stdin ?? "";
  }

  private resolveBlockFunctionInput(block: lotusCodeBlock): string | undefined {
    if (!this.isFunctionInputBlock(block)) {
      return undefined;
    }
    if (this.stdinInputs.has(block.id)) {
      return this.stdinInputs.get(block.id);
    }

    const inline = block.attributes["lotus-input"] ?? block.attributes.input;
    return inline != null ? decodeEscapedAttribute(inline) : block.content.trim();
  }

  private async resolveBlockStdin(file: TFile, block: lotusCodeBlock): Promise<string | undefined> {
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
    const inputFile = this.app.vault.getAbstractFileByPath(stdinPath);
    if (!(inputFile instanceof TFile)) {
      throw new Error(`stdin file not found: ${stdinPath}`);
    }
    return this.app.vault.cachedRead(inputFile);
  }
}
