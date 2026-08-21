
import { readNoteOrThrow, type lotusVaultHost } from "./vaultHost";
import type { lotusServiceHost } from "./serviceHost";
import type { lotusEventLog } from "./eventLog";
import { parseMarkdownCodeBlocks } from "./parser";
import { sha256Hash } from "./utils/hash";
import { isRecord } from "./utils/record";
import { CODE_BLOCK_HASHES_FRONTMATTER_KEY, HASH_POLICY_FRONTMATTER_KEY, NOTE_HASH_FRONTMATTER_KEY, REPRODUCIBILITY_FRONTMATTER_KEY, REPRODUCIBILITY_SNAPSHOT_VERSION, canonicalizeNoteForHash, compareCodeBlockHashEntries, createCodeBlockHashEntry as buildCodeBlockHashEntry, createReproducibilitySnapshot as buildReproducibilitySnapshot, getHashPolicyPresetDefinition, hashPolicyFromPreset, readHashPolicy, readStoredCodeBlockHashEntries, readStoredNoteHash, serializeHashPolicy, type lotusCodeBlockHashEntry, type lotusHashPolicy, type lotusHashPolicyPreset, type lotusReproducibilityStatus, type lotusReproducibilityVerification, type lotusReproducibilitySnapshot } from "./reproducibility";
import type { lotusCodeBlock, lotusPluginSettings, lotusRunFile } from "./types";

export class lotusReproducibilityService {
  constructor(
    private readonly host: lotusServiceHost,
    private readonly events: lotusEventLog,
  ) {}

  private get settings(): lotusPluginSettings {
    return this.host.getSettings();
  }

  async saveReproducibilitySnapshot(file: lotusRunFile): Promise<void> {
    const source = await readNoteOrThrow(this.host.vault, file.path);
    const snapshot = this.createReproducibilitySnapshot(file.path, source);

    await this.host.vault.processFrontmatter(file.path, (frontmatter) => {
      const target = frontmatter;
      target[REPRODUCIBILITY_FRONTMATTER_KEY] = snapshot;
      target[NOTE_HASH_FRONTMATTER_KEY] = snapshot.noteHash;
      target[CODE_BLOCK_HASHES_FRONTMATTER_KEY] = snapshot.blocks;
    });
    await this.events.logEvent({
      type: "lotus.repro.snapshot.saved",
      message: "Reproducibility snapshot saved",
      notePath: file.path,
      data: {
        noteHash: snapshot.noteHash,
        blocks: snapshot.blocks.length,
        policy: snapshot.policy.preset,
      },
    });
    await this.events.logEvent({
      type: "lotus.note.modified",
      message: "Wrote reproducibility snapshot frontmatter",
      notePath: file.path,
      data: {
        action: "reproducibility.snapshot.saved",
      },
    });

    this.host.notify(`lotus reproducibility snapshot saved (${snapshot.blocks.length} block${snapshot.blocks.length === 1 ? "" : "s"}).`);
  }

  async verifyReproducibilitySnapshot(file: lotusRunFile): Promise<void> {
    const source = await readNoteOrThrow(this.host.vault, file.path);
    const verification = this.createReproducibilityVerification(file.path, source);
    await this.writeReproducibilityVerification(file, verification);
    await this.events.logEvent({
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
    await this.events.logEvent({
      type: "lotus.note.modified",
      message: "Wrote reproducibility verification frontmatter",
      notePath: file.path,
      data: {
        action: "reproducibility.verify.finished",
        status: verification.status,
      },
    });
    this.host.notify(verification.summary, verification.status === "verified" ? 6000 : 12000);
  }

  async applyReproducibilityPolicyPreset(file: lotusRunFile, presetId: Exclude<lotusHashPolicyPreset, "custom">): Promise<void> {
    const policy = hashPolicyFromPreset(presetId);
    await this.host.vault.processFrontmatter(file.path, (frontmatter) => {
      const target = frontmatter;
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
    await this.events.logEvent({
      type: "lotus.note.modified",
      message: "Updated reproducibility policy",
      notePath: file.path,
      data: {
        action: "reproducibility.policy.changed",
        policy: presetId,
      },
    });
    this.host.notify(`lotus reproducibility policy set to ${getHashPolicyPresetDefinition(presetId).label}.`);
  }

  async hashCurrentNote(file: lotusRunFile): Promise<void> {
    const source = await readNoteOrThrow(this.host.vault, file.path);
    const noteHash = sha256Hash(canonicalizeNoteForHash(source));

    await this.host.vault.processFrontmatter(file.path, (frontmatter) => {
      const target = frontmatter;
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
    await this.events.logEvent({
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

    this.host.notify(`lotus note hash written: ${noteHash}`);
  }

  async verifyCurrentNoteHash(file: lotusRunFile): Promise<void> {
    const source = await readNoteOrThrow(this.host.vault, file.path);
    const storedHash = readStoredNoteHash(source);
    if (!storedHash) {
      this.host.notify("No Lotus-note-hash found. Run Lotus: Hash current note first.");
      return;
    }

    const currentHash = sha256Hash(canonicalizeNoteForHash(source));
    if (storedHash === currentHash) {
      this.host.notify("Lotus note hash verified.");
      return;
    }

    this.host.notify(`lotus note hash mismatch. stored=${storedHash.slice(0, 12)} current=${currentHash.slice(0, 12)}`, 10000);
  }

  async verifyCodeBlockHashes(file: lotusRunFile): Promise<void> {
    const source = await readNoteOrThrow(this.host.vault, file.path);
    const storedEntries = readStoredCodeBlockHashEntries(source);
    if (!storedEntries.length) {
      this.host.notify("No Lotus-code-block-hashes found. Run Lotus: Hash current code block first.");
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
      this.host.notify(`lotus verified ${verified} code block hash${verified === 1 ? "" : "es"}.`);
      return;
    }

    this.host.notify(`lotus block hash verification failed: ${issues.slice(0, 4).join("; ")}${issues.length > 4 ? `; +${issues.length - 4} more` : ""}`, 12000);
  }

  createReproducibilitySnapshot(filePath: string, source: string): lotusReproducibilitySnapshot {
    return buildReproducibilitySnapshot(filePath, source, this.settings);
  }

  createReproducibilityVerification(filePath: string, source: string): lotusReproducibilityVerification {
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

  async writeReproducibilityVerification(file: lotusRunFile, verification: lotusReproducibilityVerification): Promise<void> {
    await this.host.vault.processFrontmatter(file.path, (frontmatter) => {
      const target = frontmatter;
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

  async writeCodeBlockHashesIfEnabled(file: lotusRunFile): Promise<void> {
    if (!this.settings.hashCodeBlocks) {
      return;
    }

    try {
      const entries = await this.writeCodeBlockHashesToFrontmatter(file);
      await this.events.logEvent({
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

  async writeCodeBlockHashesToFrontmatter(file: lotusRunFile, source?: string): Promise<lotusCodeBlockHashEntry[]> {
    const text = source ?? await readNoteOrThrow(this.host.vault, file.path);
    const policy = readHashPolicy(text);
    const entries = parseMarkdownCodeBlocks(file.path, text, this.settings)
      .map((block) => this.createCodeBlockHashEntry(block, policy));

    await this.host.vault.processFrontmatter(file.path, (frontmatter) => {
      const target = frontmatter;
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

  createCodeBlockHashEntry(block: lotusCodeBlock, policy: lotusHashPolicy): lotusCodeBlockHashEntry {
    return buildCodeBlockHashEntry(block, policy);
  }
}
