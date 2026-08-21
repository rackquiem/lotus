import { existsSync } from "fs";
import { load as parseYaml } from "js-yaml";
import { readFile, readdir } from "fs/promises";
import path from "path";
import process from "process";
import { DEFAULT_SETTINGS } from "../src/engine/defaultSettings";
import {
  createReproducibilitySnapshot,
  createSignaturePayload,
  readStoredSignatureValue,
  setFrontmatterYamlParser,
  stableStringify,
} from "../src/engine/reproducibility";
import {
  readSignatureRecord,
  verifyOpenSshSignature,
  verifyPassphraseSignature,
  verifyRsaSignature,
  type lotusSignatureRecord,
} from "../src/engine/signing";
import { sha256Hash } from "../src/engine/utils/hash";
import type { lotusPluginSettings } from "../src/engine/types";

setFrontmatterYamlParser((input) => parseYaml(input));

interface VerifyArgs {
  vault: string;
  passphrase?: string;
  publicKey?: string;
  publicKeyFile?: string;
  allowedSigners?: string;
  allowedSignersFile?: string;
  sshNamespace?: string;
  json: boolean;
  allowMissing: boolean;
}

interface VerificationFailure {
  path: string;
  status: "missing" | "changed" | "failed" | "unsupported";
  message: string;
}

interface VerificationResult {
  path: string;
  signature: lotusSignatureRecord;
  payloadHash: string;
}

const args = readArgs(process.argv.slice(2));
const vaultRoot = path.resolve(args.vault);
const settings = await readSettings(vaultRoot);
const markdownFiles = await listMarkdownFiles(vaultRoot);
const results: VerificationResult[] = [];
const failures: VerificationFailure[] = [];

for (const filePath of markdownFiles) {
  const source = await readFile(filePath, "utf8");
  const relativePath = normalizeVaultPath(path.relative(vaultRoot, filePath));
  const signature = readSignatureRecord(readStoredSignatureValue(source));
  if (!signature) {
    if (!args.allowMissing) {
      failures.push({ path: relativePath, status: "missing", message: "missing lotus-signature frontmatter" });
    }
    continue;
  }

  const snapshot = createReproducibilitySnapshot(relativePath, source, settings);
  const payloadText = stableStringify(createSignaturePayload(snapshot));
  const payloadHash = sha256Hash(payloadText);
  if (signature.payloadHash !== payloadHash) {
    failures.push({
      path: relativePath,
      status: "changed",
      message: `payload changed: stored=${signature.payloadHash.slice(0, 12)} current=${payloadHash.slice(0, 12)}`,
    });
    continue;
  }

  const verified = await verifySignature(signature, payloadText, vaultRoot, settings, args);
  if (!verified.ok) {
    failures.push({ path: relativePath, status: verified.status, message: verified.message });
    continue;
  }

  results.push({ path: relativePath, signature, payloadHash });
}

if (args.json) {
  console.log(JSON.stringify({
    verified: results.length,
    checked: markdownFiles.length,
    failed: failures.length,
    failures,
    results: results.map((result) => ({
      path: result.path,
      scheme: result.signature.scheme,
      keyId: result.signature.keyId,
      payloadHash: result.payloadHash,
    })),
  }, null, 2));
} else {
  for (const failure of failures) {
    console.error(`${failure.path}: ${failure.status}: ${failure.message}`);
  }
  console.log(`lotus verified ${results.length}/${markdownFiles.length} note signature${results.length === 1 ? "" : "s"}; ${failures.length} failed.`);
}

process.exitCode = failures.length ? 1 : 0;

