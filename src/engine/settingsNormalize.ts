
import { getCompileMachineHashScopeOverride, isCompileContainerGroupAllowed, isCompileFeatureAllowed, isCompileLoggingForced } from "./buildProfile";
import { normalizeLanguageConfiguration } from "./languagePackages";
import { DEFAULT_SETTINGS } from "./defaultSettings";
import { isRecord } from "./utils/record";
import type { lotusHtmlExportGraphAssetMode, lotusPluginSettings } from "./types";

const SUPPORTED_PDF_EXPORT_MODES = new Set<lotusPluginSettings["pdfExportMode"]>(["both", "code", "output"]);

const SUPPORTED_HTML_EXPORT_GRAPH_ASSET_MODES = new Set<lotusHtmlExportGraphAssetMode>(["cdn", "self-contained"]);

const SUPPORTED_LOGGING_NOTE_PATH_MODES = new Set<lotusPluginSettings["loggingNotePathMode"]>(["plain", "hash", "omit"]);

const SUPPORTED_LOGGING_MACHINE_HASH_SCOPES = new Set<lotusPluginSettings["loggingMachineHashScope"]>(["install", "vault", "install-vault"]);

export function readStoredSettings(value: unknown): Partial<lotusPluginSettings> {
  return isRecord(value) ? value : {};
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : fallback;
}

