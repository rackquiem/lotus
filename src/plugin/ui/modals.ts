
import { Modal, Plugin, Setting } from "obsidian";
import type { lotusSignatureMaterial } from "../../engine/signingService";
import { HASH_POLICY_PRESETS, getHashPolicyPresetDefinition, type lotusHashPolicy, type lotusHashPolicyPreset } from "../../engine/reproducibility";

export class ExecutionConsentModal extends Modal {
  constructor(
    app: Plugin["app"],
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Enable Lotus local execution?" });
    contentEl.createEl("p", {
      text: "Lotus runs code from your notes on your local machine using the configured executables. It does not sandbox or isolate the process.",
    });

    const actions = contentEl.createDiv({ cls: "lotus-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const enableButton = actions.createEl("button", { text: "Enable and run", cls: "mod-cta" });

    cancelButton.addEventListener("click", () => this.close());
    enableButton.addEventListener("click", () => {
      void this.onConfirm().then(() => {
        this.close();
      });
    });
  }
}

export class ReproducibilityPolicyModal extends Modal {
  private selectedPreset: Exclude<lotusHashPolicyPreset, "custom">;
  private descriptionEl: HTMLElement | null = null;

  constructor(
    app: Plugin["app"],
    currentPolicy: lotusHashPolicy,
    private readonly onChoose: (preset: Exclude<lotusHashPolicyPreset, "custom">) => Promise<void>,
  ) {
    super(app);
    this.selectedPreset = currentPolicy.preset === "custom" ? "runtime-flexible" : currentPolicy.preset;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Lotus reproducibility policy" });
    contentEl.createEl("p", {
      text: "Choose what may change without invalidating a saved reproducibility snapshot.",
    });

    this.descriptionEl = contentEl.createEl("p", { cls: "setting-item-description" });

    new Setting(contentEl)
      .setName("Policy preset")
      .setDesc("Strict locks everything. Flexible presets allow selected execution plumbing to vary.")
      .addDropdown((dropdown) => {
        for (const preset of HASH_POLICY_PRESETS) {
          dropdown.addOption(preset.id, preset.label);
        }
        dropdown.setValue(this.selectedPreset);
        dropdown.onChange((value) => {
          this.selectedPreset = value as Exclude<lotusHashPolicyPreset, "custom">;
          this.renderPresetDescription();
        });
      });

    const actions = contentEl.createDiv({ cls: "lotus-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const applyButton = actions.createEl("button", { text: "Apply policy", cls: "mod-cta" });
    cancelButton.addEventListener("click", () => this.close());
    applyButton.addEventListener("click", () => {
      void this.onChoose(this.selectedPreset).then(() => {
        this.close();
      });
    });

    this.renderPresetDescription();
  }

  private renderPresetDescription(): void {
    const preset = getHashPolicyPresetDefinition(this.selectedPreset);
    if (this.descriptionEl) {
      this.descriptionEl.setText(preset.description);
    }
  }
}

export class SignatureMaterialModal extends Modal {
  private settled = false;

  constructor(
    app: Plugin["app"],
    private readonly options: {
      title: string;
      mode: "passphrase" | "rsa";
      action: "sign" | "verify";
      hasPrivateKeyPath: boolean;
      cachedPassphrase?: string;
      onSubmit: (material: lotusSignatureMaterial) => void;
      onCancel: () => void;
    },
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.options.title });

    if (this.options.mode === "passphrase") {
      this.renderPassphraseForm(contentEl);
    } else {
      this.renderRsaForm(contentEl);
    }
  }

  onClose(): void {
    if (!this.settled) {
      this.settled = true;
      this.options.onCancel();
    }
  }

  private renderPassphraseForm(contentEl: HTMLElement): void {
    contentEl.createEl("p", {
      text: this.options.action === "sign"
        ? "Enter a passphrase. The passphrase is not stored; Lotus stores only the salt, KDF parameters, payload hash, and HMAC."
        : "Enter the passphrase used to sign this note.",
    });
    const passphrase = createPasswordInput(contentEl, "Passphrase");
    if (this.options.cachedPassphrase) {
      passphrase.value = this.options.cachedPassphrase;
    }
    const confirm = this.options.action === "sign" ? createPasswordInput(contentEl, "Confirm passphrase") : null;
    const remember = contentEl.createEl("label", { cls: "lotus-signing-session-cache" });
    const rememberInput = remember.createEl("input", { attr: { type: "checkbox" } });
    remember.createSpan({ text: "Keep in memory until Obsidian reloads" });
    const error = contentEl.createDiv({ cls: "setting-item-description" });
    this.renderActions(contentEl, () => {
      if (!passphrase.value) {
        error.setText("Passphrase is required.");
        return;
      }
      if (confirm && passphrase.value !== confirm.value) {
        error.setText("Passphrases do not match.");
        return;
      }
      this.submit({ mode: "passphrase", passphrase: passphrase.value, rememberForSession: rememberInput.checked });
    });
  }

  private renderRsaForm(contentEl: HTMLElement): void {
    contentEl.createEl("p", {
      text: this.options.hasPrivateKeyPath
        ? "Lotus will read the configured private key file for signing. Enter a key passphrase only if the key is encrypted."
        : "Paste an RSA private key PEM. The private key is used for this signing operation and is not stored.",
    });
    const privateKey = this.options.hasPrivateKeyPath
      ? null
      : contentEl.createEl("textarea", {
        cls: "lotus-signing-key-input",
        attr: {
          rows: "8",
          placeholder: "-----begin private key-----",
        },
      });
    const keyPassphrase = createPasswordInput(contentEl, "Private key passphrase, if encrypted");
    const error = contentEl.createDiv({ cls: "setting-item-description" });
    this.renderActions(contentEl, () => {
      if (privateKey && !privateKey.value.trim()) {
        error.setText("Private key pem is required unless a private key file is configured.");
        return;
      }
      this.submit({
        mode: "rsa",
        privateKeyPem: privateKey?.value,
        privateKeyPassphrase: keyPassphrase.value,
      });
    });
  }

  private renderActions(contentEl: HTMLElement, submit: () => void): void {
    const actions = contentEl.createDiv({ cls: "lotus-modal-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    const submitButton = actions.createEl("button", { text: this.options.action === "sign" ? "Sign" : "Verify", cls: "mod-cta" });
    cancelButton.addEventListener("click", () => this.close());
    submitButton.addEventListener("click", submit);
  }

  private submit(material: lotusSignatureMaterial): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.options.onSubmit(material);
    this.close();
  }
}

function createPasswordInput(container: HTMLElement, placeholder: string): HTMLInputElement {
  const input = container.createEl("input", {
    attr: {
      type: "password",
      placeholder,
    },
  });
  input.addClass("lotus-signing-password-input");
  return input;
}
