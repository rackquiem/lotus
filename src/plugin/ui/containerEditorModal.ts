
import { App, Modal, Notice, Setting } from "obsidian";
import type lotusPlugin from "../main";
import { getCompileContainerRuntimes, isCompileFeatureAllowed, type lotusCompileContainerRuntime } from "../../engine/buildProfile";
import { isRecord } from "../../engine/utils/record";

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

function readContainerEditorConfig(value: unknown): lotusContainerEditorConfig {
  return isRecord(value) ? value : {};
}

function isContainerEditorRuntime(value: unknown): value is lotusContainerEditorRuntime {
  return typeof value === "string" && ["custom", "docker", "podman", "qemu", "ssh", "wsl", "http"].includes(value);
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

export class ContainerGroupNameModal extends Modal {
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

export class EditContainerGroupModal extends Modal {
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