function normalizeNonNegativeInteger(value: unknown, fallback: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

function normalizePort(value: unknown, fallback: number): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number.parseInt(value, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 && parsed <= 65535 ? Math.floor(parsed) : fallback;
}

function normalizeApiHost(value: unknown, fallback: string): string {
  if (typeof value !== "string") {
    return fallback;
  }
  const trimmed = value.trim();
  return /^(127\.0\.0\.1|localhost|::1)$/.test(trimmed) ? trimmed : fallback;
}

function normalizeStringSetting(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function normalizeBooleanSetting(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function normalizeMachineId(value: unknown): string {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^[A-Za-z0-9._:-]{16,160}$/.test(trimmed)) {
      return trimmed;
    }
  }
  return createMachineId();
}

function createMachineId(): string {
  const cryptoApi = typeof crypto === "undefined" ? undefined : crypto as { randomUUID?: () => string };
  return cryptoApi?.randomUUID?.() ?? `lotus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

export function normalizeSettings(settings: lotusPluginSettings): void {
  normalizeLanguageConfiguration(settings);
  settings.outputVisibleLines = normalizeNonNegativeInteger(settings.outputVisibleLines, DEFAULT_SETTINGS.outputVisibleLines, 2000);
  settings.defaultTimeoutMs = normalizePositiveInteger(settings.defaultTimeoutMs, DEFAULT_SETTINGS.defaultTimeoutMs);
  settings.hashCodeBlocks = settings.hashCodeBlocks ?? DEFAULT_SETTINGS.hashCodeBlocks;
  if (settings.signingMode !== "passphrase" && settings.signingMode !== "rsa" && settings.signingMode !== "ssh") {
    settings.signingMode = DEFAULT_SETTINGS.signingMode;
  }
  settings.signingSignerId = normalizeStringSetting(settings.signingSignerId, DEFAULT_SETTINGS.signingSignerId);
  settings.signingPublicKey = typeof settings.signingPublicKey === "string"
    ? settings.signingPublicKey
    : DEFAULT_SETTINGS.signingPublicKey;
  settings.signingPublicKeyPath = normalizeStringSetting(settings.signingPublicKeyPath, DEFAULT_SETTINGS.signingPublicKeyPath);
  settings.signingSshKeyPath = normalizeStringSetting(settings.signingSshKeyPath, DEFAULT_SETTINGS.signingSshKeyPath);
  settings.signingSshAuthSock = normalizeStringSetting(settings.signingSshAuthSock, DEFAULT_SETTINGS.signingSshAuthSock);
  settings.signingSshAllowedSigners = typeof settings.signingSshAllowedSigners === "string"
    ? settings.signingSshAllowedSigners
    : DEFAULT_SETTINGS.signingSshAllowedSigners;
  settings.signingSshAllowedSignersPath = normalizeStringSetting(settings.signingSshAllowedSignersPath, DEFAULT_SETTINGS.signingSshAllowedSignersPath);
  settings.signingSshNamespace = normalizeStringSetting(settings.signingSshNamespace, DEFAULT_SETTINGS.signingSshNamespace);
  settings.showObsidianContextWarning = settings.showObsidianContextWarning ?? DEFAULT_SETTINGS.showObsidianContextWarning;
  if (!SUPPORTED_PDF_EXPORT_MODES.has(settings.pdfExportMode)) {
    settings.pdfExportMode = DEFAULT_SETTINGS.pdfExportMode;
  }
  if (!SUPPORTED_HTML_EXPORT_GRAPH_ASSET_MODES.has(settings.htmlExportGraphAssetMode)) {
    settings.htmlExportGraphAssetMode = DEFAULT_SETTINGS.htmlExportGraphAssetMode;
  }
  settings.loggingEnabled = isCompileLoggingForced() || Boolean(settings.loggingEnabled);
  settings.loggingGlobalTextEnabled = settings.loggingGlobalTextEnabled == null
    ? DEFAULT_SETTINGS.loggingGlobalTextEnabled
    : Boolean(settings.loggingGlobalTextEnabled);
  settings.loggingGlobalJsonlEnabled = settings.loggingGlobalJsonlEnabled == null
    ? DEFAULT_SETTINGS.loggingGlobalJsonlEnabled
    : Boolean(settings.loggingGlobalJsonlEnabled);
  settings.loggingPerNoteTextEnabled = Boolean(settings.loggingPerNoteTextEnabled);
  settings.loggingPerNoteJsonlEnabled = Boolean(settings.loggingPerNoteJsonlEnabled);
  settings.loggingProcessEnabled = Boolean(settings.loggingProcessEnabled);
  settings.loggingHttpEnabled = Boolean(settings.loggingHttpEnabled);
  settings.loggingIncludeCode = Boolean(settings.loggingIncludeCode);
  settings.loggingIncludeOutput = Boolean(settings.loggingIncludeOutput);
  settings.loggingIncludeInput = Boolean(settings.loggingIncludeInput);
  settings.loggingMachineId = normalizeMachineId(settings.loggingMachineId);
  settings.loggingGlobalTextPath = normalizeStringSetting(settings.loggingGlobalTextPath, DEFAULT_SETTINGS.loggingGlobalTextPath);
  settings.loggingGlobalJsonlPath = normalizeStringSetting(settings.loggingGlobalJsonlPath, DEFAULT_SETTINGS.loggingGlobalJsonlPath);
  settings.loggingPerNoteTextPathPattern = normalizeStringSetting(settings.loggingPerNoteTextPathPattern, DEFAULT_SETTINGS.loggingPerNoteTextPathPattern);
  settings.loggingPerNoteJsonlPathPattern = normalizeStringSetting(settings.loggingPerNoteJsonlPathPattern, DEFAULT_SETTINGS.loggingPerNoteJsonlPathPattern);
  settings.loggingProcessCommand = normalizeStringSetting(settings.loggingProcessCommand, DEFAULT_SETTINGS.loggingProcessCommand);
  settings.loggingHttpEndpoint = normalizeStringSetting(settings.loggingHttpEndpoint, DEFAULT_SETTINGS.loggingHttpEndpoint);
  settings.loggingHttpHeaders = normalizeStringSetting(settings.loggingHttpHeaders, DEFAULT_SETTINGS.loggingHttpHeaders);
  settings.loggingViewerJsonlPath = normalizeStringSetting(settings.loggingViewerJsonlPath, settings.loggingGlobalJsonlPath || DEFAULT_SETTINGS.loggingViewerJsonlPath);
  settings.loggingRedactionRules = typeof settings.loggingRedactionRules === "string"
    ? settings.loggingRedactionRules
    : DEFAULT_SETTINGS.loggingRedactionRules;
  if (!SUPPORTED_LOGGING_NOTE_PATH_MODES.has(settings.loggingNotePathMode)) {
    settings.loggingNotePathMode = DEFAULT_SETTINGS.loggingNotePathMode;
  }
  const compileMachineHashScope = getCompileMachineHashScopeOverride();
  if (compileMachineHashScope) {
    settings.loggingMachineHashScope = compileMachineHashScope;
  } else if (!SUPPORTED_LOGGING_MACHINE_HASH_SCOPES.has(settings.loggingMachineHashScope)) {
    settings.loggingMachineHashScope = DEFAULT_SETTINGS.loggingMachineHashScope;
  }
  settings.loggingMaxEventBytes = normalizePositiveInteger(settings.loggingMaxEventBytes, DEFAULT_SETTINGS.loggingMaxEventBytes);
  settings.apiEnabled = Boolean(settings.apiEnabled);
  settings.apiHost = normalizeApiHost(settings.apiHost, DEFAULT_SETTINGS.apiHost);
  settings.apiPort = normalizePort(settings.apiPort, DEFAULT_SETTINGS.apiPort);
  settings.apiKeys = typeof settings.apiKeys === "string" ? settings.apiKeys : DEFAULT_SETTINGS.apiKeys;
  settings.defaultContainerGroup = isCompileFeatureAllowed("container-groups")
    ? normalizeStringSetting(settings.defaultContainerGroup, DEFAULT_SETTINGS.defaultContainerGroup)
    : "";
  if (settings.defaultContainerGroup && !isCompileContainerGroupAllowed(settings.defaultContainerGroup)) {
    settings.defaultContainerGroup = "";
  }
  settings.godboltResolveCompilerFromApi = normalizeBooleanSetting(settings.godboltResolveCompilerFromApi, DEFAULT_SETTINGS.godboltResolveCompilerFromApi);
  settings.godboltCompilerDefaults = normalizeStringSetting(settings.godboltCompilerDefaults, DEFAULT_SETTINGS.godboltCompilerDefaults);
  settings.godboltOptionsDefaults = normalizeStringSetting(settings.godboltOptionsDefaults, DEFAULT_SETTINGS.godboltOptionsDefaults);
  settings.workingDirectory = normalizeStringSetting(settings.workingDirectory, DEFAULT_SETTINGS.workingDirectory);
  settings.graphvizExecutable = isCompileFeatureAllowed("rich-displays")
    ? normalizeStringSetting(settings.graphvizExecutable, DEFAULT_SETTINGS.graphvizExecutable)
    : "";
  settings.showCodeVisualizationButton = isCompileFeatureAllowed("rich-displays")
    ? normalizeBooleanSetting(settings.showCodeVisualizationButton, DEFAULT_SETTINGS.showCodeVisualizationButton)
    : false;
}
