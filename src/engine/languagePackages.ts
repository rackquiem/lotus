import {
  isCompileCustomLanguagesAllowed,
  isCompileExternalLanguagePacksAllowed,
  isCompileLanguageAllowed,
  isCompileLanguagePackageAllowed,
} from "./buildProfile";
import type { lotusCustomLanguage, lotusNormalizedLanguage, lotusPluginSettings } from "./types";

export interface lotusLanguageDefinition {
  id: lotusNormalizedLanguage;
  displayName: string;
  aliases: string[];
}

export interface lotusLanguagePackage {
  id: string;
  displayName: string;
  description: string;
  languages: lotusLanguageDefinition[];
}

export const BUILT_IN_LANGUAGE_PACKAGES: lotusLanguagePackage[] = [
  {
    id: "interpreted",
    displayName: "Interpreted",
    description: "Script and REPL-oriented languages for operational notes and quick experiments.",
    languages: [
      { id: "python", displayName: "Python", aliases: ["python", "py"] },
      { id: "javascript", displayName: "JavaScript", aliases: ["javascript", "js"] },
      { id: "typescript", displayName: "TypeScript", aliases: ["typescript", "ts"] },
      { id: "shell", displayName: "Shell", aliases: ["shell", "sh", "bash", "zsh"] },
      { id: "ruby", displayName: "Ruby", aliases: ["ruby", "rb"] },
      { id: "perl", displayName: "Perl", aliases: ["perl", "pl"] },
      { id: "lua", displayName: "Lua", aliases: ["lua"] },
      { id: "php", displayName: "PHP", aliases: ["php"] },
      { id: "go", displayName: "Go", aliases: ["go", "golang"] },
      { id: "haskell", displayName: "Haskell", aliases: ["haskell", "hs"] },
      { id: "ocaml", displayName: "OCaml", aliases: ["ocaml", "ml"] },
    ],
  },
  {
    id: "obsidian-context",
    displayName: "Obsidian Context",
    description: "Explicit opt-in JavaScript that runs inside Obsidian with access to the vault, workspace, and plugin context.",
    languages: [
      { id: "obsidian-js", displayName: "Obsidian JavaScript", aliases: ["obsidian-js", "obsidianjs", "obsidian-javascript"] },
    ],
  },
  {
    id: "native-compiled",
    displayName: "Native Compiled",
    description: "Languages compiled into native binaries by local toolchains.",
    languages: [
      { id: "c", displayName: "C", aliases: ["c", "h"] },
      { id: "cpp", displayName: "C++", aliases: ["cpp", "cxx", "cc", "c++"] },
    ],
  },
  {
    id: "managed-compiled",
    displayName: "Managed Compiled",
    description: "Compiled languages with managed runtimes or structured build/run phases.",
    languages: [
      { id: "rust", displayName: "Rust", aliases: ["rust", "rs"] },
      { id: "java", displayName: "Java", aliases: ["java"] },
    ],
  },
  {
    id: "proofs",
    displayName: "Proofs",
    description: "Proof assistants and solver-oriented languages.",
    languages: [
      { id: "lean", displayName: "Lean", aliases: ["lean", "lean4"] },
      { id: "coq", displayName: "Coq", aliases: ["coq", "v"] },
      { id: "smtlib", displayName: "SMT-LIB", aliases: ["smt", "smt2", "smtlib", "smt-lib", "z3"] },
    ],
  },
  {
    id: "llvm",
    displayName: "LLVM",
    description: "LLVM IR tooling for compiler and PL research vaults.",
    languages: [
      { id: "llvm-ir", displayName: "LLVM IR", aliases: ["llvm", "llvmir", "llvm-ir", "ll"] },
    ],
  },
  {
    id: "ebpf",
    displayName: "eBPF",
    description: "Kernel instrumentation languages for BPF object compilation, verifier checks, and bpftrace scripts.",
    languages: [
      { id: "ebpf-c", displayName: "eBPF C", aliases: ["ebpf", "ebpf-c", "bpf-c", "bpf"] },
      { id: "bpftrace", displayName: "bpftrace", aliases: ["bpftrace", "bt"] },
    ],
  },
];

export const CUSTOM_LANGUAGE_PACKAGE_ID = "custom";
export const LANGUAGE_CONFIGURATION_VERSION = 3;

