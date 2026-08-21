import type { lotusTimeoutMs } from "./utils/timeout";

export type lotusNormalizedLanguage = string;
export type lotusLoggingMachineHashScope = "install" | "vault" | "install-vault";
export type lotusHtmlExportGraphAssetMode = "cdn" | "self-contained";

export interface lotusCodeBlock {
  id: string;
  ordinal: number;
  filePath: string;
  language: lotusNormalizedLanguage;
  languageAlias: string;
  sourceLanguage: string;
  content: string;
  attributes: Record<string, string>;
  codePackage?: lotusCodePackage;
  sourceReference?: lotusSourceReference;
  executionContext: lotusExecutionContextOverride;
  startLine: number;
  endLine: number;
  fenceStart: number;
  fenceEnd: number;
}

export interface lotusCodePackage {
  name: string;
  hash: string;
  files: lotusCodePackageFile[];
  errors: string[];
}

export interface lotusCodePackageFile {
  path: string;
  content: string;
  ordinal: number;
  language: lotusNormalizedLanguage;
  sourceLanguage: string;
}

export interface lotusExecutionContextOverride {
  containerGroup?: string;
  disableContainer?: boolean;
  workingDirectory?: string;
  timeoutMs?: lotusTimeoutMs;
}

export interface lotusResolvedExecutionContext {
  containerGroup?: string;
  workingDirectory: string;
  timeoutMs: lotusTimeoutMs;
  source: {
    container: "global" | "note" | "block" | "none";
    workingDirectory: "global" | "note" | "block" | "default";
    timeout: "global" | "note" | "block";
  };
}

export interface lotusSourceReference {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
  symbolName?: string;
  traceDependencies: boolean;
  call?: lotusSourceCallHarness;
}

export interface lotusSourceCallHarness {
  expression?: string;
  args?: string;
  print: boolean;
}

export interface lotusRunFile {
  path: string;
  name: string;
  basename: string;
  extension: string;
}

