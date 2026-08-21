import { spawn } from "child_process";
import { constants, createHmac, createPrivateKey, createPublicKey, pbkdf2Sync, randomBytes, sign as cryptoSign, timingSafeEqual, verify as cryptoVerify } from "crypto";
import { closeSync, openSync } from "fs";
import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { sha256Hash } from "./utils/hash";

export type lotusSignatureScheme = "passphrase-hmac-sha256" | "rsa-pss-sha256" | "openssh-sshsig";

export interface lotusSignatureRecord {
  version: 1;
  scope: "note";
  scheme: lotusSignatureScheme;
  signedAt: string;
  signer?: string;
  keyId: string;
  payloadHash: string;
  signature: string;
  ssh?: {
    namespace: string;
    signerIdentity: string;
  };
  kdf?: {
    name: "pbkdf2-sha256";
    iterations: number;
    salt: string;
  };
}

const PASSPHRASE_KDF_ITERATIONS = 600_000;
const PASSPHRASE_KEY_BYTES = 32;
const RSA_PSS_SALT_BYTES = 32;

export function createPassphraseSignature(payload: string, passphrase: string, signer?: string): lotusSignatureRecord {
  const salt = randomBytes(16);
  const key = derivePassphraseKey(passphrase, salt, PASSPHRASE_KDF_ITERATIONS);
  return {
    version: 1,
    scope: "note",
    scheme: "passphrase-hmac-sha256",
    signedAt: new Date().toISOString(),
    signer: normalizeOptionalString(signer),
    keyId: `pbkdf2:${sha256Hash(salt.toString("base64")).slice(0, 24)}`,
    payloadHash: sha256Hash(payload),
    signature: createHmac("sha256", key).update(payload).digest("base64"),
    kdf: {
      name: "pbkdf2-sha256",
      iterations: PASSPHRASE_KDF_ITERATIONS,
      salt: salt.toString("base64"),
    },
  };
}

export function verifyPassphraseSignature(record: lotusSignatureRecord, payload: string, passphrase: string): boolean {
  if (record.scheme !== "passphrase-hmac-sha256" || record.kdf?.name !== "pbkdf2-sha256") {
    return false;
  }
  if (record.payloadHash !== sha256Hash(payload)) {
    return false;
  }

  const salt = Buffer.from(record.kdf.salt, "base64");
  const key = derivePassphraseKey(passphrase, salt, record.kdf.iterations);
  return timingSafeBase64Equal(record.signature, createHmac("sha256", key).update(payload).digest("base64"));
}

export function createRsaSignature(payload: string, privateKeyPem: string, privateKeyPassphrase: string | undefined, signer?: string): lotusSignatureRecord {
  const privateKey = createPrivateKey({
    key: privateKeyPem,
    passphrase: normalizeOptionalString(privateKeyPassphrase),
  });
  const publicKeyPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();

  return {
    version: 1,
    scope: "note",
    scheme: "rsa-pss-sha256",
    signedAt: new Date().toISOString(),
    signer: normalizeOptionalString(signer),
    keyId: `rsa:${sha256Hash(publicKeyPem).slice(0, 32)}`,
    payloadHash: sha256Hash(payload),
    signature: cryptoSign("sha256", Buffer.from(payload, "utf8"), {
      key: privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: RSA_PSS_SALT_BYTES,
    }).toString("base64"),
  };
}

export function verifyRsaSignature(record: lotusSignatureRecord, payload: string, publicKeyPem: string): boolean {
  if (record.scheme !== "rsa-pss-sha256" || record.payloadHash !== sha256Hash(payload)) {
    return false;
  }

  return cryptoVerify("sha256", Buffer.from(payload, "utf8"), {
    key: publicKeyPem,
    padding: constants.RSA_PKCS1_PSS_PADDING,
    saltLength: RSA_PSS_SALT_BYTES,
  }, Buffer.from(record.signature, "base64"));
}