export function getDefaultLanguagePackIds(): string[] {
  return [
    ...getCompileAllowedBuiltInLanguagePackages().map((pack) => pack.id),
    ...(isCompileCustomLanguagesAllowed() ? [CUSTOM_LANGUAGE_PACKAGE_ID] : []),
  ];
}

export function getDefaultLanguageIds(): string[] {
  return getCompileAllowedBuiltInLanguagePackages().flatMap((pack) => pack.languages.map((language) => language.id));
}

export function normalizeLanguageConfiguration(settings: lotusPluginSettings): void {
  if (!Array.isArray(settings.externalLanguagePacks)) {
    settings.externalLanguagePacks = [];
  }
  if (!Array.isArray(settings.enabledLanguagePacks) || !settings.enabledLanguagePacks.length) {
    settings.enabledLanguagePacks = getDefaultLanguagePackIds();
  }
  if (!Array.isArray(settings.enabledLanguages) || !settings.enabledLanguages.length) {
    settings.enabledLanguages = getDefaultLanguageIds();
  }
  if (!Number.isFinite(settings.languageConfigurationVersion)) {
    settings.languageConfigurationVersion = 1;
  }
  if (settings.languageConfigurationVersion < 2) {
    enableLanguagePackage(settings, "ebpf");
  }
  if (settings.languageConfigurationVersion < 3) {
    enableLanguagePackage(settings, "obsidian-context");
  }
  settings.languageConfigurationVersion = LANGUAGE_CONFIGURATION_VERSION;
  filterDisallowedCompileSelections(settings);
}

function enableLanguagePackage(settings: lotusPluginSettings, packageId: string): void {
  const pack = BUILT_IN_LANGUAGE_PACKAGES.find((candidate) => candidate.id === packageId);
  if (!pack) {
    return;
  }
  appendUnique(settings.enabledLanguagePacks, pack.id);
  for (const language of pack.languages) {
    appendUnique(settings.enabledLanguages, language.id);
  }
}

function appendUnique(values: string[], value: string): void {
  if (!values.includes(value)) {
    values.push(value);
  }
}

function getCompileAllowedBuiltInLanguagePackages(): lotusLanguagePackage[] {
  return BUILT_IN_LANGUAGE_PACKAGES
    .filter((pack) => isCompileLanguagePackageAllowed(pack.id))
    .map((pack) => ({
      ...pack,
      languages: pack.languages.filter((language) => isCompileLanguageAllowed(language.id)),
    }))
    .filter((pack) => pack.languages.length > 0);
}

function filterDisallowedCompileSelections(settings: lotusPluginSettings): void {
  const allowedPackIds = new Set([
    ...getCompileAllowedBuiltInLanguagePackages().map((pack) => pack.id),
    ...(isCompileExternalLanguagePacksAllowed() ? settings.externalLanguagePacks.map((pack) => pack.id).filter((packId) => isCompileLanguagePackageAllowed(packId)) : []),
    ...(isCompileCustomLanguagesAllowed() ? [CUSTOM_LANGUAGE_PACKAGE_ID] : []),
  ]);
  const allowedLanguageIds = new Set([
    ...getDefaultLanguageIds(),
    ...(isCompileExternalLanguagePacksAllowed()
      ? settings.externalLanguagePacks.flatMap((pack) => pack.languages.map((language) => language.name).filter((name) => isCompileLanguageAllowed(name)))
      : []),
  ]);

  settings.enabledLanguagePacks = settings.enabledLanguagePacks.filter((packId) => allowedPackIds.has(packId));
  settings.enabledLanguages = settings.enabledLanguages.filter((languageId) => allowedLanguageIds.has(languageId));

  if (!settings.enabledLanguagePacks.length) {
    settings.enabledLanguagePacks = getDefaultLanguagePackIds();
  }
  if (!settings.enabledLanguages.length) {
    settings.enabledLanguages = getDefaultLanguageIds();
  }
}

export function getEnabledLanguageDefinitions(settings: lotusPluginSettings): lotusLanguageDefinition[] {
  normalizeLanguageConfiguration(settings);
  const enabledPacks = new Set(settings.enabledLanguagePacks);
  const enabledLanguages = new Set(settings.enabledLanguages);

  return getAvailableLanguagePackages(settings)
    .filter((pack) => enabledPacks.has(pack.id))
    .flatMap((pack) => pack.languages)
    .filter((language) => enabledLanguages.has(language.id));
}