async function verifySignature(
  signature: lotusSignatureRecord,
  payloadText: string,
  vaultRoot: string,
  settings: lotusPluginSettings,
  args: VerifyArgs,
): Promise<{ ok: true } | { ok: false; status: "failed" | "unsupported"; message: string }> {
  if (signature.scheme === "passphrase-hmac-sha256") {
    const passphrase = args.passphrase ?? process.env.LOTUS_SIGNATURE_PASSPHRASE;
    if (!passphrase) {
      return { ok: false, status: "unsupported", message: "passphrase signature requires --passphrase or LOTUS_SIGNATURE_PASSPHRASE" };
    }
    return verifyPassphraseSignature(signature, payloadText, passphrase)
      ? { ok: true }
      : { ok: false, status: "failed", message: "passphrase HMAC check failed" };
  }

  if (signature.scheme === "rsa-pss-sha256") {
    const publicKey = await readPublicKey(vaultRoot, settings, args);
    if (!publicKey) {
      return { ok: false, status: "unsupported", message: "RSA signature requires --public-key-file, --public-key, or Lotus public-key settings" };
    }
    return verifyRsaSignature(signature, payloadText, publicKey)
      ? { ok: true }
      : { ok: false, status: "failed", message: "RSA-PSS check failed" };
  }

  if (signature.scheme === "openssh-sshsig") {
    const namespace = args.sshNamespace ?? settings.signingSshNamespace;
    if (signature.ssh?.namespace !== namespace) {
      return {
        ok: false,
        status: "failed",
        message: `OpenSSH namespace mismatch: stored=${signature.ssh?.namespace ?? "(missing)"} expected=${namespace}`,
      };
    }
    const allowedSigners = await readAllowedSigners(vaultRoot, settings, args);
    if (!allowedSigners) {
      return { ok: false, status: "unsupported", message: "OpenSSH signature requires --allowed-signers-file, --allowed-signers, or Lotus allowed-signers settings" };
    }
    return await verifyOpenSshSignature(signature, payloadText, allowedSigners)
      ? { ok: true }
      : { ok: false, status: "failed", message: "OpenSSH SSHSIG check failed" };
  }

  return { ok: false, status: "unsupported", message: `unsupported signature scheme: ${signature.scheme}` };
}

async function readSettings(vaultRoot: string): Promise<lotusPluginSettings> {
  const settingsPath = path.join(vaultRoot, ".obsidian", "plugins", "lotus", "data.json");
  if (!existsSync(settingsPath)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    return {
      ...DEFAULT_SETTINGS,
      ...JSON.parse(await readFile(settingsPath, "utf8")),
    } as lotusPluginSettings;
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

async function readPublicKey(vaultRoot: string, settings: lotusPluginSettings, args: VerifyArgs): Promise<string | null> {
  if (args.publicKey) {
    return args.publicKey;
  }
  const configuredPath = args.publicKeyFile ?? settings.signingPublicKeyPath.trim();
  if (configuredPath) {
    return await readConfiguredTextPath(vaultRoot, configuredPath);
  }
  return settings.signingPublicKey.trim() || null;
}

async function readAllowedSigners(vaultRoot: string, settings: lotusPluginSettings, args: VerifyArgs): Promise<string | null> {
  if (args.allowedSigners) {
    return args.allowedSigners;
  }
  const configuredPath = args.allowedSignersFile ?? settings.signingSshAllowedSignersPath.trim();
  if (configuredPath) {
    return await readConfiguredTextPath(vaultRoot, configuredPath);
  }
  return settings.signingSshAllowedSigners.trim() || null;
}

async function readConfiguredTextPath(vaultRoot: string, configuredPath: string): Promise<string> {
  const resolvedPath = path.isAbsolute(configuredPath)
    ? configuredPath
    : path.join(vaultRoot, configuredPath);
  return await readFile(resolvedPath, "utf8");
}

async function listMarkdownFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  await walk(root, files);
  return files.sort();
}

async function walk(dir: string, files: string[]): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".obsidian" || entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walk(fullPath, files);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) {
      files.push(fullPath);
    }
  }
}

function readArgs(argv: string[]): VerifyArgs {
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json" || arg === "--allow-missing") {
      values[arg.slice(2)] = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      values.vault ??= arg;
      continue;
    }
    const key = arg.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    values[key] = next;
    i += 1;
  }

  const vault = readString(values.vault) ?? readString(values["vault"]);
  if (!vault) {
    throw new Error("Usage: node scripts/verify-signatures.mjs --vault /path/to/vault [--passphrase value] [--public-key-file path] [--allowed-signers-file path]");
  }

  return {
    vault,
    passphrase: readString(values.passphrase),
    publicKey: readString(values["public-key"]),
    publicKeyFile: readString(values["public-key-file"]),
    allowedSigners: readString(values["allowed-signers"]),
    allowedSignersFile: readString(values["allowed-signers-file"]),
    sshNamespace: readString(values["ssh-namespace"]),
    json: values.json === true,
    allowMissing: values["allow-missing"] === true,
  };
}

function normalizeVaultPath(value: string): string {
  return value.split(path.sep).join("/");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
