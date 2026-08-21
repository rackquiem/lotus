import { Notice, PluginSettingTab, Setting, normalizePath } from "obsidian";
import type lotusPlugin from "./main";
import { getCompileMachineHashScopeOverride, getCompileProfileSummary, hasCompileContainerGroupSelection, isCompileContainerGroupAllowed, isCompileCustomLanguagesAllowed, isCompileExternalLanguagePacksAllowed, isCompileFeatureAllowed, isCompileLoggingForced, isLightCompileMode } from "../engine/buildProfile";
import { CUSTOM_LANGUAGE_PACKAGE_ID, getAvailableLanguagePackages, getDefaultLanguageIds, getDefaultLanguagePackIds, isLanguageEnabled, normalizeLanguageConfiguration } from "../engine/languagePackages";
import { sha256Hash } from "../engine/utils/hash";
import type { lotusCustomLanguage, lotusCustomPreprocessor, lotusPluginSettings } from "../engine/types";
import { ContainerGroupNameModal, EditContainerGroupModal } from "./ui/containerEditorModal";

export { DEFAULT_SETTINGS } from "../engine/defaultSettings";

type lotusCustomLanguageTextKey = Exclude<keyof lotusCustomLanguage, "displayHeight" | "displayOutput" | "displayRole" | "extractorMode" | "mode" | "outputMode" | "packageDirectory" | "preprocessors">;

type lotusCustomPreprocessorTextKey = keyof lotusCustomPreprocessor;

export function showExecutionDisabledNotice(): void {
  new Notice("Lotus local execution is disabled. Enable it in settings or confirm the execution warning first.");
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
