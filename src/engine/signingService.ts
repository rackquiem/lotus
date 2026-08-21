
import { readNoteOrThrow, type lotusNoteInfo } from "./vaultHost";
import { normalizeVaultPath } from "./utils/vaultPath";
import type { lotusSigningHost } from "./serviceHost";
import type { lotusEventLog } from "./eventLog";
import type { lotusReproducibilityService } from "./reproducibilityService";

export interface lotusSignatureMaterial {
  mode: "passphrase" | "rsa" | "ssh";
  passphrase?: string;
  privateKeyPem?: string;
  privateKeyPassphrase?: string;
  rememberForSession?: boolean;
}

export interface lotusBatchSignatureSummary {
  count: number;
  total: number;
  failures: string[];
  summary: string;
}
import { readFile } from "fs/promises";
import { isAbsolute, join } from "path";
import { homedir } from "os";
import { sha256Hash } from "./utils/hash";
import { formatErrorMessage } from "./utils/errors";
import { createOpenSshSignature, createPassphraseSignature, createRsaSignature, readSignatureRecord, verifyOpenSshSignature, verifyPassphraseSignature, verifyRsaSignature, type lotusSignatureRecord } from "./signing";
import { CODE_BLOCK_HASHES_FRONTMATTER_KEY, NOTE_HASH_FRONTMATTER_KEY, REPRODUCIBILITY_FRONTMATTER_KEY, SIGNATURE_FRONTMATTER_KEY, createSignaturePayload as buildSignaturePayload, readStoredSignatureValue, stableStringify, type lotusReproducibilitySnapshot, type lotusSignaturePayload } from "./reproducibility";
import type { lotusPluginSettings, lotusRunFile } from "./types";

export class lotusSigningService {
  constructor(
    private readonly host: lotusSigningHost,
    private readonly events: lotusEventLog,
    private readonly reproducibility: lotusReproducibilityService,
  ) {}

  private get settings(): lotusPluginSettings {
    return this.host.getSettings();
  }