export async function createOpenSshSignature(
  payload: string,
  keyFile: string,
  namespace: string,
  signerIdentity: string,
  keyId: string,
  env?: NodeJS.ProcessEnv,
): Promise<lotusSignatureRecord> {
  const useAgent = keyFile.endsWith(".pub");
  const tempDir = await mkdtemp(join(tmpdir(), "lotus-sshsig-sign-"));
  let signature = "";
  try {
    const payloadPath = join(tempDir, "payload");
    const signaturePath = `${payloadPath}.sig`;
    await writeFile(payloadPath, payload, "utf8");
    await runSshKeygen(["-Y", "sign", ...(useAgent ? ["-U"] : []), "-O", "hashalg=sha256", "-f", keyFile, "-n", namespace, payloadPath], env);
    signature = (await readFile(signaturePath, "utf8")).trim();
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  return {
    version: 1,
    scope: "note",
    scheme: "openssh-sshsig",
    signedAt: new Date().toISOString(),
    signer: signerIdentity,
    keyId,
    payloadHash: sha256Hash(payload),
    signature,
    ssh: {
      namespace,
      signerIdentity,
    },
  };
}

export async function verifyOpenSshSignature(
  record: lotusSignatureRecord,
  payload: string,
  allowedSigners: string,
): Promise<boolean> {
  if (record.scheme !== "openssh-sshsig" || record.payloadHash !== sha256Hash(payload) || !record.ssh) {
    return false;
  }

  const tempDir = await mkdtemp(join(tmpdir(), "lotus-sshsig-"));
  try {
    const payloadPath = join(tempDir, "payload");
    const signaturePath = join(tempDir, "signature.sig");
    const allowedSignersPath = join(tempDir, "allowed-signers");
    await writeFile(payloadPath, payload, "utf8");
    await writeFile(signaturePath, record.signature.endsWith("\n") ? record.signature : `${record.signature}\n`, "utf8");
    await writeFile(allowedSignersPath, allowedSigners, "utf8");
    await runSshKeygenWithFileInput(
      ["-Y", "verify", "-f", allowedSignersPath, "-I", record.ssh.signerIdentity, "-n", record.ssh.namespace, "-s", signaturePath],
      payloadPath,
    );
    return true;
  } catch {
    return false;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

export function readSignatureRecord(value: unknown): lotusSignatureRecord | null {
  if (!isRecord(value) || value.version !== 1 || value.scope !== "note") {
    return null;
  }

  const scheme = value.scheme === "passphrase-hmac-sha256" || value.scheme === "rsa-pss-sha256" || value.scheme === "openssh-sshsig"
    ? value.scheme
    : null;
  if (!scheme || typeof value.signedAt !== "string" || typeof value.keyId !== "string" || typeof value.payloadHash !== "string" || typeof value.signature !== "string") {
    return null;
  }

  const record: lotusSignatureRecord = {
    version: 1,
    scope: "note",
    scheme,
    signedAt: value.signedAt,
    signer: typeof value.signer === "string" ? value.signer : undefined,
    keyId: value.keyId,
    payloadHash: value.payloadHash,
    signature: value.signature,
  };
  if (scheme === "passphrase-hmac-sha256") {
    const kdf = isRecord(value.kdf) ? value.kdf : {};
    if (kdf.name !== "pbkdf2-sha256" || typeof kdf.salt !== "string") {
      return null;
    }
    const iterations = typeof kdf.iterations === "number" ? kdf.iterations : Number.parseInt(String(kdf.iterations ?? ""), 10);
    if (!Number.isInteger(iterations) || iterations < 100_000) {
      return null;
    }
    record.kdf = {
      name: "pbkdf2-sha256",
      iterations,
      salt: kdf.salt,
    };
  }
  if (scheme === "openssh-sshsig") {
    const ssh = isRecord(value.ssh) ? value.ssh : {};
    if (typeof ssh.namespace !== "string" || typeof ssh.signerIdentity !== "string") {
      return null;
    }
    record.ssh = {
      namespace: ssh.namespace,
      signerIdentity: ssh.signerIdentity,
    };
  }

  return record;
}

async function runSshKeygen(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return await runSshKeygenProcess(args, "ignore", env);
}

async function runSshKeygenWithFileInput(args: string[], inputPath: string): Promise<string> {
  const fd = openSync(inputPath, "r");
  try {
    return await runSshKeygenProcess(args, fd);
  } finally {
    closeSync(fd);
  }
}

async function runSshKeygenProcess(args: string[], stdin: "ignore" | number, env?: NodeJS.ProcessEnv): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn("ssh-keygen", args, {
      stdio: [stdin, "pipe", "pipe"],
      env,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(formatSshKeygenSpawnError(error));
    });
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `ssh-keygen exited with ${code}`));
      }
    });
  });
}

function derivePassphraseKey(passphrase: string, salt: Buffer, iterations: number): Buffer {
  return pbkdf2Sync(passphrase, salt, iterations, PASSPHRASE_KEY_BYTES, "sha256");
}

function formatSshKeygenSpawnError(error: unknown): Error {
  if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT") {
    return new Error("ssh-keygen executable not found. OpenSSH signing requires ssh-keygen in PATH.");
  }
  return error instanceof Error ? error : new Error(String(error));
}

function timingSafeBase64Equal(left: string, right: string): boolean {
  const leftBytes = Buffer.from(left, "base64");
  const rightBytes = Buffer.from(right, "base64");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
