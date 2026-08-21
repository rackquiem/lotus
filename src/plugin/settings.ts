import { App, Modal, Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type lotusPlugin from "./main";
import {
  getCompileContainerRuntimes,
  getCompileMachineHashScopeOverride,
  getCompileProfileSummary,
  hasCompileContainerGroupSelection,
  isCompileContainerGroupAllowed,
  isCompileCustomLanguagesAllowed,
  isCompileExternalLanguagePacksAllowed,
  isCompileFeatureAllowed,
  isCompileLoggingForced,
  isLightCompileMode,
  type lotusCompileContainerRuntime,
} from "../engine/buildProfile";
import { CUSTOM_LANGUAGE_PACKAGE_ID, getAvailableLanguagePackages, getDefaultLanguageIds, getDefaultLanguagePackIds, isLanguageEnabled, normalizeLanguageConfiguration } from "../engine/languagePackages";
import { sha256Hash } from "../engine/utils/hash";
import type { lotusCustomLanguage, lotusCustomPreprocessor, lotusPluginSettings } from "../engine/types";

export { DEFAULT_SETTINGS } from "../engine/defaultSettings";

type lotusCustomLanguageTextKey = Exclude<keyof lotusCustomLanguage, "displayHeight" | "displayOutput" | "displayRole" | "extractorMode" | "mode" | "outputMode" | "packageDirectory" | "preprocessors">;
type lotusCustomPreprocessorTextKey = keyof lotusCustomPreprocessor;
type lotusContainerEditorRuntime = lotusCompileContainerRuntime;
type lotusRemoteUploadMode = "inline" | "scp";

interface lotusContainerEditorElevation {
  mode?: "default" | "root";
  commandPrefix?: string;
  [key: string]: unknown;
}

interface lotusContainerEditorRemoteConfig {
  target?: string;
  sshTarget?: string;
  workspace?: string;
  remoteWorkspace?: string;
  sshExecutable?: string;
  sshArgs?: string;
  sshAuthSock?: string;
  authSock?: string;
  sshAgentSocket?: string;
  scpExecutable?: string;
  scpArgs?: string;
  uploadMode?: lotusRemoteUploadMode;
  cleanupRemoteFile?: boolean;
  mkdirCommand?: string;
  cleanupCommand?: string;
  healthCheck?: lotusContainerEditorHealthCheck;
  [key: string]: unknown;
}

interface lotusContainerEditorHealthCheck {
  command?: string;
  [key: string]: unknown;
}

interface lotusContainerEditorWslConfig {
  interactive?: boolean;
  [key: string]: unknown;
}

interface lotusContainerEditorPersistentConfig {
  enabled?: boolean;
  name?: string;
  keepAliveCommand?: string;
  [key: string]: unknown;
}

interface lotusContainerEditorCustomConfig {
  executable?: string;
  args?: string;
  [key: string]: unknown;
}

interface lotusContainerEditorHttpConfig {
  url?: string;
  endpoint?: string;
  method?: string;
  contentType?: string;
  headers?: Record<string, string>;
  body?: unknown;
  responseMode?: "auto" | "json" | "text";
  successStatus?: number | string | Array<number | string>;
  successStatuses?: number | string | Array<number | string>;
  stdoutPath?: string;
  stdout?: string;
  outputPath?: string;
  output?: string;
  stderrPath?: string;
  stderr?: string;
  exitCodePath?: string;
  exitCode?: string;
  successPath?: string;
  success?: string;
  [key: string]: unknown;
}

interface lotusContainerEditorOutputFilters {
  stripAnsi?: boolean;
  stdoutStart?: string;
  stdoutEnd?: string;
  stderrStart?: string;
  stderrEnd?: string;
  stripStdout?: string | string[];
  stripStderr?: string | string[];
  [key: string]: unknown;
}

interface lotusContainerEditorLanguageConfig {
  command?: string;
  extension?: string;
  useDefault?: boolean;
  [key: string]: unknown;
}

interface lotusContainerEditorConfig {
  runtime?: lotusContainerEditorRuntime;
  image?: string;
  persistent?: boolean | lotusContainerEditorPersistentConfig;
  elevation?: lotusContainerEditorElevation;
  wsl?: lotusContainerEditorWslConfig;
  ssh?: lotusContainerEditorRemoteConfig;
  remote?: lotusContainerEditorRemoteConfig;
  qemu?: lotusContainerEditorRemoteConfig;
  custom?: lotusContainerEditorCustomConfig;
  http?: lotusContainerEditorHttpConfig;
  outputFilters?: lotusContainerEditorOutputFilters;
  languages?: Record<string, lotusContainerEditorLanguageConfig>;
  [key: string]: unknown;
}

export class lotusSettingTab extends PluginSettingTab {
  private readonly languagePackageOpenState = new Map<string, boolean>();
  private readonly settingsSectionOpenState = new Map<string, boolean>();

  constructor(private readonly lotusPlugin: lotusPlugin) {
    super(lotusPlugin.app, lotusPlugin);
  }

  display(): void {
    this.renderSettings();
  }

  private renderSettings(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("p", { text: "Run supported code fences directly from notes while preserving native syntax highlighting." });

    this.renderGeneralSettings(this.createSection(containerEl, "General", true));
    this.renderApiSettings(this.createSection(containerEl, "Local API"));
    this.renderHashingAndObservabilitySettings(this.createSection(containerEl, "Hashing and observability"));
    this.renderLoggingSettings(this.createSection(containerEl, "Logging"));
    this.renderLanguagePackages(this.createSection(containerEl, "Language packages"));
    this.renderBuiltInRuntimes(this.createSection(containerEl, "Built-in runtimes"));
    if (isCompileCustomLanguagesAllowed()) {
      this.renderCustomLanguages(this.createSection(containerEl, "Custom languages"));
    }
    if (isCompileFeatureAllowed("container-groups")) {
      void this.renderContainerGroups(this.createSection(containerEl, "Execution groups"));
    }
  }

  private createSection(containerEl: HTMLElement, title: string, open = false): HTMLElement {
    const details = containerEl.createEl("details", { cls: "lotus-settings-section" });
    details.open = this.settingsSectionOpenState.get(title) ?? open;
    details.addEventListener("toggle", () => {
      this.settingsSectionOpenState.set(title, details.open);
    });
    details.createEl("summary", { text: title, cls: "lotus-settings-summary" });
    return details.createDiv({ cls: "lotus-settings-section-body" });
  }

  private renderGeneralSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Compile profile")
      .setDesc(isLightCompileMode()
        ? `This build was compiled with ${getCompileProfileSummary()}.`
        : "Strict build. All Lotus feature surfaces are available unless disabled in vault settings.");

    new Setting(containerEl)
      .setName("Enable local execution")
      .setDesc("Disabled by default. Lotus runs code on your local machine and does not provide sandboxing.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.enableLocalExecution).onChange(async (value) => {
          this.lotusPlugin.settings.enableLocalExecution = value;
          if (value) {
            this.lotusPlugin.settings.hasAcknowledgedExecutionRisk = true;
          }
          await this.lotusPlugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Keep Lotus notes in source mode")
      .setDesc("Preserve raw fenced code in the editor instead of letting live preview collapse research snippets.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.preserveSourceMode).onChange(async (value) => {
          this.lotusPlugin.settings.preserveSourceMode = value;
          await this.lotusPlugin.saveSettings();
          if (value) {
            void this.lotusPlugin.enforceSourceModeForActiveView();
          } else {
            void this.lotusPlugin.disableSourceModeForActiveView();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Default timeout")
      .setDesc("Maximum execution time in milliseconds before Lotus terminates the process. Set a note or block timeout to infinite to disable it for that run.")
      .addText((text) =>
        text.setPlaceholder("8000").setValue(String(this.lotusPlugin.settings.defaultTimeoutMs)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            this.lotusPlugin.settings.defaultTimeoutMs = parsed;
            await this.lotusPlugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Working directory")
      .setDesc("Empty uses the current note folder when possible. Use a single dot for the vault root, or a relative path from the vault root.")
      .addText((text) =>
        text.setPlaceholder(".").setValue(this.lotusPlugin.settings.workingDirectory).onChange(async (value) => {
          this.lotusPlugin.settings.workingDirectory = value.trim() ? normalizePath(value.trim()) : "";
          await this.lotusPlugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Write output back to note")
      .setDesc("Insert managed Lotus output sections beneath code blocks instead of keeping results purely in the UI.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.writeOutputToNote).onChange(async (value) => {
          this.lotusPlugin.settings.writeOutputToNote = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Visible output lines")
      .setDesc("Limit each stdout, stderr, and warning panel to this many visible lines. Use 0 for unlimited output.")
      .addText((text) =>
        text.setPlaceholder("0").setValue(String(this.lotusPlugin.settings.outputVisibleLines ?? 0)).onChange(async (value) => {
          const parsed = Number.parseInt(value.trim(), 10);
          if (!Number.isNaN(parsed) && parsed >= 0) {
            this.lotusPlugin.settings.outputVisibleLines = Math.min(parsed, 2000);
            await this.lotusPlugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("Auto-run on file open")
      .setDesc("Run all supported blocks in the active note when it opens. Disabled by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.autoRunOnFileOpen).onChange(async (value) => {
          this.lotusPlugin.settings.autoRunOnFileOpen = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    if (isCompileFeatureAllowed("rich-displays")) {
      new Setting(containerEl)
        .setName("Show code graph button")
        .setDesc("Show the toolbar button that visualizes a block's source as a graph. Disable this if you only want the normal run button.")
        .addToggle((toggle) =>
          toggle.setValue(this.lotusPlugin.settings.showCodeVisualizationButton ?? true).onChange(async (value) => {
            this.lotusPlugin.settings.showCodeVisualizationButton = value;
            await this.lotusPlugin.saveSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName("Show Obsidian context warning")
      .setDesc('Show "no but seriously, you are risking your life" when Obsidian-js blocks run.')
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.showObsidianContextWarning ?? true).onChange(async (value) => {
          this.lotusPlugin.settings.showObsidianContextWarning = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Extracted source preview")
      .setDesc("Choose how Lotus shows the materialized source for blocks that use Lotus-file.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("collapsed", "Collapsed")
          .addOption("expanded", "Expanded")
          .addOption("hidden", "Hidden")
          .setValue(this.lotusPlugin.settings.extractedSourcePreviewMode || "collapsed")
          .onChange(async (value) => {
            this.lotusPlugin.settings.extractedSourcePreviewMode = value as "collapsed" | "expanded" | "hidden";
            await this.lotusPlugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Show capability metadata")
      .setDesc("Show symbol, dependency, and harness capability metadata in extracted source preview headers.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.showLanguageCapabilityMetadata ?? true).onChange(async (value) => {
          this.lotusPlugin.settings.showLanguageCapabilityMetadata = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("PDF export mode")
      .setDesc("Choose what to include when exporting notes containing Lotus code blocks to PDF.")
      .addDropdown((dropdown) =>
        dropdown
            .addOption("code", "Code block only")
            .addOption("both", "Both code and output")
            .addOption("output", "Output only")
          .setValue(this.lotusPlugin.settings.pdfExportMode || "code")
          .onChange(async (value) => {
            this.lotusPlugin.settings.pdfExportMode = value as "both" | "code" | "output";
            await this.lotusPlugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("HTML graph export assets")
      .setDesc("Choose whether Plotly and D3 HTML exports load chart libraries from a CDN or render self-contained SVG fallbacks.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("cdn", "CDN libraries")
          .addOption("self-contained", "Self-contained SVG")
          .setValue(this.lotusPlugin.settings.htmlExportGraphAssetMode || "cdn")
          .onChange(async (value) => {
            this.lotusPlugin.settings.htmlExportGraphAssetMode = value as "cdn" | "self-contained";
            await this.lotusPlugin.saveSettings();
          }),
      );
  }

  private renderHashingAndObservabilitySettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Write code block hashes to frontmatter")
      .setDesc("Maintain Lotus-code-block-hashes in note frontmatter when hashing notes or running blocks.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.hashCodeBlocks ?? false).onChange(async (value) => {
          this.lotusPlugin.settings.hashCodeBlocks = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    if (!isCompileFeatureAllowed("signing")) {
      new Setting(containerEl)
        .setName("Cryptographic signing")
        .setDesc("This light build was compiled without the signing feature.");
      return;
    }

    new Setting(containerEl)
      .setName("Signature method")
      .setDesc("Passphrase creates password-derived hmac signatures. RSA uses pem keys. OpenSSH can sign through SSH-agent and verify pinned public keys.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("passphrase", "Passphrase")
          .addOption("rsa", "RSA-PSS")
          .addOption("ssh", "OpenSSH / SSH-agent")
          .setValue(this.lotusPlugin.settings.signingMode || "passphrase")
          .onChange((value) => {
            this.lotusPlugin.settings.signingMode = value as "passphrase" | "rsa" | "ssh";
            void this.lotusPlugin.saveSettings().then(() => this.renderSettings());
          }),
      );

    this.addTextSetting(containerEl, "Signer identity", "Optional label stored with signatures. Example: team, analyst, or key owner.", "signingSignerId");

    if (this.lotusPlugin.settings.signingMode === "rsa") {
      this.addTextSetting(containerEl, "RSA public key file", "Vault-relative or absolute PEM file used for verification.", "signingPublicKeyPath");
      new Setting(containerEl)
        .setName("RSA public key")
        .setDesc("Optional pasted pem public key. Used when no public key file is configured.")
        .addTextArea((text) => {
          text.setValue(this.lotusPlugin.settings.signingPublicKey).onChange(async (value) => {
            this.lotusPlugin.settings.signingPublicKey = value;
            await this.lotusPlugin.saveSettings();
          });
          text.inputEl.rows = 5;
          text.inputEl.setCssStyles({
            fontFamily: "monospace",
            width: "100%",
          });
        });
    }
    if (this.lotusPlugin.settings.signingMode === "ssh") {
      this.addTextSetting(containerEl, "OpenSSH signing key file", "Private key file, or public key file when the private half is available in ssh-agent.", "signingSshKeyPath");
      this.addTextSetting(containerEl, "SSH agent socket", "Optional SSH_AUTH_SOCK override for signing with an agent.", "signingSshAuthSock");
      this.addTextSetting(containerEl, "OpenSSH namespace", "Domain-separated signature namespace. This prevents signatures from being accepted for another protocol.", "signingSshNamespace");
      this.addTextSetting(containerEl, "Allowed signers file", "Vault-relative or absolute allowed_signers file used for verification.", "signingSshAllowedSignersPath");
      new Setting(containerEl)
        .setName("Allowed signers")
        .setDesc("Optional pasted OpenSSH allowed_signers content. Used when no allowed signers file is configured.")
        .addTextArea((text) => {
          text.setValue(this.lotusPlugin.settings.signingSshAllowedSigners).onChange(async (value) => {
            this.lotusPlugin.settings.signingSshAllowedSigners = value;
            await this.lotusPlugin.saveSettings();
          });
          text.inputEl.rows = 5;
          text.inputEl.setCssStyles({
            fontFamily: "monospace",
            width: "100%",
          });
        });
    }
  }

  private renderApiSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Enable local API")
      .setDesc("Expose a signed local API for trusted command-line tools. Keep this bound to localhost unless you fully control the network.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.apiEnabled).onChange(async (value) => {
          this.lotusPlugin.settings.apiEnabled = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    this.addTextSetting(containerEl, "API host", "Bind address. Use 127.0.0.1 for local-only access.", "apiHost");

    new Setting(containerEl)
      .setName("API port")
      .setDesc("Port for the local API.")
      .addText((text) =>
        text.setPlaceholder("27188").setValue(String(this.lotusPlugin.settings.apiPort)).onChange(async (value) => {
          const parsed = Number.parseInt(value.trim(), 10);
          if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 65535) {
            this.lotusPlugin.settings.apiPort = parsed;
            await this.lotusPlugin.saveSettings();
          }
        }),
      );

    new Setting(containerEl)
      .setName("API keys")
      .setDesc("One key per line as key-id:secret, or a JSON array of {\"id\":\"...\",\"secret\":\"...\"}. Requests must include HMAC signature headers.")
      .addTextArea((text) => {
        text.setValue(this.lotusPlugin.settings.apiKeys).onChange(async (value) => {
          this.lotusPlugin.settings.apiKeys = value;
          await this.lotusPlugin.saveSettings();
        });
        text.inputEl.rows = 5;
        text.inputEl.setCssStyles({
          fontFamily: "monospace",
          width: "100%",
        });
      });
  }

  private renderLoggingSettings(containerEl: HTMLElement): void {
    const loggingForced = isCompileLoggingForced();
    const machineHashScopeOverride = getCompileMachineHashScopeOverride();

    new Setting(containerEl)
      .setName("Enable logging")
      .setDesc(loggingForced
        ? "Logging is forced on by this compile profile."
        : "Write Lotus execution, note modification, reproducibility, and settings events to configured sinks.")
      .addToggle((toggle) =>
        toggle.setDisabled(loggingForced).setValue(this.lotusPlugin.settings.loggingEnabled).onChange(async (value) => {
          this.lotusPlugin.settings.loggingEnabled = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Machine hash")
      .setDesc(`Stable identifier emitted in logs: ${formatMachineHashPreview(this.lotusPlugin.settings, this.app.vault.getName())}`);

    new Setting(containerEl)
      .setName("Machine hash scope")
      .setDesc(machineHashScopeOverride
        ? "This compile profile fixes what contributes to the machine hash."
        : "Choose what contributes to the logged machine hash without reading OS identity data.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("install", "Install id")
          .addOption("vault", "Vault name")
          .addOption("install-vault", "Install id and vault name")
          .setDisabled(machineHashScopeOverride !== null)
          .setValue(this.lotusPlugin.settings.loggingMachineHashScope)
          .onChange(async (value) => {
            this.lotusPlugin.settings.loggingMachineHashScope = value as lotusPluginSettings["loggingMachineHashScope"];
            await this.lotusPlugin.saveSettings();
            this.renderSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Machine hash seed")
      .setDesc("Stored install identifier used when the machine hash scope includes the install id.")
      .addText((text) =>
        text.setValue(this.lotusPlugin.settings.loggingMachineId).onChange(async (value) => {
          this.lotusPlugin.settings.loggingMachineId = value.trim();
          await this.lotusPlugin.saveSettings();
          this.renderSettings();
        }),
      )
      .addButton((button) =>
        button.setButtonText("Regenerate").onClick(async () => {
          this.lotusPlugin.settings.loggingMachineId = createMachineIdSeed();
          await this.lotusPlugin.saveSettings();
          this.renderSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Global text log")
      .setDesc("Append human-readable events to a vault-relative text file.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingGlobalTextEnabled).onChange(async (value) => {
          this.lotusPlugin.settings.loggingGlobalTextEnabled = value;
          await this.lotusPlugin.saveSettings();
        }),
      );
    this.addTextSetting(containerEl, "Global text log path", "Vault-relative path for the text log.", "loggingGlobalTextPath");

    new Setting(containerEl)
      .setName("Global jsonl log")
      .setDesc("Append structured JSON lines events to a vault-relative file.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingGlobalJsonlEnabled).onChange(async (value) => {
          this.lotusPlugin.settings.loggingGlobalJsonlEnabled = value;
          await this.lotusPlugin.saveSettings();
        }),
      );
    this.addTextSetting(containerEl, "Global JSONL log path", "Vault-relative path for structured logs.", "loggingGlobalJsonlPath");

    new Setting(containerEl)
      .setName("Per-note text logs")
      .setDesc("Append human-readable events to a per-note log. Pattern supports {note} and {hash}.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingPerNoteTextEnabled).onChange(async (value) => {
          this.lotusPlugin.settings.loggingPerNoteTextEnabled = value;
          await this.lotusPlugin.saveSettings();
        }),
      );
    this.addTextSetting(containerEl, "Per-note text path pattern", "Example: .lotus/logs/notes/{note}.log", "loggingPerNoteTextPathPattern");

    new Setting(containerEl)
      .setName("Per-note jsonl logs")
      .setDesc("Append structured events to a per-note log. Pattern supports {note} and {hash}.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingPerNoteJsonlEnabled).onChange(async (value) => {
          this.lotusPlugin.settings.loggingPerNoteJsonlEnabled = value;
          await this.lotusPlugin.saveSettings();
        }),
      );
    this.addTextSetting(containerEl, "Per-note JSONL path pattern", "Example: .lotus/logs/notes/{note}.jsonl", "loggingPerNoteJsonlPathPattern");

    new Setting(containerEl)
      .setName("Local process sink")
      .setDesc("Start a local command and stream jsonl events to its stdin.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingProcessEnabled).onChange(async (value) => {
          this.lotusPlugin.settings.loggingProcessEnabled = value;
          await this.lotusPlugin.saveSettings();
        }),
      );
    this.addTextSetting(containerEl, "Local process command", "Example: /usr/local/bin/lotus-log-agent --stdin-jsonl", "loggingProcessCommand");

    new Setting(containerEl)
      .setName("Http remote sink")
      .setDesc("Post each structured event as JSON to a remote endpoint.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingHttpEnabled).onChange(async (value) => {
          this.lotusPlugin.settings.loggingHttpEnabled = value;
          await this.lotusPlugin.saveSettings();
        }),
      );
    this.addTextSetting(containerEl, "HTTP endpoint", "Example: https://collector.example.com/lotus/events", "loggingHttpEndpoint");
    this.addTextSetting(containerEl, "HTTP headers JSON", "Optional JSON object of string headers.", "loggingHttpHeaders");
    this.addTextSetting(containerEl, "Log viewer JSONL path", "Vault-relative JSONL file opened by the Lotus log viewer.", "loggingViewerJsonlPath");

    new Setting(containerEl)
      .setName("Redaction rules")
      .setDesc("One rule per line. Use plain text or /regex/flags, optionally followed by => replacement.")
      .addTextArea((text) => {
        text.setValue(this.lotusPlugin.settings.loggingRedactionRules).onChange(async (value) => {
          this.lotusPlugin.settings.loggingRedactionRules = value;
          await this.lotusPlugin.saveSettings();
        });
        text.inputEl.rows = 5;
        text.inputEl.setCssStyles({
          fontFamily: "monospace",
          width: "100%",
        });
      });

    new Setting(containerEl)
      .setName("Note path in logs")
      .setDesc("Hash paths by default to reduce accidental disclosure.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("hash", "Hash")
          .addOption("plain", "Plain")
          .addOption("omit", "Omit")
          .setValue(this.lotusPlugin.settings.loggingNotePathMode)
          .onChange(async (value) => {
            this.lotusPlugin.settings.loggingNotePathMode = value as "plain" | "hash" | "omit";
            await this.lotusPlugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Include code")
      .setDesc("Include code block source in structured events. Disabled by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingIncludeCode).onChange(async (value) => {
          this.lotusPlugin.settings.loggingIncludeCode = value;
          await this.lotusPlugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Include stdin/function input")
      .setDesc("Include runtime input in structured events. Disabled by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingIncludeInput).onChange(async (value) => {
          this.lotusPlugin.settings.loggingIncludeInput = value;
          await this.lotusPlugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName("Include output streams")
      .setDesc("Include stdout, stderr, and warnings in structured events. Disabled by default.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.loggingIncludeOutput).onChange(async (value) => {
          this.lotusPlugin.settings.loggingIncludeOutput = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName("Max event bytes")
      .setDesc("Large structured events are truncated to metadata when they exceed this size.")
      .addText((text) =>
        text.setValue(String(this.lotusPlugin.settings.loggingMaxEventBytes)).onChange(async (value) => {
          const parsed = Number.parseInt(value.trim(), 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            this.lotusPlugin.settings.loggingMaxEventBytes = parsed;
            await this.lotusPlugin.saveSettings();
          }
        }),
      );
  }

  private renderBuiltInRuntimes(containerEl: HTMLElement): void {
    if (this.isRuntimeLanguageEnabled("python")) {
      this.addTextSetting(containerEl, "Python executable", "Path or command name for Python.", "pythonExecutable");
    }
    if (this.isRuntimeLanguageEnabled("javascript")) {
      this.addTextSetting(containerEl, "Node executable", "Path or command name for JavaScript execution.", "nodeExecutable");
    }

    if (this.isRuntimeLanguageEnabled("typescript")) {
      new Setting(containerEl)
        .setName("Typescript runner mode")
        .setDesc("Use ts-node or tsx for typescript blocks.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("ts-node", "Ts-node")
            .addOption("tsx", "Tsx")
            .setValue(this.lotusPlugin.settings.typescriptMode)
            .onChange(async (value) => {
              this.lotusPlugin.settings.typescriptMode = value as "ts-node" | "tsx";
              await this.lotusPlugin.saveSettings();
            }),
        );

      this.addTextSetting(containerEl, "TypeScript transpiler executable", "Command or path for ts-node or tsx.", "typescriptTranspilerExecutable");
    }

    if (this.isRuntimeLanguageEnabled("ocaml")) {
      new Setting(containerEl)
        .setName("OCaml mode")
        .setDesc("Choose between the OCaml toplevel, ocamlc compilation, or dune exec.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("ocaml", "OCaml")
            .addOption("ocamlc", "Ocamlc")
            .addOption("dune", "Dune")
            .setValue(this.lotusPlugin.settings.ocamlMode)
            .onChange(async (value) => {
              this.lotusPlugin.settings.ocamlMode = value as "ocaml" | "ocamlc" | "dune";
              await this.lotusPlugin.saveSettings();
            }),
        );

      this.addTextSetting(containerEl, "OCaml executable", "Command or path for ocaml, ocamlc, or dune depending on the selected mode.", "ocamlExecutable");
    }

    this.addRuntimeTextSetting(containerEl, ["c"], "C compiler", "Command or path for compiling C blocks.", "cExecutable");
    this.addRuntimeTextSetting(containerEl, ["cpp"], "C++ compiler", "Command or path for compiling C++ blocks.", "cppExecutable");
    this.addRuntimeTextSetting(containerEl, ["shell"], "Shell executable", "Command or path for Shell, Bash, and sh blocks.", "shellExecutable");
    this.addRuntimeTextSetting(containerEl, ["ruby"], "Ruby executable", "Command or path for Ruby blocks.", "rubyExecutable");
    this.addRuntimeTextSetting(containerEl, ["perl"], "Perl executable", "Command or path for Perl blocks.", "perlExecutable");
    this.addRuntimeTextSetting(containerEl, ["lua"], "Lua executable", "Command or path for Lua blocks.", "luaExecutable");
    this.addRuntimeTextSetting(containerEl, ["php"], "PHP executable", "Command or path for PHP blocks.", "phpExecutable");
    this.addRuntimeTextSetting(containerEl, ["go"], "Go executable", "Command or path for Go blocks.", "goExecutable");
    this.addRuntimeTextSetting(containerEl, ["rust"], "Rust compiler", "Command or path for compiling Rust blocks.", "rustExecutable");
    this.addRuntimeTextSetting(containerEl, ["haskell"], "Haskell executable", "Command or path for Haskell blocks. Defaults to runghc.", "haskellExecutable");
    if (this.isRuntimeLanguageEnabled("java")) {
      this.addTextSetting(containerEl, "Java compiler", "Optional command or path for javac. Leave empty to use Java source-file mode.", "javaCompilerExecutable");
      this.addTextSetting(containerEl, "Java executable", "Command or path for running compiled Java blocks.", "javaExecutable");
    }
    this.addRuntimeTextSetting(containerEl, ["llvm-ir"], "LLVM IR interpreter", "Command or path for running LLVM IR blocks with lli.", "llvmInterpreterExecutable");
    if (this.isRuntimeLanguageEnabled("ebpf-c")) {
      this.addTextSetting(containerEl, "eBPF clang executable", "Command or path for clang with BPF target support.", "ebpfClangExecutable");
      this.addTextSetting(containerEl, "eBPF bpftool executable", "Command or path for bpftool verifier and load operations.", "ebpfBpftoolExecutable");
      this.addTextSetting(containerEl, "eBPF object inspector", "Command or path for llvm-objdump. Leave empty to skip object section inspection.", "ebpfLlvmObjdumpExecutable");
      this.addTextSetting(containerEl, "eBPF include paths", "Comma-separated include directories passed to clang with -I.", "ebpfIncludePaths");
      new Setting(containerEl)
        .setName("Allow eBPF kernel load")
        .setDesc("Required before any block can use Lotus-eBPF-mode=load. Compile-only mode stays available without this.")
        .addToggle((toggle) =>
          toggle.setValue(this.lotusPlugin.settings.ebpfAllowKernelLoad).onChange(async (value) => {
            this.lotusPlugin.settings.ebpfAllowKernelLoad = value;
            await this.lotusPlugin.saveSettings();
          }),
        );
    }
    this.addRuntimeTextSetting(containerEl, ["bpftrace"], "bpftrace executable", "Command or path for bpftrace scripts.", "bpftraceExecutable");
    this.addRuntimeTextSetting(containerEl, ["lean"], "Lean executable", "Command or path for checking Lean blocks.", "leanExecutable");
    this.addRuntimeTextSetting(containerEl, ["coq"], "Coq executable", "Command or path for checking Coq blocks with coqc.", "coqExecutable");
    this.addRuntimeTextSetting(containerEl, ["smtlib"], "SMT solver", "Command or path for SMT-LIB blocks. Defaults to z3.", "smtExecutable");
    if (isCompileFeatureAllowed("rich-displays")) {
      this.addTextSetting(containerEl, "Graphviz executable", "Command or path for dot. Lotus uses this to turn Graphviz DOT display outputs into SVG.", "graphvizExecutable");
    }
  }

  private addRuntimeTextSetting<K extends keyof lotusPluginSettings>(containerEl: HTMLElement, languageIds: string[], name: string, description: string, key: K): void {
    if (languageIds.some((languageId) => this.isRuntimeLanguageEnabled(languageId))) {
      this.addTextSetting(containerEl, name, description, key);
    }
  }

  private isRuntimeLanguageEnabled(languageId: string): boolean {
    return isLanguageEnabled(languageId, this.lotusPlugin.settings);
  }

  private renderLanguagePackages(containerEl: HTMLElement): void {
    normalizeLanguageConfiguration(this.lotusPlugin.settings);

    for (const pack of getAvailableLanguagePackages(this.lotusPlugin.settings)) {
      const packEl = containerEl.createEl("details", { cls: "lotus-language-package" });
      packEl.open = this.languagePackageOpenState.get(pack.id) ?? this.lotusPlugin.settings.enabledLanguagePacks.includes(pack.id);
      packEl.addEventListener("toggle", () => {
        this.languagePackageOpenState.set(pack.id, packEl.open);
      });
      packEl.createEl("summary", { text: pack.displayName });
      packEl.createEl("p", { text: pack.description, cls: "setting-item-description" });

      new Setting(packEl)
        .setName("Enable package")
        .setDesc("Disable this to remove the package languages from parsing, command menus, and runners for this vault.")
        .addToggle((toggle) =>
          toggle.setValue(this.lotusPlugin.settings.enabledLanguagePacks.includes(pack.id)).onChange(async (value) => {
            this.setEnabledValue(this.lotusPlugin.settings.enabledLanguagePacks, pack.id, value);
            for (const language of pack.languages) {
              this.setEnabledValue(this.lotusPlugin.settings.enabledLanguages, language.id, value);
            }
            await this.lotusPlugin.saveSettings();
            this.languagePackageOpenState.set(pack.id, true);
            this.renderSettings();
          }),
        );

      const packageEnabled = this.lotusPlugin.settings.enabledLanguagePacks.includes(pack.id);
      for (const language of pack.languages) {
        new Setting(packEl)
          .setName(language.displayName)
          .setDesc(`Aliases: ${language.aliases.join(", ")}`)
          .addToggle((toggle) =>
            toggle
              .setDisabled(!packageEnabled)
              .setValue(packageEnabled && this.lotusPlugin.settings.enabledLanguages.includes(language.id))
              .onChange(async (value) => {
                this.setEnabledValue(this.lotusPlugin.settings.enabledLanguages, language.id, value);
                await this.lotusPlugin.saveSettings();
              }),
          );
      }
    }

    if (isCompileExternalLanguagePacksAllowed()) {
      new Setting(containerEl)
        .setName("Reload external language packs")
        .setDesc("Load JSON language pack manifests from the plugin language-packs folder.")
        .addButton((button) =>
          button.setButtonText("Reload").onClick(() => {
            void this.lotusPlugin.loadExternalLanguagePacks(true).then(async () => {
              await this.lotusPlugin.saveSettings();
              this.renderSettings();
            });
          }),
        );

      const bundleInput = containerEl.createEl("input", {
        attr: {
          type: "file",
          accept: ".zip,.tar,.tgz,.tar.gz,application/zip,application/x-tar,application/gzip",
        },
      });
      bundleInput.addClass("lotus-hidden-file-input");
      bundleInput.addEventListener("change", () => {
        void this.importLanguageBundle(bundleInput);
      });

      new Setting(containerEl)
        .setName("Import language bundle")
        .setDesc("Unpack a zip, tar, or tar.gz language bundle into the plugin language-packs folder.")
        .addButton((button) =>
          button.setButtonText("Import").onClick(() => {
            bundleInput.click();
          }),
        );
    }

    if (isCompileCustomLanguagesAllowed()) {
      new Setting(containerEl)
        .setName("Custom languages")
        .setDesc("Enable user-defined languages from the custom languages section.")
        .addToggle((toggle) =>
          toggle.setValue(this.lotusPlugin.settings.enabledLanguagePacks.includes(CUSTOM_LANGUAGE_PACKAGE_ID)).onChange(async (value) => {
            this.setEnabledValue(this.lotusPlugin.settings.enabledLanguagePacks, CUSTOM_LANGUAGE_PACKAGE_ID, value);
            await this.lotusPlugin.saveSettings();
            this.renderSettings();
          }),
        );
    }

    new Setting(containerEl)
      .setName("Reset language packages")
      .setDesc("Re-enable every built-in package and every built-in language.")
      .addButton((button) =>
        button.setButtonText("Reset").onClick(async () => {
          this.lotusPlugin.settings.enabledLanguagePacks = getDefaultLanguagePackIds();
          this.lotusPlugin.settings.enabledLanguages = getDefaultLanguageIds();
          await this.lotusPlugin.saveSettings();
          this.renderSettings();
        }),
      );
  }

  private async importLanguageBundle(bundleInput: HTMLInputElement): Promise<void> {
    const file = bundleInput.files?.[0];
    if (!file) {
      return;
    }

    try {
      const result = await this.lotusPlugin.importExternalLanguageBundle(file);
      await this.lotusPlugin.saveSettings();
      new Notice(`Imported language bundle ${result.packId} (${result.fileCount} files)`);
      this.renderSettings();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      new Notice(`Failed to import language bundle: ${message}`);
      console.warn("Failed to import lotus language bundle", error);
    } finally {
      bundleInput.value = "";
    }
  }

  private setEnabledValue(values: string[], id: string, enabled: boolean): void {
    const index = values.indexOf(id);
    if (enabled && index < 0) {
      values.push(id);
    } else if (!enabled && index >= 0) {
      values.splice(index, 1);
    }
  }

  private renderCustomLanguages(containerEl: HTMLElement): void {
    const listEl = containerEl.createDiv({ cls: "lotus-custom-language-list" });
    this.renderCustomLanguageList(listEl);

    new Setting(containerEl)
      .setName("Add custom language")
      .setDesc("Create a new local command-backed language.")
      .addButton((button) =>
        button.setButtonText("+").onClick(async () => {
          this.lotusPlugin.settings.customLanguages.push({
            name: "custom-language",
            aliases: "",
            mode: "execute",
            highlightLanguage: "",
            targetLanguage: "",
            executable: "",
            args: "{file}",
            extension: ".txt",
            outputMode: "streams",
            outputExtension: ".out",
            displayOutput: "none",
            displayMimeType: "text/plain",
            displayTitle: "",
            displayRole: "result",
            displayHeight: undefined,
            preprocessors: [],
            extractorMode: "command",
            extractorExecutable: "",
            extractorArgs: "{request}",
            transpileExecutable: "",
            transpileArgs: "{request}",
          });
          await this.lotusPlugin.saveSettings();
          this.renderSettings();
        }),
      );
  }

  private renderCustomLanguageList(containerEl: HTMLElement): void {
    containerEl.empty();

    if (!this.lotusPlugin.settings.customLanguages.length) {
      containerEl.createEl("p", {
        text: "No custom languages configured.",
        cls: "setting-item-description",
      });
      return;
    }

    this.lotusPlugin.settings.customLanguages.forEach((language, index) => {
      const details = containerEl.createEl("details", { cls: "lotus-custom-language" });
      details.open = true;
      details.createEl("summary", { text: language.name || `Custom language ${index + 1}` });
      const body = details.createDiv({ cls: "lotus-custom-language-body" });

      this.addCustomLanguageTextSetting(body, language, "Name", "Normalized language id used by lotus.", "name");
      this.addCustomLanguageTextSetting(body, language, "Aliases", "Comma-separated fence aliases.", "aliases");
      new Setting(body)
        .setName("Run mode")
        .setDesc("Execute runs the source as a normal block. Transpile runs the command once and treats stdout or the generated output file as source text.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("execute", "Execute")
            .addOption("transpile", "Transpile")
            .setValue(language.mode === "transpile" ? "transpile" : "execute")
            .onChange(async (value) => {
              language.mode = value as "execute" | "transpile";
              await this.lotusPlugin.saveSettings();
              this.renderSettings();
            }),
        );
      this.addCustomLanguageTextSetting(body, language, "Highlight as", "Optional language id used to highlight this custom fence's source, for example c, cpp, shell, or llvm-ir.", "highlightLanguage");
      if (language.mode === "transpile") {
        this.addCustomLanguageTextSetting(body, language, "Target language", "Language id for the generated source shown in stdout, for example c, x86, arm32, or llvm-ir.", "targetLanguage");
      }
      this.addCustomLanguageTextSetting(body, language, "Executable", "Local command or absolute executable path.", "executable");
      this.addCustomLanguageTextSetting(body, language, "Arguments", "Space-separated arguments. Use {file}, {output}, and {tempDir} for temp paths.", "args");
      this.addCustomLanguageTextSetting(body, language, "Extension", "Temp source file extension, for example .py.", "extension");
      new Setting(body)
        .setName("Output mode")
        .setDesc("Capture stdout/stderr, or read a generated temp file after the command exits.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("streams", "Captured streams")
            .addOption("file", "Generated file")
            .setValue(language.outputMode === "file" ? "file" : "streams")
            .onChange(async (value) => {
              language.outputMode = value as "streams" | "file";
              await this.lotusPlugin.saveSettings();
              this.renderSettings();
            }),
        );
      if (language.outputMode === "file") {
        this.addCustomLanguageTextSetting(body, language, "Output extension", "Temp output file extension used for the {output} path.", "outputExtension");
      }
      new Setting(body)
        .setName("Display output")
        .setDesc("Optionally wrap stdout or generated file output as a Lotus rich display.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("none", "No display")
            .addOption("copy-stdout", "Copy stdout to display")
            .addOption("replace-stdout", "Replace stdout with display")
            .setValue(language.displayOutput ?? "none")
            .onChange(async (value) => {
              language.displayOutput = value as "none" | "copy-stdout" | "replace-stdout";
              await this.lotusPlugin.saveSettings();
              this.renderSettings();
            }),
        );
      if (language.displayOutput && language.displayOutput !== "none") {
        this.addCustomLanguageTextSetting(body, language, "Display MIME type", "MIME type for the display payload, for example image/svg+xml, image/png, text/vnd.graphviz, or application/json.", "displayMimeType");
        this.addCustomLanguageTextSetting(body, language, "Display title", "Optional title shown above the rendered display.", "displayTitle");
        new Setting(body)
          .setName("Display height")
          .setDesc("Optional iframe/display height in pixels for HTML outputs.")
          .addText((text) =>
            text
              .setPlaceholder("520")
              .setValue(language.displayHeight ? String(language.displayHeight) : "")
              .onChange(async (value) => {
                const parsed = Number(value.trim());
                language.displayHeight = Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
                await this.lotusPlugin.saveSettings();
              }),
          );
        new Setting(body)
          .setName("Display role")
          .setDesc("Semantic role attached to the display record.")
          .addDropdown((dropdown) =>
            dropdown
              .addOption("result", "Result")
              .addOption("visualization", "Visualization")
              .addOption("diagnostic", "Diagnostic")
              .addOption("artifact", "Artifact")
              .setValue(language.displayRole ?? "result")
              .onChange(async (value) => {
                language.displayRole = value as "result" | "visualization" | "diagnostic" | "artifact";
                await this.lotusPlugin.saveSettings();
              }),
          );
      }
      this.renderCustomPreprocessorList(body, language);

      new Setting(body)
        .setName("Partial extraction strategy")
        .setDesc("Choose how this custom language supports partial runnable source.")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("command", "Extractor command")
            .addOption("transpile-c", "Transpile to c")
            .setValue(language.extractorMode || "command")
            .onChange(async (value) => {
              language.extractorMode = value as "command" | "transpile-c";
              await this.lotusPlugin.saveSettings();
            }),
        );

      this.addCustomLanguageTextSetting(body, language, "Extractor executable", "Optional command for partial source extraction. Leave empty to use generic line and symbol extraction.", "extractorExecutable");
      this.addCustomLanguageTextSetting(body, language, "Extractor arguments", "Arguments for the extractor. Use {request}, {source}, {harness}, {symbol}, {lineStart}, {lineEnd}, {deps}, and {language}.", "extractorArgs");
      this.addCustomLanguageTextSetting(body, language, "Transpile to C executable", "Optional command that emits generated C and a symbol map as JSON.", "transpileExecutable");
      this.addCustomLanguageTextSetting(body, language, "Transpile to C arguments", "Arguments for the transpiler. Use the same placeholders as extractor arguments.", "transpileArgs");

      new Setting(body)
        .setName("Delete language")
        .setDesc("Remove this custom language.")
        .addButton((button) => {
          button.buttonEl.addClass("mod-warning");
          button.setButtonText("Delete").onClick(async () => {
            this.lotusPlugin.settings.customLanguages.splice(index, 1);
            await this.lotusPlugin.saveSettings();
            this.renderSettings();
          });
        });
    });
  }

  private renderCustomPreprocessorList(containerEl: HTMLElement, language: lotusCustomLanguage): void {
    const details = containerEl.createEl("details", { cls: "lotus-custom-preprocessors" });
    details.open = Boolean(language.preprocessors?.length);
    details.createEl("summary", { text: "Preprocessor stages" });
    const body = details.createDiv({ cls: "lotus-custom-preprocessor-list" });
    const stages = language.preprocessors ?? [];

    if (!stages.length) {
      body.createEl("p", {
        text: "No preprocessor stages configured.",
        cls: "setting-item-description",
      });
    }

    stages.forEach((stage, index) => {
      const stageEl = body.createEl("details", { cls: "lotus-custom-preprocessor" });
      stageEl.open = true;
      stageEl.createEl("summary", { text: stage.name || `Stage ${index + 1}` });
      const stageBody = stageEl.createDiv({ cls: "lotus-custom-preprocessor-body" });
      this.addCustomPreprocessorTextSetting(stageBody, stage, "Name", "Stage label used in previews and stable artifact filenames.", "name");
      this.addCustomPreprocessorTextSetting(stageBody, stage, "Executable", "Command that transforms the current stage file.", "executable");
      this.addCustomPreprocessorTextSetting(stageBody, stage, "Arguments", "Use {request}, {input}, {output}, {artifactDir}, {language}, {outputLanguage}, {extension}, {outputExtension}, {sourceLanguage}, {alias}, {note}, {blockId}, {stage}, and {stageName}.", "args");
      this.addCustomPreprocessorTextSetting(stageBody, stage, "Output language", "Optional language id for the next stage or final runner.", "language");
      this.addCustomPreprocessorTextSetting(stageBody, stage, "Output extension", "Optional stable file extension for this stage output.", "extension");

      new Setting(stageBody)
        .setName("Delete stage")
        .setDesc("Remove this preprocessor stage.")
        .addButton((button) => {
          button.buttonEl.addClass("mod-warning");
          button.setButtonText("Delete").onClick(async () => {
            language.preprocessors?.splice(index, 1);
            await this.lotusPlugin.saveSettings();
            this.renderSettings();
          });
        });
    });

    new Setting(body)
      .setName("Add preprocessor stage")
      .setDesc("Append a command-backed source transformation stage.")
      .addButton((button) =>
        button.setButtonText("+").onClick(async () => {
          if (!language.preprocessors) {
            language.preprocessors = [];
          }
          language.preprocessors.push({
            name: `stage-${language.preprocessors.length + 1}`,
            executable: "",
            args: "{request}",
            language: "",
            extension: "",
          });
          await this.lotusPlugin.saveSettings();
          this.renderSettings();
        }),
      );
  }

  private async renderContainerGroups(containerEl: HTMLElement): Promise<void> {
    if (!isCompileFeatureAllowed("container-groups")) {
      return;
    }

    try {
      const groups = (await this.lotusPlugin.getContainerGroupSummaries())
        .filter((group) => isCompileContainerGroupAllowed(group.name));

      this.renderGodboltSettings(containerEl);

      new Setting(containerEl)
        .setName("Default execution group")
        .setDesc("The execution group to run code blocks in by default if the note does not specify one.")
        .addDropdown((dropdown) => {
          dropdown.addOption("", "None");
          for (const group of groups) {
            dropdown.addOption(group.name, group.name);
          }
          dropdown.setValue(this.lotusPlugin.settings.defaultContainerGroup || "");
          dropdown.onChange(async (value) => {
            this.lotusPlugin.settings.defaultContainerGroup = value;
            await this.lotusPlugin.saveSettings();
          });
        });

      if (!hasCompileContainerGroupSelection()) {
        new Setting(containerEl)
          .setName("Add new execution group")
          .setDesc("Create a new execution group configuration folder.")
          .addButton((button) =>
            button.setButtonText("+").onClick(() => {
              new ContainerGroupNameModal(this.app, async (groupName) => {
                const cleanName = groupName.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");
                if (!cleanName) {
                  new Notice("Invalid group name.");
                  return;
                }

                const pluginDir = this.getPluginConfigDir();
                const groupRelativePath = `${pluginDir}/containers/${cleanName}`;
                const configPath = `${groupRelativePath}/config.json`;

                const adapter = this.app.vault.adapter;
                if (await adapter.exists(groupRelativePath)) {
                  new Notice("Execution group folder already exists.");
                  return;
                }

                await adapter.mkdir(groupRelativePath);
                const defaultConfig = {
                  runtime: "docker",
                  image: "ubuntu:latest",
                  elevation: {
                    mode: "default"
                  },
                  languages: {
                    python: {
                      command: "python3 {file}",
                      extension: ".py"
                    }
                  }
                };
                await adapter.write(configPath, JSON.stringify(defaultConfig, null, 2));
                new Notice(`Execution group "${cleanName}" created.`);
                this.renderSettings();
              }).open();
            }),
          );
      }

      const listEl = containerEl.createDiv({ cls: "lotus-container-group-list" });
      if (!groups.length) {
        listEl.createEl("p", {
          text: `No execution groups found in ${this.getPluginConfigDir()}/containers.`,
          cls: "setting-item-description",
        });
        return;
      }

      for (const group of groups) {
        const setting = new Setting(listEl)
          .setName(group.name)
          .setDesc(group.status);

        if (group.buildable !== false) {
          setting.addButton((button) =>
            button.setButtonText("Build / rebuild").onClick(async () => {
              await this.lotusPlugin.buildContainerGroup(group.name);
            }),
          );
        }

        if (group.editable !== false) {
          setting.addButton((button) =>
            button.setButtonText("Edit").onClick(() => {
              const pluginDir = this.getPluginConfigDir();
              new EditContainerGroupModal(this.lotusPlugin, group.name, pluginDir, () => {
                this.renderSettings();
              }).open();
            }),
          );
        }
      }
    } catch (error) {
      containerEl.empty();
      containerEl.createEl("p", {
        text: `Error loading execution groups: ${error instanceof Error ? error.message : String(error)}`,
        cls: "lotus-settings-error",
        attr: { style: "color: var(--text-error); font-weight: bold; margin: 1em 0;" }
      });
      console.error("lotus: failed to render execution groups:", error);
    }
  }

  private renderGodboltSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName("Resolve Godbolt compilers from API")
      .setDesc("Fetch Compiler Explorer compiler metadata and cache the selected default per language. Lotus falls back to its baked in map if the API is unavailable.")
      .addToggle((toggle) =>
        toggle.setValue(this.lotusPlugin.settings.godboltResolveCompilerFromApi).onChange(async (value) => {
          this.lotusPlugin.settings.godboltResolveCompilerFromApi = value;
          await this.lotusPlugin.saveSettings();
        }),
      );

    this.addTextAreaSetting(
      containerEl,
      "Godbolt compiler defaults JSON",
      "Optional language to compiler id map. Example: {\"c++\":\"clang_trunk\",\"rust\":\"r1970\"}. Use none for source only links.",
      "godboltCompilerDefaults",
    );
    this.addTextAreaSetting(
      containerEl,
      "Godbolt options defaults JSON",
      "Optional language to options map. Example: {\"c++\":\"-O3 -std=c++23\",\"c\":\"-O2\"}.",
      "godboltOptionsDefaults",
    );
  }

  private addTextSetting<K extends keyof lotusPluginSettings>(containerEl: HTMLElement, name: string, description: string, key: K): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text.setValue(String(this.lotusPlugin.settings[key] ?? "")).onChange(async (value) => {
          (this.lotusPlugin.settings[key] as string) = value.trim();
          await this.lotusPlugin.saveSettings();
        }),
      );
  }

  private addTextAreaSetting<K extends keyof lotusPluginSettings>(containerEl: HTMLElement, name: string, description: string, key: K): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addTextArea((text) => {
        text.setValue(String(this.lotusPlugin.settings[key] ?? "")).onChange(async (value) => {
          (this.lotusPlugin.settings[key] as string) = value.trim();
          await this.lotusPlugin.saveSettings();
        });
        text.inputEl.rows = 4;
        text.inputEl.setCssStyles({
          fontFamily: "monospace",
          width: "100%",
        });
      });
  }

  private addCustomLanguageTextSetting<K extends lotusCustomLanguageTextKey>(
    containerEl: HTMLElement,
    language: lotusCustomLanguage,
    name: string,
    description: string,
    key: K,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text.setValue(String(language[key] ?? "")).onChange(async (value) => {
          language[key] = value.trim();
          await this.lotusPlugin.saveSettings();
        }),
      );
  }

  private addCustomPreprocessorTextSetting<K extends lotusCustomPreprocessorTextKey>(
    containerEl: HTMLElement,
    stage: lotusCustomPreprocessor,
    name: string,
    description: string,
    key: K,
  ): void {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) =>
        text.setValue(String(stage[key] ?? "")).onChange(async (value) => {
          stage[key] = value.trim();
          await this.lotusPlugin.saveSettings();
        }),
      );
  }

  private getPluginConfigDir(): string {
    return normalizePath(this.lotusPlugin.manifest.dir ?? `${this.app.vault.configDir}/plugins/lotus`);
  }
}

export function showExecutionDisabledNotice(): void {
  new Notice("Lotus local execution is disabled. Enable it in settings or confirm the execution warning first.");
}

function readContainerEditorConfig(value: unknown): lotusContainerEditorConfig {
  return isRecord(value) ? value : {};
}

function isContainerEditorRuntime(value: unknown): value is lotusContainerEditorRuntime {
  return typeof value === "string" && ["custom", "docker", "podman", "qemu", "ssh", "wsl", "http"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function formatHttpBodyForEditor(value: unknown): string {
  if (value === undefined) {
    return JSON.stringify({
      source: "{source}",
      stdin: "{stdin}",
      language: "{language}",
      fileName: "{fileName}",
      command: "{command}",
    }, null, 2);
  }
  if (typeof value === "string") {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

function createMachineIdSeed(): string {
  const cryptoApi = typeof crypto === "undefined" ? undefined : crypto as { randomUUID?: () => string };
  return cryptoApi?.randomUUID?.() ?? `lotus-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 14)}`;
}

function formatMachineHashPreview(settings: lotusPluginSettings, vaultName: string): string {
  switch (settings.loggingMachineHashScope) {
    case "vault":
      return sha256Hash(`vault:${vaultName}`).slice(0, 16);
    case "install-vault":
      return sha256Hash(JSON.stringify({
        installId: settings.loggingMachineId,
        vaultName,
      })).slice(0, 16);
    case "install":
      return sha256Hash(settings.loggingMachineId).slice(0, 16);
  }
}

class ContainerGroupNameModal extends Modal {
  private name = "";

  constructor(
    app: App,
    private readonly onSubmit: (name: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "New execution group name" });

    new Setting(contentEl)
      .setName("Group name")
      .setDesc("Use lowercase letters, numbers, hyphens, and underscores.")
      .addText((text) =>
        text.onChange((value) => {
          this.name = value;
        }),
      );

    new Setting(contentEl)
      .addButton((btn) =>
        btn
          .setButtonText("Create")
          .setCta()
          .onClick(() => {
            void this.onSubmit(this.name).then(() => {
              this.close();
            });
          }),
      );
  }
}

class EditContainerGroupModal extends Modal {
  private activeTab: "general" | "languages" | "dockerfile" | "raw" = "general";
  private configObj: lotusContainerEditorConfig = {};
  private rawJsonText = "";
  private dockerfileText: string | null = null;
  private newLanguageName = "";
  private tabHeaderEl!: HTMLElement;
  private tabContentEl!: HTMLElement;

  constructor(
    private readonly lotusPlugin: lotusPlugin,
    private readonly groupName: string,
    private readonly pluginDir: string,
    private readonly onSave: () => void
  ) {
    super(lotusPlugin.app);
  }

  async onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: `Edit Config: ${this.groupName}` });

    const configPath = `${this.pluginDir}/containers/${this.groupName}/config.json`;
    const dockerfilePath = `${this.pluginDir}/containers/${this.groupName}/Dockerfile`;
    const adapter = this.app.vault.adapter;

    try {
      const rawConfig = await adapter.read(configPath);
      const parsedConfig: unknown = JSON.parse(rawConfig);
      this.configObj = readContainerEditorConfig(parsedConfig);
      this.rawJsonText = rawConfig;
    } catch {
      new Notice("Could not read configuration file.");
      this.close();
      return;
    }

    try {
      if (await adapter.exists(dockerfilePath)) {
        this.dockerfileText = await adapter.read(dockerfilePath);
      } else {
        this.dockerfileText = null;
      }
    } catch {
      this.dockerfileText = null;
    }

    const container = contentEl.createDiv({ cls: "lotus-tab-container" });

    // Render Tab Header
    this.tabHeaderEl = container.createDiv({ cls: "lotus-tab-header" });
    this.renderTabs();

    // Render Tab Content Area
    this.tabContentEl = container.createDiv({ cls: "lotus-tab-content" });

    // Render Actions Footer
    const actions = contentEl.createDiv({ cls: "lotus-modal-actions" });
    actions.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
    const saveBtn = actions.createEl("button", { text: "Save", cls: "mod-cta" });
    saveBtn.addEventListener("click", () => {
      void this.saveAndClose();
    });

    this.renderActiveTab();
  }

  renderTabs() {
    this.tabHeaderEl.empty();
    const tabs: Array<{ id: "general" | "languages" | "dockerfile" | "raw"; label: string }> = [
      { id: "general", label: "General" },
      { id: "languages", label: "Languages" },
      { id: "dockerfile", label: "Dockerfile" },
      { id: "raw", label: "Raw JSON" },
    ];

    for (const tab of tabs) {
      const btn = this.tabHeaderEl.createEl("button", {
        text: tab.label,
        cls: "lotus-tab-btn" + (this.activeTab === tab.id ? " is-active" : ""),
      });
      btn.addEventListener("click", () => {
        void this.switchTab(tab.id);
      });
    }
  }

  async switchTab(tab: "general" | "languages" | "dockerfile" | "raw") {
    if (this.activeTab === "raw") {
      try {
        const parsedConfig: unknown = JSON.parse(this.rawJsonText);
        this.configObj = readContainerEditorConfig(parsedConfig);
      } catch {
        new Notice("Invalid JSON syntax in raw JSON tab. Please fix it before switching.");
        return;
      }
    }
    this.activeTab = tab;
    this.renderTabs();
    this.renderActiveTab();
  }

  renderActiveTab() {
    this.tabContentEl.empty();
    if (this.activeTab === "general") {
      this.renderGeneralTab(this.tabContentEl);
    } else if (this.activeTab === "languages") {
      this.renderLanguagesTab(this.tabContentEl);
    } else if (this.activeTab === "dockerfile") {
      this.renderDockerfileTab(this.tabContentEl);
    } else if (this.activeTab === "raw") {
      this.renderRawTab(this.tabContentEl);
    }
  }

  renderGeneralTab(containerEl: HTMLElement) {
    // Runtime select dropdown
    new Setting(containerEl)
      .setName("Runtime")
      .setDesc("Choose the container/environment manager runtime.")
      .addDropdown((dropdown) => {
        const runtimeLabels: Record<string, string> = {
          docker: "Docker",
          podman: "Podman",
          wsl: "WSL",
          ssh: "SSH Remote",
          qemu: "QEMU",
          custom: "Custom",
          http: "HTTP",
        };
        const allowedRuntimes = getCompileContainerRuntimes();
        for (const runtime of allowedRuntimes) {
          dropdown.addOption(runtime, runtimeLabels[runtime]);
        }
        const selectedRuntime = isContainerEditorRuntime(this.configObj.runtime) && allowedRuntimes.includes(this.configObj.runtime) ? this.configObj.runtime : allowedRuntimes[0] ?? "docker";
        this.configObj.runtime = selectedRuntime;
        dropdown
          .setValue(selectedRuntime)
          .onChange((value) => {
            if (isContainerEditorRuntime(value)) {
              this.configObj.runtime = value;
            }
            this.renderActiveTab();
          });
      });

    // Conditional image/distro name
    if (
      this.configObj.runtime === "docker" ||
      this.configObj.runtime === "podman" ||
      this.configObj.runtime === "wsl"
    ) {
      new Setting(containerEl)
        .setName(this.configObj.runtime === "wsl" ? "WSL Distro" : "Base Image")
        .setDesc(
          this.configObj.runtime === "wsl"
            ? "Optional. The target WSL distro name (leave empty for default distro)."
            : "Fallback Docker/Podman image if no Dockerfile is present."
        )
        .addText((text) => {
          text
            .setValue(this.configObj.image || "")
            .onChange((val) => {
              this.configObj.image = val.trim();
            });
        });
    }

    if (this.configObj.runtime === "docker" || this.configObj.runtime === "podman") {
      const persistent = this.getPersistentConfig();
      new Setting(containerEl)
        .setName("Persistent container")
        .setDesc("Start this Docker/Podman container once and run snippets through exec so filesystem and process state can persist between runs.")
        .addToggle((toggle) => {
          toggle
            .setValue(persistent.enabled === true)
            .onChange((value) => {
              persistent.enabled = value;
              this.renderActiveTab();
            });
        });

      if (persistent.enabled) {
        new Setting(containerEl)
          .setName("Persistent container name")
          .setDesc("Optional stable container name. Leave blank to derive one from the execution group name.")
          .addText((text) => {
            text
              .setPlaceholder(`lotus-container-${this.groupName.toLowerCase().replace(/[^a-z0-9_.-]/g, "-")}-persistent`)
              .setValue(persistent.name || "")
              .onChange((val) => {
                persistent.name = val.trim() || undefined;
              });
          });

        new Setting(containerEl)
          .setName("Keep-alive command")
          .setDesc("Command used as the persistent container's main process.")
          .addText((text) => {
            text
              .setPlaceholder("Example: sleep infinity")
              .setValue(persistent.keepAliveCommand || "")
              .onChange((val) => {
                persistent.keepAliveCommand = val.trim() || undefined;
              });
          });
      }
    }

    if (!this.configObj.elevation || typeof this.configObj.elevation !== "object") {
      this.configObj.elevation = { mode: "default" };
    }
    const elevation = this.configObj.elevation;

    new Setting(containerEl)
      .setName("Elevation")
      .setDesc(
        this.configObj.runtime === "docker" || this.configObj.runtime === "podman"
          ? "Run snippets with the image default user, or force root with --user root."
          : "Keep default privileges, or mark this group as elevated and optionally prefix commands."
      )
      .addDropdown((dropdown) => {
        dropdown
          .addOption("default", "Default")
          .addOption("root", "Root")
          .setValue(elevation.mode || "default")
          .onChange((value) => {
            elevation.mode = value === "root" ? "root" : "default";
            this.renderActiveTab();
          });
      });

    if (
      elevation.mode === "root" &&
      (this.configObj.runtime === "qemu" || this.configObj.runtime === "wsl" || this.configObj.runtime === "custom" || this.configObj.runtime === "ssh")
    ) {
      new Setting(containerEl)
        .setName("Elevation command prefix")
        .setDesc("Optional prefix for remote or wrapper commands, for example sudo -n. Lotus does not prompt for passwords.")
        .addText((text) => {
          text
            .setPlaceholder("Sudo -n")
            .setValue(elevation.commandPrefix || "")
            .onChange((val) => {
              elevation.commandPrefix = val.trim() || undefined;
            });
        });
    }

    if (this.configObj.runtime === "wsl") {
      if (!this.configObj.wsl) {
        this.configObj.wsl = {};
      }
      const wsl = this.configObj.wsl;
      new Setting(containerEl)
        .setName("Use interactive shell")
        .setDesc("Use interactive login shell flags (-i -l) to ensure ~/.bashrc initialization works (e.g., for nvm).")
        .addToggle((toggle) => {
          toggle
            .setValue(wsl.interactive ?? false)
            .onChange((val) => {
              wsl.interactive = val;
            });
        });
    }

    if (this.configObj.runtime === "ssh") {
      if (!this.configObj.ssh || typeof this.configObj.ssh !== "object") {
        this.configObj.ssh = this.configObj.remote && typeof this.configObj.remote === "object"
          ? this.configObj.remote
          : { target: "", workspace: "/tmp/lotus" };
      }
      const ssh = this.configObj.ssh;

      new Setting(containerEl)
        .setName("SSH target")
        .setDesc("Remote SSH target, for example user@vps or user@host.")
        .addText((text) => {
          text
            .setValue(ssh.target || ssh.sshTarget || "")
            .onChange((val) => {
              ssh.target = val.trim();
            });
        });

      new Setting(containerEl)
        .setName("Remote workspace")
        .setDesc("Remote folder where Lotus uploads snippets before running them.")
        .addText((text) => {
          text
            .setValue(ssh.workspace || ssh.remoteWorkspace || "/tmp/lotus")
            .onChange((val) => {
              ssh.workspace = val.trim();
            });
        });

      this.renderRemoteTransportSettings(containerEl, ssh, true);
    }

    // Conditional QEMU Settings
    if (this.configObj.runtime === "qemu") {
      if (!this.configObj.qemu) {
        this.configObj.qemu = { sshTarget: "", remoteWorkspace: "" };
      }
      const qemu = this.configObj.qemu;

      new Setting(containerEl)
        .setName("SSH target")
        .setDesc("SSH target address (e.g. User@hostname or localhost -p 2222).")
        .addText((text) => {
          text
            .setValue(qemu.sshTarget || "")
            .onChange((val) => {
              qemu.sshTarget = val.trim();
            });
        });

      new Setting(containerEl)
        .setName("Remote workspace")
        .setDesc("Remote folder path to copy code snippets and run commands (e.g., /home/user/workspace).")
        .addText((text) => {
          text
            .setValue(qemu.remoteWorkspace || "")
            .onChange((val) => {
              qemu.remoteWorkspace = val.trim();
            });
        });

      new Setting(containerEl)
        .setName("SSH executable")
        .setDesc("Optional. Path to SSH client executable (defaults to SSH).")
        .addText((text) => {
          text
            .setValue(qemu.sshExecutable || "")
            .onChange((val) => {
              qemu.sshExecutable = val.trim() || undefined;
            });
        });

      new Setting(containerEl)
        .setName("SSH arguments")
        .setDesc("Optional. Additional SSH cli flags.")
        .addText((text) => {
          text
            .setValue(qemu.sshArgs || "")
            .onChange((val) => {
              qemu.sshArgs = val.trim() || undefined;
            });
        });

      this.renderRemoteTransportSettings(containerEl, qemu, false);
    }

    if (isCompileFeatureAllowed("output-filters")) {
      this.renderOutputFilters(containerEl);
    }

    if (this.configObj.runtime === "http") {
      this.renderHttpSettings(containerEl);
    }

    // Conditional Custom Settings
    if (this.configObj.runtime === "custom") {
      if (!this.configObj.custom) {
        this.configObj.custom = { executable: "" };
      }
      const custom = this.configObj.custom;

      new Setting(containerEl)
        .setName("Custom executable")
        .setDesc("Path to custom runtime wrapper executable or script.")
        .addText((text) => {
          text
            .setValue(custom.executable || "")
            .onChange((val) => {
              custom.executable = val.trim();
            });
        });

      new Setting(containerEl)
        .setName("Custom arguments")
        .setDesc("Optional. Command arguments. Use {request} for JSON config path.")
        .addText((text) => {
          text
            .setValue(custom.args || "")
            .onChange((val) => {
              custom.args = val.trim() || undefined;
            });
      });
    }
  }

  getPersistentConfig(): lotusContainerEditorPersistentConfig {
    if (!this.configObj.persistent || typeof this.configObj.persistent !== "object" || Array.isArray(this.configObj.persistent)) {
      this.configObj.persistent = { enabled: this.configObj.persistent === true };
    }
    return this.configObj.persistent;
  }

  renderHttpSettings(containerEl: HTMLElement) {
    if (!this.configObj.http || typeof this.configObj.http !== "object") {
      this.configObj.http = {
        url: "",
        method: "POST",
        responseMode: "auto",
        headers: {},
      };
    }
    const http = this.configObj.http;

    containerEl.createEl("h3", { text: "HTTP request", attr: { style: "margin-top: 1.5rem;" } });

    new Setting(containerEl)
      .setName("URL")
      .setDesc("HTTP endpoint. Supports templates like {languageUri}, {sourceUri}, {stdinUri}, and {fileName}.")
      .addText((text) => {
        text
          .setPlaceholder("https://runner.example/run")
          .setValue(http.url || http.endpoint || "")
          .onChange((val) => {
            http.url = val.trim();
            delete http.endpoint;
          });
      });

    new Setting(containerEl)
      .setName("Method")
      .setDesc("HTTP method used for snippet submission.")
      .addDropdown((dropdown) => {
        const method = typeof http.method === "string" ? http.method.toUpperCase() : "POST";
        dropdown
          .addOption("GET", "GET")
          .addOption("POST", "POST")
          .addOption("PUT", "PUT")
          .addOption("PATCH", "PATCH")
          .addOption("DELETE", "DELETE")
          .addOption("HEAD", "HEAD")
          .setValue(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"].includes(method) ? method : "POST")
          .onChange((value) => {
            http.method = value;
          });
      });

    new Setting(containerEl)
      .setName("Content type")
      .setDesc("Optional request content type. Lotus defaults to application/json for structured bodies and text/plain for raw bodies.")
      .addText((text) => {
        text
          .setPlaceholder("application/json")
          .setValue(http.contentType || "")
          .onChange((val) => {
            http.contentType = val.trim() || undefined;
          });
      });

    new Setting(containerEl)
      .setName("Headers JSON")
      .setDesc("String map of request headers. Values support the same templates as URL.")
      .addTextArea((text) => {
        text.inputEl.rows = 4;
        text.inputEl.setCssStyles({ fontFamily: "monospace", width: "100%" });
        text.setValue(JSON.stringify(http.headers ?? {}, null, 2));
        text.onChange((val) => {
          const parsed = parseJsonRecord(val);
          if (parsed) {
            http.headers = Object.fromEntries(
              Object.entries(parsed)
                .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            );
          }
        });
      });

    new Setting(containerEl)
      .setName("Body template")
      .setDesc("JSON object, array, or raw string. String values support templates like {source}, {stdin}, {language}, and {command}.")
      .addTextArea((text) => {
        text.inputEl.rows = 8;
        text.inputEl.setCssStyles({ fontFamily: "monospace", width: "100%" });
        text.setValue(formatHttpBodyForEditor(http.body));
        text.onChange((val) => {
          const trimmed = val.trim();
          if (!trimmed) {
            delete http.body;
            return;
          }
          try {
            http.body = JSON.parse(trimmed) as unknown;
          } catch {
            http.body = val;
          }
        });
      });

    new Setting(containerEl)
      .setName("Response mode")
      .setDesc("Auto parses JSON when response paths are configured. Text keeps the raw response body.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("auto", "Auto")
          .addOption("json", "JSON")
          .addOption("text", "Text")
          .setValue(http.responseMode ?? "auto")
          .onChange((value) => {
            http.responseMode = value as "auto" | "json" | "text";
          });
      });

    new Setting(containerEl)
      .setName("Success statuses")
      .setDesc("Status code or range. Use 200-299 for normal HTTP success.")
      .addText((text) => {
        const value = http.successStatus ?? http.successStatuses;
        text
          .setPlaceholder("200-299")
          .setValue(Array.isArray(value) ? value.join(", ") : value == null ? "" : String(value))
          .onChange((val) => {
            const trimmed = val.trim();
            if (trimmed) {
              http.successStatus = trimmed.includes(",") ? trimmed.split(",").map((entry) => entry.trim()).filter(Boolean) : trimmed;
            } else {
              delete http.successStatus;
            }
            delete http.successStatuses;
          });
      });

    this.addHttpPathSetting(containerEl, http, "Stdout path", "Optional JSON path for stdout. Leave empty to use the raw response body.", "stdoutPath", http.stdoutPath ?? http.stdout ?? http.outputPath ?? http.output);
    this.addHttpPathSetting(containerEl, http, "Stderr path", "Optional JSON path for stderr.", "stderrPath", http.stderrPath ?? http.stderr);
    this.addHttpPathSetting(containerEl, http, "Exit code path", "Optional JSON path for exit code. Missing path defaults to HTTP status.", "exitCodePath", http.exitCodePath ?? http.exitCode);
    this.addHttpPathSetting(containerEl, http, "Success path", "Optional JSON path for a boolean success flag.", "successPath", http.successPath ?? http.success);
  }

  addHttpPathSetting(containerEl: HTMLElement, http: lotusContainerEditorHttpConfig, name: string, description: string, key: keyof lotusContainerEditorHttpConfig, value: unknown) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text
          .setValue(typeof value === "string" ? value : "")
          .onChange((val) => {
            http[key] = val.trim() || undefined;
          });
      });
  }

  renderRemoteTransportSettings(containerEl: HTMLElement, remoteConfig: lotusContainerEditorRemoteConfig, includeSshSettings: boolean) {
    if (includeSshSettings) {
      new Setting(containerEl)
        .setName("SSH executable")
        .setDesc("Optional. Path to SSH client executable, defaults to SSH).")
        .addText((text) => {
          text
            .setValue(remoteConfig.sshExecutable || "")
            .onChange((val) => {
              remoteConfig.sshExecutable = val.trim() || undefined;
            });
        });

      new Setting(containerEl)
        .setName("SSH arguments")
        .setDesc("Optional. Additional SSH cli flags, such as -p 2222.")
        .addText((text) => {
          text
            .setValue(remoteConfig.sshArgs || "")
            .onChange((val) => {
              remoteConfig.sshArgs = val.trim() || undefined;
            });
        });
    }

    new Setting(containerEl)
      .setName("Remote upload mode")
      .setDesc("Inline SSH uses one SSH session per run, so password prompts happen once and interactive stdin stays available. Use scp compatibility only when the remote shell cannot handle inline uploads.")
      .addDropdown((dropdown) => {
        dropdown
          .addOption("inline", "Inline SSH")
          .addOption("scp", "Scp compatibility")
          .setValue(remoteConfig.uploadMode || "inline")
          .onChange((value) => {
            remoteConfig.uploadMode = value === "scp" ? "scp" : undefined;
          });
      });

    new Setting(containerEl)
      .setName("SSH auth socket")
      .setDesc("Optional. Override SSH_auth_sock for this group, useful for bitwarden or another SSH agent.")
      .addText((text) => {
        text
          .setPlaceholder("/path/to/agent.sock")
          .setValue(remoteConfig.sshAuthSock || remoteConfig.authSock || remoteConfig.sshAgentSocket || "")
          .onChange((val) => {
            remoteConfig.sshAuthSock = val.trim() || undefined;
          });
      });

    new Setting(containerEl)
      .setName("Scp executable")
      .setDesc("Optional. Path to scp executable, defaults to scp. Used only when remote upload mode is scp compatibility.")
      .addText((text) => {
        text
          .setValue(remoteConfig.scpExecutable || "")
          .onChange((val) => {
            remoteConfig.scpExecutable = val.trim() || undefined;
          });
      });

    new Setting(containerEl)
      .setName("Scp arguments")
      .setDesc("Optional. Additional scp cli flags. Use -p for ports with OpenSSH scp. Used only when remote upload mode is scp compatibility.")
      .addText((text) => {
        text
          .setValue(remoteConfig.scpArgs || "")
          .onChange((val) => {
            remoteConfig.scpArgs = val.trim() || undefined;
          });
      });

    new Setting(containerEl)
      .setName("Clean up remote snippets")
      .setDesc("Delete uploaded temp files from the remote workspace after each run.")
      .addToggle((toggle) => {
        toggle
          .setValue(remoteConfig.cleanupRemoteFile !== false)
          .onChange((value) => {
            remoteConfig.cleanupRemoteFile = value;
          });
      });

    new Setting(containerEl)
      .setName("Remote mkdir command")
      .setDesc("Optional. Command used to create the remote workspace. Supports {workspace}.")
      .addText((text) => {
        text
          .setPlaceholder("mkdir -p {workspace}")
          .setValue(remoteConfig.mkdirCommand || "")
          .onChange((val) => {
            remoteConfig.mkdirCommand = val.trim() || undefined;
          });
      });

    new Setting(containerEl)
      .setName("Remote cleanup command")
      .setDesc("Optional. Command used to delete uploaded snippets. Supports {file}.")
      .addText((text) => {
        text
          .setPlaceholder("rm -f {file}")
          .setValue(remoteConfig.cleanupCommand || "")
          .onChange((val) => {
            remoteConfig.cleanupCommand = val.trim() || undefined;
          });
      });

    const healthCheck = remoteConfig.healthCheck && typeof remoteConfig.healthCheck === "object" ? remoteConfig.healthCheck : {};
    new Setting(containerEl)
      .setName("Remote health check")
      .setDesc("Optional command run over SSH before uploads, for example uname -a.")
      .addText((text) => {
        text
          .setValue(healthCheck.command || "")
          .onChange((val) => {
            const command = val.trim();
            if (command) {
              remoteConfig.healthCheck = { ...(remoteConfig.healthCheck || {}), command };
            } else {
              delete remoteConfig.healthCheck;
            }
          });
      });
  }

  renderOutputFilters(containerEl: HTMLElement) {
    if (!this.configObj.outputFilters || typeof this.configObj.outputFilters !== "object") {
      this.configObj.outputFilters = {};
    }
    const filters = this.configObj.outputFilters;

    containerEl.createEl("h3", { text: "Output filters", attr: { style: "margin-top: 1.5rem;" } });

    new Setting(containerEl)
      .setName("Strip ansi control sequences")
      .setDesc("Remove terminal color/control escape sequences from stdout and stderr.")
      .addToggle((toggle) => {
        toggle
          .setValue(filters.stripAnsi === true)
          .onChange((value) => {
            filters.stripAnsi = value || undefined;
          });
      });

    this.addOutputFilterText(containerEl, filters, "Stdout start regex", "Drop stdout before the first match.", "stdoutStart");
    this.addOutputFilterText(containerEl, filters, "Stdout end regex", "Drop stdout after the first match.", "stdoutEnd");
    this.addOutputFilterText(containerEl, filters, "Stderr start regex", "Drop stderr before the first match.", "stderrStart");
    this.addOutputFilterText(containerEl, filters, "Stderr end regex", "Drop stderr after the first match.", "stderrEnd");
    this.addOutputFilterList(containerEl, filters, "Strip stdout regexes", "One regex per line to remove from stdout.", "stripStdout");
    this.addOutputFilterList(containerEl, filters, "Strip stderr regexes", "One regex per line to remove from stderr.", "stripStderr");
  }

  addOutputFilterText(containerEl: HTMLElement, filters: lotusContainerEditorOutputFilters, name: string, description: string, key: keyof lotusContainerEditorOutputFilters) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        const value = filters[key];
        text
          .setValue(typeof value === "string" ? value : "")
          .onChange((val) => {
            filters[key] = val.trim() || undefined;
          });
      });
  }

  addOutputFilterList(containerEl: HTMLElement, filters: lotusContainerEditorOutputFilters, name: string, description: string, key: keyof lotusContainerEditorOutputFilters) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addTextArea((text) => {
        text.inputEl.rows = 3;
        text.inputEl.setCssStyles({ fontFamily: "monospace" });
        const value = filters[key];
        text.setValue(Array.isArray(value) ? value.join("\n") : typeof value === "string" ? value : "");
        text.onChange((val) => {
          const values = val.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
          filters[key] = values.length ? values : undefined;
        });
      });
  }

  renderLanguagesTab(containerEl: HTMLElement) {
    containerEl.createEl("h3", { text: "Configured languages" });

    if (!this.configObj.languages) {
      this.configObj.languages = {};
    }
    const configuredLanguages = this.configObj.languages;

    const langsListEl = containerEl.createDiv({ cls: "lotus-languages-list" });
    const languages = Object.entries(configuredLanguages);

    if (languages.length === 0) {
      langsListEl.createEl("p", { text: "No languages configured for this group.", cls: "setting-item-description" });
    } else {
      for (const [langName, langConfig] of languages) {
        const card = langsListEl.createDiv({ cls: "lotus-language-card" });
        card.createEl("strong", { text: langName, attr: { style: "display: block; margin-bottom: 0.5rem; font-size: 1.1em;" } });

        const isDefault = langConfig.useDefault === true;

        new Setting(card)
          .setName("Use default configuration")
          .setDesc("If checked, Lotus will run this language using its built-in commands/extensions.")
          .addToggle((toggle) => {
            toggle
              .setValue(isDefault)
              .onChange((val) => {
                if (val) {
                  langConfig.useDefault = true;
                  delete langConfig.command;
                  delete langConfig.extension;
                } else {
                  delete langConfig.useDefault;
                  const defaults = this.lotusPlugin.containerRunner.getDefaultLanguageConfig(langName, this.lotusPlugin.settings);
                  langConfig.command = defaults?.command || "";
                  langConfig.extension = defaults?.extension || "";
                }
                this.renderActiveTab();
              });
          });

        new Setting(card)
          .setName("Command")
          .setDesc("Execution command. Use {file} for the code snippet filename.")
          .addText((text) => {
            const defaults = this.lotusPlugin.containerRunner.getDefaultLanguageConfig(langName, this.lotusPlugin.settings);
            text
              .setPlaceholder(defaults?.command || "")
              .setValue(langConfig.command || "")
              .setDisabled(isDefault)
              .onChange((val) => {
                langConfig.command = val.trim();
              });
          });

        new Setting(card)
          .setName("Extension")
          .setDesc("Source file extension (e.g. .py, .JS).")
          .addText((text) => {
            const defaults = this.lotusPlugin.containerRunner.getDefaultLanguageConfig(langName, this.lotusPlugin.settings);
            text
              .setPlaceholder(defaults?.extension || "")
              .setValue(langConfig.extension || "")
              .setDisabled(isDefault)
              .onChange((val) => {
                langConfig.extension = val.trim();
              });
          });

        new Setting(card)
          .addButton((btn) => {
            btn.buttonEl.addClass("mod-warning");
            btn
              .setButtonText("Remove language")
              .onClick(() => {
                delete configuredLanguages[langName];
                this.renderActiveTab();
              });
          });
      }
    }

    // Add Language Section
    containerEl.createEl("h3", { text: "Add language mapping", attr: { style: "margin-top: 1.5rem;" } });
    new Setting(containerEl)
      .setName("Language id")
      .setDesc("E.g. Python, javascript, node, sh")
      .addText((text) => {
        text.setValue(this.newLanguageName).onChange((val) => {
          this.newLanguageName = val.trim().toLowerCase();
        });
      })
      .addButton((btn) => {
        btn.setButtonText("+ add").setCta().onClick(() => {
          if (!this.newLanguageName) {
            new Notice("Please enter a language name.");
            return;
          }
          if (configuredLanguages[this.newLanguageName]) {
            new Notice("Language already configured.");
            return;
          }
          configuredLanguages[this.newLanguageName] = {
            command: `${this.newLanguageName} {file}`,
            extension: `.${this.newLanguageName}`,
          };
          this.newLanguageName = "";
          this.renderActiveTab();
        });
      });
  }

  renderDockerfileTab(containerEl: HTMLElement) {
    if (this.configObj.runtime !== "docker" && this.configObj.runtime !== "podman") {
      containerEl.createEl("p", {
        text: `Dockerfile editing is only available for Docker and Podman runtimes. Currently using: ${this.configObj.runtime}`,
        cls: "setting-item-description",
      });
      return;
    }

    if (this.dockerfileText === null) {
      containerEl.createEl("p", {
        text: "No dockerfile exists in this execution group directory.",
        cls: "setting-item-description",
      });

      new Setting(containerEl)
        .addButton((btn) => {
          btn
            .setButtonText("Create dockerfile")
            .setCta()
            .onClick(() => {
              this.dockerfileText = [
                "FROM ubuntu:latest",
                "",
                "# Install packages",
                "RUN apt-get update && apt-get install -y \\",
                "    python3 \\",
                "    nodejs \\",
                "    && rm -rf /var/lib/apt/lists/*",
                "",
              ].join("\n");
              this.renderActiveTab();
            });
        });
    } else {
      new Setting(containerEl)
        .setName("Dockerfile content")
        .setDesc("Define the build steps for your environment container.")
        .addTextArea((text) => {
          text.inputEl.rows = 15;
          text.inputEl.setCssStyles({
            fontFamily: "monospace",
            width: "100%",
          });
          text.setValue(this.dockerfileText || "");
          text.onChange((val) => {
            this.dockerfileText = val;
          });
        });
    }
  }

  renderRawTab(containerEl: HTMLElement) {
    this.rawJsonText = JSON.stringify(this.configObj, null, 2);
    new Setting(containerEl)
      .setName("Configuration JSON")
      .addTextArea((text) => {
        text.inputEl.rows = 15;
        text.inputEl.setCssStyles({
          fontFamily: "monospace",
          width: "100%",
        });
        text.setValue(this.rawJsonText);
        text.onChange((val) => {
          this.rawJsonText = val;
        });
      });
  }

  async saveAndClose() {
    // If the active tab is raw JSON, parse it first to ensure we capture edits
    if (this.activeTab === "raw") {
      try {
        const parsedConfig: unknown = JSON.parse(this.rawJsonText);
        this.configObj = readContainerEditorConfig(parsedConfig);
      } catch {
        new Notice("Invalid JSON syntax in raw JSON tab. Please fix it before saving.");
        return;
      }
    }

    // Basic Validation
    if (!this.configObj.runtime) {
      new Notice("Runtime is required.");
      return;
    }
    if (this.configObj.runtime === "qemu" && (!this.configObj.qemu?.sshTarget || !this.configObj.qemu?.remoteWorkspace)) {
      new Notice("QEMU runtime requires SSH target and remote workspace.");
      return;
    }
    if (this.configObj.runtime === "ssh" && (!this.configObj.ssh?.target || !this.configObj.ssh?.workspace)) {
      new Notice("SSH runtime requires SSH target and remote workspace.");
      return;
    }
    if (this.configObj.runtime === "custom" && !this.configObj.custom?.executable) {
      new Notice("Custom runtime requires custom executable.");
      return;
    }
    if (this.configObj.runtime === "http" && !(this.configObj.http?.url || this.configObj.http?.endpoint)) {
      new Notice("HTTP runtime requires an HTTP URL.");
      return;
    }

    const adapter = this.app.vault.adapter;
    const configPath = `${this.pluginDir}/containers/${this.groupName}/config.json`;
    const dockerfilePath = `${this.pluginDir}/containers/${this.groupName}/Dockerfile`;

    try {
      // Save config.json
      const configStr = JSON.stringify(this.configObj, null, 2);
      await adapter.write(configPath, configStr);

      // Save Dockerfile
      if (this.configObj.runtime === "docker" || this.configObj.runtime === "podman") {
        if (this.dockerfileText !== null) {
          await adapter.write(dockerfilePath, this.dockerfileText);
        }
      }

      new Notice("Container group configurations saved.");
      this.onSave();
      this.close();
    } catch (error) {
      new Notice(`Save failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
