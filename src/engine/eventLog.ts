
import type { lotusVaultHost } from "./vaultHost";
import { lotusLogger, type lotusLogInput } from "./logging";
import { sha256Hash } from "./utils/hash";
import { canonicalizeNoteForHash } from "./reproducibility";

export class lotusEventLog {
  constructor(
    readonly logger: lotusLogger,
    private readonly vault: lotusVaultHost,
  ) {}

  async logEvent(input: lotusLogInput): Promise<void> {
    await this.logger.log(await this.enrichLogEvent(input));
  }

  async enrichLogEvent(input: lotusLogInput): Promise<lotusLogInput> {
    if (!input.notePath || input.noteHash) {
      return input;
    }

    const noteHash = await this.readCurrentNoteHash(input.notePath);
    return noteHash ? { ...input, noteHash } : input;
  }

  async readCurrentNoteHash(notePath: string): Promise<string | undefined> {
    try {
      const source = await this.vault.readNote(notePath);
      return source == null ? undefined : sha256Hash(canonicalizeNoteForHash(source));
    } catch (error) {
      console.warn("lotus: failed to compute note hash for log event", error);
      return undefined;
    }
  }
}
