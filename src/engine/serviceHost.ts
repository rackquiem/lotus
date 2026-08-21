import type { lotusPluginSettings, lotusRunFile } from "./types";
import type { lotusVaultHost } from "./vaultHost";
import type { lotusSignatureMaterial } from "./signingService";

export const EXECUTION_DISABLED_MESSAGE = "Lotus local execution is disabled. Enable it in settings or confirm the execution warning first.";

export interface lotusServiceHost {
  readonly vault: lotusVaultHost;
  getSettings(): lotusPluginSettings;
  notify(message: string, timeoutMs?: number): void;
}

export interface lotusRunCoordinatorHost extends lotusServiceHost {
  ensureExecutionEnabled(): Promise<boolean>;
  onOutputChanged(blockId: string): void;
  onRunStateChanged(): void;
  currentNotePath(): string | null;
  onRunStarted?(file: lotusRunFile): void;
}

export interface lotusSigningHost extends lotusServiceHost {
  requestSignatureMaterial(title: string, mode: "passphrase" | "rsa" | "ssh", action: "sign" | "verify"): Promise<lotusSignatureMaterial | null>;
}
