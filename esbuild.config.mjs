import esbuild from "esbuild";
import process from "process";
import fs from "fs";
import path from "path";
import os from "os";

const buildArgs = process.argv.slice(2);
const prod = buildArgs.includes("production") || readFlag("production");
const sourcemap = readBooleanOption("sourcemap", "LOTUS_SOURCEMAP");
const compileMode = normalizeCompileMode(
  readOption("compile-mode")
  ?? readOption("compile")
  ?? readOption("mode")
  ?? process.env.LOTUS_COMPILE_MODE
  ?? process.env.LOTUS_COMPILE
  ?? (readFlag("light") ? "light" : readFlag("strict") ? "strict" : "strict"),
);
const lightLanguages = readListOption("languages", "LOTUS_LIGHT_LANGUAGES");
const lightLanguagePacks = readListOption("language-packs", "LOTUS_LIGHT_LANGUAGE_PACKS");
const lightFeatures = readListOption("features", "LOTUS_LIGHT_FEATURES");
const lightContainerGroups = readListOption("container-groups", "LOTUS_LIGHT_CONTAINER_GROUPS");
const lightContainerRuntimes = readListOption("container-runtimes", "LOTUS_LIGHT_CONTAINER_RUNTIMES");
const forceLogging = readBooleanOption("force-logging", "LOTUS_FORCE_LOGGING");
const machineHashScope = normalizeMachineHashScope(readOption("machine-hash-scope") ?? process.env.LOTUS_MACHINE_HASH_SCOPE ?? "");
const pluginName = "lotus";
const explicitDeployDirs = [
  ...(process.env.LOTUS_PLUGIN_DIRS ?? "")
    .split(path.delimiter)
    .map((value) => value.trim())
    .filter(Boolean)
];

console.log(`Building lotus compile profile: ${formatCompileProfile()}`);

await esbuild.build({
  entryPoints: ["src/plugin/main.ts"],
  bundle: true,
  outfile: "main.js",
  format: "cjs",
  platform: "node",
  target: "es2021",
  sourcemap: sourcemap ? "inline" : false,
  minify: prod,
  legalComments: "none",
  external: [
    "obsidian",
    "electron",
    "@codemirror/state",
    "@codemirror/view",
    "@codemirror/language",
  ],
  alias: {
    "elkjs": "./node_modules/elkjs/lib/elk.bundled.js",
    "lie": "./stubs/lie.js",
    "setimmediate": "./stubs/setimmediate.js",
  },
  define: {
    __LOTUS_COMPILE_MODE__: JSON.stringify(compileMode),
    __LOTUS_LIGHT_LANGUAGES__: JSON.stringify(lightLanguages),
    __LOTUS_LIGHT_LANGUAGE_PACKS__: JSON.stringify(lightLanguagePacks),
    __LOTUS_LIGHT_FEATURES__: JSON.stringify(lightFeatures),
    __LOTUS_LIGHT_CONTAINER_GROUPS__: JSON.stringify(lightContainerGroups),
    __LOTUS_LIGHT_CONTAINER_RUNTIMES__: JSON.stringify(lightContainerRuntimes),
    __LOTUS_FORCE_LOGGING__: JSON.stringify(forceLogging),
    __LOTUS_MACHINE_HASH_SCOPE__: JSON.stringify(machineHashScope),
  },
  logLevel: "info",
});

try {
  const deployDirs = explicitDeployDirs.length ? explicitDeployDirs : discoverVaultPluginDirs(pluginName);

  if (!deployDirs.length) {
    console.warn("No Obsidian vault plugin directories found for deployment.");
  }

  for (const deployDir of deployDirs) {
    fs.mkdirSync(deployDir, { recursive: true });
    fs.copyFileSync("main.js", path.join(deployDir, "main.js"));
    fs.copyFileSync("manifest.json", path.join(deployDir, "manifest.json"));
    if (fs.existsSync("styles.css")) {
      fs.copyFileSync("styles.css", path.join(deployDir, "styles.css"));
    }
    copyDirectoryIfPresent("syntaxes", path.join(deployDir, "syntaxes"));
    copyDirectoryIfPresent("language-packs", path.join(deployDir, "language-packs"));
    console.log(`Deployed build to ${deployDir}`);
  }
} catch (err) {
  console.error("Failed to copy built files to vault plugin directory:", err);
}