  async signNote(file: lotusRunFile, material: lotusSignatureMaterial): Promise<lotusSignatureRecord> {
    const source = await readNoteOrThrow(this.host.vault, file.path);
    const snapshot = this.reproducibility.createReproducibilitySnapshot(file.path, source);
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

    await this.host.vault.processFrontmatter(file.path, (frontmatter) => {
      const target = frontmatter;
      target[REPRODUCIBILITY_FRONTMATTER_KEY] = snapshot;
      target[NOTE_HASH_FRONTMATTER_KEY] = snapshot.noteHash;
      target[CODE_BLOCK_HASHES_FRONTMATTER_KEY] = snapshot.blocks;
      target[SIGNATURE_FRONTMATTER_KEY] = signature;
    });
    await this.events.logEvent({
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
    await this.events.logEvent({
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

  createSignaturePayload(snapshot: lotusReproducibilitySnapshot): lotusSignaturePayload {
    return buildSignaturePayload(snapshot);
  }

  async verifyNoteSignature(file: lotusRunFile, source: string, signature: lotusSignatureRecord, material?: lotusSignatureMaterial): Promise<{ verified: boolean; summary: string }> {
    const snapshot = this.reproducibility.createReproducibilitySnapshot(file.path, source);
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
    await this.events.logEvent({
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

  async resolvePrivateKeyPem(material: lotusSignatureMaterial): Promise<string> {
    const pasted = material.privateKeyPem?.trim();
    if (pasted) {
      return pasted;
    }
    throw new Error("No RSA private key was provided.");
  }

  async resolvePublicKeyPem(): Promise<string> {
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

  async resolveSshSigningKeyPath(): Promise<string> {
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

  async createSshKeyId(): Promise<string> {
    const configuredPath = this.settings.signingSshKeyPath.trim();
    if (!configuredPath) {
      return `ssh:${sha256Hash(this.readSshSignerIdentity()).slice(0, 32)}`;
    }
    const publicKey = await this.readOpenSshPublicKeyForPath(configuredPath);
    return `ssh:${sha256Hash(publicKey ?? configuredPath).slice(0, 32)}`;
  }

  async resolveSshAllowedSigners(signature: lotusSignatureRecord): Promise<string> {
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

  async resolveOpenSshPublicKey(): Promise<string> {
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

  async readOpenSshPublicKeyForPath(rawPath: string): Promise<string | null> {
    const resolved = this.resolveConfiguredFsPath(rawPath);
    const candidates = resolved.endsWith(".pub") ? [resolved] : [`${resolved}.pub`, resolved];
    for (const candidate of candidates) {
      try {
        const text = isAbsolute(candidate)
          ? await readFile(candidate, "utf8")
          : await this.host.vault.read(candidate);
        if (/^(ssh|ecdsa)-[A-Za-z0-9@.-]+\s+[A-Za-z0-9+/=]+/.test(text.trim())) {
          return text.trim();
        }
      } catch {
        // Try the next public key candidate.
      }
    }
    return null;
  }

  readSshSignerIdentity(): string {
    const signer = this.settings.signingSignerId.trim();
    return signer || "lotus-signer";
  }

  createSigningSshEnv(): NodeJS.ProcessEnv | undefined {
    const authSock = this.settings.signingSshAuthSock.trim();
    return authSock ? { ...process.env, SSH_AUTH_SOCK: authSock } : undefined;
  }

  async readConfiguredTextPath(rawPath: string): Promise<string> {
    const expanded = this.resolveConfiguredFsPath(rawPath);
    if (isAbsolute(expanded)) {
      return await readFile(expanded, "utf8");
    }
    return await this.host.vault.read(normalizeVaultPath(expanded));
  }

  resolveConfiguredFsPath(rawPath: string): string {
    return rawPath.startsWith("~/") ? join(homedir(), rawPath.slice(2)) : normalizeVaultPath(rawPath);
  }

  resolveVaultRelativeFsPath(vaultPath: string): string {
    const basePath = this.host.vault.vaultBasePath;
    return basePath ? join(basePath, vaultPath) : vaultPath;
  }

  async signAllNotes(): Promise<void> {
    const material = await this.host.requestSignatureMaterial("Sign All Notes", this.settings.signingMode || "passphrase", "sign");
    if (!material) {
      return;
    }

    const files = this.host.vault.listNotes();
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
    await this.events.logEvent({
      type: "lotus.signature.all.created",
      message: summary,
      data: {
        signed,
        total: files.length,
        failures: failures.length,
      },
    });
    this.host.notify(summary, failures.length ? 12000 : 6000);
  }

  async verifyAllNoteSignatures(): Promise<void> {
    const files = this.host.vault.listNotes();
    const signatures = new Map<lotusNoteInfo, lotusSignatureRecord>();
    let needsPassphrase = false;
    for (const file of files) {
      const signature = readStoredSignature(await readNoteOrThrow(this.host.vault, file.path));
      if (signature) {
        signatures.set(file, signature);
        needsPassphrase = needsPassphrase || signature.scheme === "passphrase-hmac-sha256";
      }
    }

    const material = needsPassphrase
      ? await this.host.requestSignatureMaterial("Verify All Note Signatures", "passphrase", "verify")
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
      const source = await readNoteOrThrow(this.host.vault, file.path);
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
    await this.events.logEvent({
      type: "lotus.signature.all.verify.finished",
      message: summary,
      data: {
        verified,
        total: files.length,
        failures: failures.length,
      },
    });
    this.host.notify(summary, failures.length ? 12000 : 6000);
  }
}

export function readStoredSignature(source: string): lotusSignatureRecord | null {
  return readSignatureRecord(readStoredSignatureValue(source));
}

export function formatSignatureScheme(scheme: string): string {
  if (scheme === "rsa-pss-sha256") {
    return "RSA-PSS/SHA-256";
  }
  if (scheme === "openssh-sshsig") {
    return "OpenSSH SSHSIG";
  }
  return "passphrase HMAC/SHA-256";
}