export function getAvailableLanguagePackages(settings: lotusPluginSettings): lotusLanguagePackage[] {
  normalizeLanguageConfiguration(settings);
  return [
    ...getCompileAllowedBuiltInLanguagePackages(),
    ...(isCompileExternalLanguagePacksAllowed() ? settings.externalLanguagePacks ?? [] : []).filter((pack) => isCompileLanguagePackageAllowed(pack.id)).map((pack) => ({
      id: pack.id,
      displayName: pack.displayName,
      description: pack.description,
      languages: pack.languages.map((language) => ({
        id: language.name,
        displayName: language.displayName || language.name,
        aliases: parseAliasList(language.aliases),
      })).filter((language) => isCompileLanguageAllowed(language.id)),
    })).filter((pack) => pack.languages.length > 0),
  ];
}

export function getEnabledLanguageAliasMap(settings: lotusPluginSettings): Record<string, lotusNormalizedLanguage> {
  return Object.fromEntries(
    getEnabledLanguageDefinitions(settings).flatMap((language) =>
      language.aliases.map((alias) => [alias.toLowerCase(), language.id] as const),
    ),
  );
}

export function isLanguageEnabled(languageId: lotusNormalizedLanguage, settings: lotusPluginSettings): boolean {
  normalizeLanguageConfiguration(settings);
  return getEnabledLanguageDefinitions(settings).some((language) => language.id === languageId);
}

export function areCustomLanguagesEnabled(settings: lotusPluginSettings): boolean {
  normalizeLanguageConfiguration(settings);
  return isCompileCustomLanguagesAllowed() && settings.enabledLanguagePacks.includes(CUSTOM_LANGUAGE_PACKAGE_ID);
}

export function getEnabledCommandLanguages(settings: lotusPluginSettings): lotusCustomLanguage[] {
  normalizeLanguageConfiguration(settings);
  const enabledPacks = new Set(settings.enabledLanguagePacks);
  const enabledLanguages = new Set(settings.enabledLanguages);
  const customLanguages = areCustomLanguagesEnabled(settings) ? settings.customLanguages ?? [] : [];
  const externalLanguages = (isCompileExternalLanguagePacksAllowed() ? settings.externalLanguagePacks ?? [] : [])
    .filter((pack) => enabledPacks.has(pack.id))
    .flatMap((pack) => pack.languages)
    .filter((language) => enabledLanguages.has(language.name) && isCompileLanguageAllowed(language.name));

  return [...customLanguages, ...externalLanguages];
}

export function findEnabledCommandLanguage(settings: lotusPluginSettings, normalizedLanguage: string, sourceAlias?: string): lotusCustomLanguage | undefined {
  const normalized = normalizedLanguage.trim().toLowerCase();
  const alias = sourceAlias?.trim().toLowerCase();
  const commandLanguages = getEnabledCommandLanguages(settings);
  const enabledAliases = getEnabledLanguageAliasMap(settings);
  const builtInLanguageIds = getEnabledBuiltInLanguageIds(settings);
  const resolvedLanguage = enabledAliases[normalized];
  if (resolvedLanguage) {
    return builtInLanguageIds.has(resolvedLanguage)
      ? undefined
      : commandLanguages.find((language) => language.name.trim().toLowerCase() === resolvedLanguage);
  }
  if (alias) {
    const resolvedAlias = enabledAliases[alias];
    if (resolvedAlias) {
      return builtInLanguageIds.has(resolvedAlias)
        ? undefined
        : commandLanguages.find((language) => language.name.trim().toLowerCase() === resolvedAlias);
    }
  }

  return commandLanguages.find((language) => {
    const name = language.name.trim().toLowerCase();
    const aliases = parseAliasList(language.aliases);
    return name === normalized || aliases.includes(normalized) || Boolean(alias && (name === alias || aliases.includes(alias)));
  });
}

function getEnabledBuiltInLanguageIds(settings: lotusPluginSettings): Set<string> {
  normalizeLanguageConfiguration(settings);
  const enabledPacks = new Set(settings.enabledLanguagePacks);
  const enabledLanguages = new Set(settings.enabledLanguages);
  return new Set(
    getCompileAllowedBuiltInLanguagePackages()
      .filter((pack) => enabledPacks.has(pack.id))
      .flatMap((pack) => pack.languages)
      .filter((language) => enabledLanguages.has(language.id))
      .map((language) => language.id),
  );
}

function parseAliasList(value?: string): string[] {
  return (value ?? "")
    .split(",")
    .map((alias) => alias.trim().toLowerCase())
    .filter(Boolean);
}