export interface lotusRunContext {
  file: lotusRunFile;
  workingDirectory: string;
  timeoutMs: lotusTimeoutMs;
  signal: AbortSignal;
  stdin?: string;
  stdinSession?: lotusStdinSession;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface lotusStdinSession {
  attachWriter(writer: (chunk: string | null) => void): () => void;
}

export interface lotusRunResult {
  runnerId: string;
  runnerName: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  success: boolean;
  timedOut: boolean;
  cancelled: boolean;
  warning?: string;
  displays?: lotusDisplayOutput[];
  artifacts?: lotusRunArtifact[];
  stdoutLanguage?: lotusNormalizedLanguage;
  stdoutRole?: "output" | "transpiled-source";
}

export type lotusDisplayRole = "result" | "visualization" | "diagnostic" | "artifact";

export interface lotusDisplayOutput {
  id?: string;
  title?: string;
  role?: lotusDisplayRole;
  data: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface lotusRunArtifact {
  name: string;
  path: string;
  mimeType: string;
  size: number;
  dataBase64: string;
}

export type lotusCustomLanguageDisplayOutput = "none" | "copy-stdout" | "replace-stdout";

export type lotusDisplayRendererCleanup = () => void;

export interface lotusDisplayRendererContext {
  mime: string;
  value: unknown;
  display: lotusDisplayOutput;
  metadata: Record<string, unknown>;
  visibleLines: number;
}

export interface lotusDisplayRenderer {
  id?: string;
  mimeTypes: readonly string[];
  render(
    container: HTMLElement,
    context: lotusDisplayRendererContext,
  ): void | lotusDisplayRendererCleanup | Promise<void | lotusDisplayRendererCleanup>;
}

export interface lotusRunner {
  id: string;
  displayName: string;
  languages: readonly lotusNormalizedLanguage[];
  canRun(block: lotusCodeBlock, settings: lotusPluginSettings): boolean;
  run(block: lotusCodeBlock, context: lotusRunContext, settings: lotusPluginSettings): Promise<lotusRunResult>;
}

export interface lotusStoredOutput {
  blockId: string;
  block: lotusCodeBlock;
  result: lotusRunResult;
  sourcePreview?: lotusSourcePreview;
  collapsed: boolean;
  visible: boolean;
}

export interface lotusSourcePreview {
  description: string;
  language: lotusNormalizedLanguage;
  content: string;
  capability?: lotusLanguageCapabilitySnapshot;
  stages?: lotusSourcePreviewStage[];
  expanded: boolean;
  showCapabilityMetadata: boolean;
}

export interface lotusSourcePreviewStage {
  label: string;
  description: string;
  language: lotusNormalizedLanguage;
  extension?: string;
  path?: string;
  content: string;
}

export interface lotusLanguageCapabilitySnapshot {
  symbolExtraction: string;
  dependencyTracing: string;
  callHarness: string;
  sourcePreview: boolean;
}

export interface lotusPluginSettings {
  enableLocalExecution: boolean;
  hasAcknowledgedExecutionRisk: boolean;
  preserveSourceMode: boolean;
  defaultTimeoutMs: number;
  workingDirectory: string;
  pythonExecutable: string;
  nodeExecutable: string;
  typescriptMode: "ts-node" | "tsx";
  typescriptTranspilerExecutable: string;
  ocamlMode: "ocaml" | "ocamlc" | "dune";
  ocamlExecutable: string;
  cExecutable: string;
  cppExecutable: string;
  shellExecutable: string;
  rubyExecutable: string;
  perlExecutable: string;
  luaExecutable: string;
  phpExecutable: string;
  goExecutable: string;
  rustExecutable: string;
  haskellExecutable: string;
  javaCompilerExecutable: string;
  javaExecutable: string;
  graphvizExecutable: string;
  llvmInterpreterExecutable: string;
  ebpfClangExecutable: string;
  ebpfBpftoolExecutable: string;
  ebpfLlvmObjdumpExecutable: string;
  ebpfIncludePaths: string;
  ebpfAllowKernelLoad: boolean;
  bpftraceExecutable: string;
  leanExecutable: string;
  coqExecutable: string;
  smtExecutable: string;
  writeOutputToNote: boolean;
  outputVisibleLines: number;
  autoRunOnFileOpen: boolean;
  apiEnabled: boolean;
  apiHost: string;
  apiPort: number;
  apiKeys: string;
  showCodeVisualizationButton: boolean;
  hashCodeBlocks: boolean;
  signingMode: "passphrase" | "rsa" | "ssh";
  signingSignerId: string;
  signingPublicKey: string;
  signingPublicKeyPath: string;
  signingSshKeyPath: string;
  signingSshAuthSock: string;
  signingSshAllowedSigners: string;
  signingSshAllowedSignersPath: string;
  signingSshNamespace: string;
  showObsidianContextWarning: boolean;
  extractedSourcePreviewMode: "collapsed" | "expanded" | "hidden";
  showLanguageCapabilityMetadata: boolean;
  languageConfigurationVersion: number;
  enabledLanguagePacks: string[];
  enabledLanguages: string[];
  externalLanguagePacks: lotusExternalLanguagePack[];
  customLanguages: lotusCustomLanguage[];
  pdfExportMode: "both" | "code" | "output";
  htmlExportGraphAssetMode: lotusHtmlExportGraphAssetMode;
  loggingEnabled: boolean;
  loggingGlobalTextEnabled: boolean;
  loggingGlobalTextPath: string;
  loggingGlobalJsonlEnabled: boolean;
  loggingGlobalJsonlPath: string;
  loggingPerNoteTextEnabled: boolean;
  loggingPerNoteTextPathPattern: string;
  loggingPerNoteJsonlEnabled: boolean;
  loggingPerNoteJsonlPathPattern: string;
  loggingProcessEnabled: boolean;
  loggingProcessCommand: string;
  loggingHttpEnabled: boolean;
  loggingHttpEndpoint: string;
  loggingHttpHeaders: string;
  loggingViewerJsonlPath: string;
  loggingRedactionRules: string;
  loggingNotePathMode: "plain" | "hash" | "omit";
  loggingMachineHashScope: lotusLoggingMachineHashScope;
  loggingIncludeCode: boolean;
  loggingIncludeOutput: boolean;
  loggingIncludeInput: boolean;
  loggingMaxEventBytes: number;
  loggingMachineId: string;
  defaultContainerGroup: string;
  godboltResolveCompilerFromApi: boolean;
  godboltCompilerDefaults: string;
  godboltOptionsDefaults: string;
}

export interface lotusRunState {
  block: lotusCodeBlock;
  startedAt: number;
}

export interface lotusCustomLanguage {
  name: string;
  aliases: string;
  mode?: "execute" | "transpile";
  highlightLanguage?: string;
  targetLanguage?: string;
  executable: string;
  args: string;
  extension: string;
  outputMode?: "streams" | "file";
  outputExtension?: string;
  displayOutput?: lotusCustomLanguageDisplayOutput;
  displayMimeType?: string;
  displayTitle?: string;
  displayRole?: lotusDisplayRole;
  displayHeight?: number;
  packageDirectory?: string;
  preprocessors?: lotusCustomPreprocessor[];
  preprocessorExecutable?: string;
  preprocessorArgs?: string;
  preprocessorLanguage?: string;
  preprocessorExtension?: string;
  extractorMode?: "command" | "transpile-c";
  extractorExecutable?: string;
  extractorArgs?: string;
  transpileExecutable?: string;
  transpileArgs?: string;
}

export interface lotusCustomPreprocessor {
  name: string;
  executable: string;
  args: string;
  language?: string;
  extension?: string;
}

export interface lotusExternalLanguagePack {
  id: string;
  displayName: string;
  description: string;
  languages: lotusExternalLanguage[];
}

export interface lotusExternalLanguage extends lotusCustomLanguage {
  displayName: string;
  description?: string;
}