function discoverVaultPluginDirs(pluginDirName) {
  const homeDir = os.homedir();
  const candidates = new Set();
  const obsidianDirs = [
    path.join(homeDir, ".obsidian"),
    ...findNestedObsidianDirs(homeDir),
  ];

  for (const obsidianDir of obsidianDirs) {
    candidates.add(path.join(obsidianDir, "plugins", pluginDirName));
  }

  return [...candidates].filter((candidate) => {
    const parent = path.dirname(candidate);
    return fs.existsSync(parent);
  });
}

function findNestedObsidianDirs(homeDir) {
  const results = [];
  for (const entry of fs.readdirSync(homeDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) {
      continue;
    }

    const candidate = path.join(homeDir, entry.name, ".obsidian");
    if (fs.existsSync(candidate)) {
      results.push(candidate);
    }
  }

  return results;
}

function copyDirectoryIfPresent(sourceDir, destinationDir) {
  if (!fs.existsSync(sourceDir)) {
    return;
  }

  fs.rmSync(destinationDir, { recursive: true, force: true });
  fs.mkdirSync(destinationDir, { recursive: true });

  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const destinationPath = path.join(destinationDir, entry.name);
    if (entry.isDirectory()) {
      copyDirectoryIfPresent(sourcePath, destinationPath);
      continue;
    }
    fs.copyFileSync(sourcePath, destinationPath);
  }
}

function readOption(name) {
  const prefix = `--${name}=`;
  const inline = buildArgs.find((arg) => arg.startsWith(prefix));
  if (inline) {
    return inline.slice(prefix.length);
  }

  const index = buildArgs.indexOf(`--${name}`);
  if (index >= 0 && buildArgs[index + 1] && !buildArgs[index + 1].startsWith("--")) {
    return buildArgs[index + 1];
  }
  return undefined;
}

function readFlag(name) {
  return buildArgs.includes(`--${name}`);
}

function readListOption(name, envName) {
  return normalizeList(readOption(name) ?? process.env[envName] ?? "");
}

function readBooleanOption(name, envName) {
  const raw = readOption(name) ?? process.env[envName];
  if (raw != null) {
    return ["1", "true", "yes", "on", "force", "forced"].includes(String(raw).trim().toLowerCase());
  }
  return readFlag(name);
}

function normalizeCompileMode(value) {
  return String(value ?? "").trim().toLowerCase() === "light" ? "light" : "strict";
}

function normalizeMachineHashScope(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  return ["install", "vault", "install-vault"].includes(normalized) ? normalized : "";
}

function normalizeList(value) {
  return String(value ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean)
    .filter((entry, index, entries) => entries.indexOf(entry) === index);
}

function formatCompileProfile() {
  if (compileMode === "strict") {
    return `STRICT${formatAuditProfileSummary()}`;
  }
  const pieces = [
    "LIGHT",
    `languages=${lightLanguages.length ? lightLanguages.join(",") : "all"}`,
    `language-packs=${lightLanguagePacks.length ? lightLanguagePacks.join(",") : "all"}`,
    `features=${lightFeatures.length ? lightFeatures.join(",") : "all"}`,
    `container-groups=${lightContainerGroups.length ? lightContainerGroups.join(",") : "all"}`,
    `container-runtimes=${lightContainerRuntimes.length ? lightContainerRuntimes.join(",") : "all"}`,
  ];
  if (forceLogging) {
    pieces.push("force-logging=true");
  }
  if (machineHashScope) {
    pieces.push(`machine-hash-scope=${machineHashScope}`);
  }
  return pieces.join("; ");
}

function formatAuditProfileSummary() {
  const pieces = [];
  if (forceLogging) {
    pieces.push("force-logging=true");
  }
  if (machineHashScope) {
    pieces.push(`machine-hash-scope=${machineHashScope}`);
  }
  return pieces.length ? `; ${pieces.join("; ")}` : "";
}
