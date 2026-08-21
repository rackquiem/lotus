declare const __LOTUS_COMPILE_MODE__: string;
declare const __LOTUS_LIGHT_LANGUAGES__: string[];
declare const __LOTUS_LIGHT_LANGUAGE_PACKS__: string[];
declare const __LOTUS_LIGHT_FEATURES__: string[];
declare const __LOTUS_LIGHT_CONTAINER_GROUPS__: string[];
declare const __LOTUS_LIGHT_CONTAINER_RUNTIMES__: string[];
declare const __LOTUS_FORCE_LOGGING__: boolean;
declare const __LOTUS_MACHINE_HASH_SCOPE__: string;

export type lotusCompileMode = "strict" | "light";
export type lotusCompileFeature = "custom-languages" | "external-language-packs" | "container-groups" | "output-filters" | "rich-displays" | "signing";
export type lotusCompileContainerRuntime = "docker" | "podman" | "qemu" | "wsl" | "ssh" | "custom" | "http";
export type lotusCompileMachineHashScope = "install" | "vault" | "install-vault";

const ALL_CONTAINER_RUNTIMES: lotusCompileContainerRuntime[] = ["docker", "podman", "qemu", "wsl", "ssh", "custom", "http"];

const COMPILE_MODE: lotusCompileMode = readCompileMode(
  typeof __LOTUS_COMPILE_MODE__ === "undefined" ? "strict" : __LOTUS_COMPILE_MODE__,
);
const LIGHT_LANGUAGES = normalizeList(typeof __LOTUS_LIGHT_LANGUAGES__ === "undefined" ? [] : __LOTUS_LIGHT_LANGUAGES__);
const LIGHT_LANGUAGE_PACKS = normalizeList(typeof __LOTUS_LIGHT_LANGUAGE_PACKS__ === "undefined" ? [] : __LOTUS_LIGHT_LANGUAGE_PACKS__);
const LIGHT_FEATURES = normalizeList(typeof __LOTUS_LIGHT_FEATURES__ === "undefined" ? [] : __LOTUS_LIGHT_FEATURES__);
const LIGHT_CONTAINER_GROUPS = normalizeList(typeof __LOTUS_LIGHT_CONTAINER_GROUPS__ === "undefined" ? [] : __LOTUS_LIGHT_CONTAINER_GROUPS__);
const LIGHT_CONTAINER_RUNTIMES = normalizeList(typeof __LOTUS_LIGHT_CONTAINER_RUNTIMES__ === "undefined" ? [] : __LOTUS_LIGHT_CONTAINER_RUNTIMES__);
const FORCE_LOGGING = typeof __LOTUS_FORCE_LOGGING__ === "undefined" ? false : __LOTUS_FORCE_LOGGING__;
const MACHINE_HASH_SCOPE = readMachineHashScope(typeof __LOTUS_MACHINE_HASH_SCOPE__ === "undefined" ? "" : __LOTUS_MACHINE_HASH_SCOPE__);

export function getCompileMode(): lotusCompileMode {
  return COMPILE_MODE;
}

export function isLightCompileMode(): boolean {
  return COMPILE_MODE === "light";
}

export function hasCompileLanguageSelection(): boolean {
  return isLightCompileMode() && LIGHT_LANGUAGES.length > 0;
}

export function hasCompileLanguagePackageSelection(): boolean {
  return isLightCompileMode() && LIGHT_LANGUAGE_PACKS.length > 0;
}

export function isCompileLanguageAllowed(languageId: string): boolean {
  return !hasCompileLanguageSelection() || LIGHT_LANGUAGES.includes(normalizeToken(languageId));
}

export function isCompileLanguagePackageAllowed(packageId: string): boolean {
  return !hasCompileLanguagePackageSelection() || LIGHT_LANGUAGE_PACKS.includes(normalizeToken(packageId));
}

export function isCompileFeatureAllowed(feature: lotusCompileFeature): boolean {
  return !isLightCompileMode() || !LIGHT_FEATURES.length || LIGHT_FEATURES.includes(feature);
}

export function isCompileCustomLanguagesAllowed(): boolean {
  if (!isCompileFeatureAllowed("custom-languages")) {
    return false;
  }
  if (hasCompileLanguagePackageSelection() && !LIGHT_LANGUAGE_PACKS.includes("custom")) {
    return false;
  }
  return !hasCompileLanguageSelection() || LIGHT_LANGUAGES.includes("custom") || LIGHT_LANGUAGES.includes("custom-languages");
}

export function isCompileExternalLanguagePacksAllowed(): boolean {
  if (!isCompileFeatureAllowed("external-language-packs")) {
    return false;
  }
  if (
    hasCompileLanguagePackageSelection()
    && !LIGHT_LANGUAGE_PACKS.includes("external")
    && !LIGHT_LANGUAGE_PACKS.includes("external-language-packs")
    && !LIGHT_LANGUAGE_PACKS.some((packId) => packId.startsWith("external:"))
  ) {
    return false;
  }
  return !hasCompileLanguageSelection() || LIGHT_LANGUAGES.includes("external") || LIGHT_LANGUAGES.includes("external-language-packs");
}

export function getCompileContainerRuntimes(): lotusCompileContainerRuntime[] {
  if (!isLightCompileMode() || !LIGHT_CONTAINER_RUNTIMES.length) {
    return ALL_CONTAINER_RUNTIMES;
  }
  return ALL_CONTAINER_RUNTIMES.filter((runtime) => LIGHT_CONTAINER_RUNTIMES.includes(runtime));
}

export function hasCompileContainerGroupSelection(): boolean {
  return isLightCompileMode() && LIGHT_CONTAINER_GROUPS.length > 0;
}

export function isCompileContainerGroupAllowed(groupName: string): boolean {
  return !hasCompileContainerGroupSelection() || LIGHT_CONTAINER_GROUPS.includes(normalizeToken(groupName));
}

export function isCompileContainerRuntimeAllowed(runtime: string): boolean {
  return getCompileContainerRuntimes().includes(runtime as lotusCompileContainerRuntime);
}

export function isCompileLoggingForced(): boolean {
  return FORCE_LOGGING;
}

export function getCompileMachineHashScopeOverride(): lotusCompileMachineHashScope | null {
  return MACHINE_HASH_SCOPE;
}

export function getCompileProfileSummary(): string {
  if (!isLightCompileMode()) {
    return `STRICT${formatAuditProfileSummary()}`;
  }

  const pieces = ["LIGHT"];
  pieces.push(`languages=${LIGHT_LANGUAGES.length ? LIGHT_LANGUAGES.join(",") : "all"}`);
  pieces.push(`language-packs=${LIGHT_LANGUAGE_PACKS.length ? LIGHT_LANGUAGE_PACKS.join(",") : "all"}`);
  pieces.push(`features=${LIGHT_FEATURES.length ? LIGHT_FEATURES.join(",") : "all"}`);
  pieces.push(`container-groups=${LIGHT_CONTAINER_GROUPS.length ? LIGHT_CONTAINER_GROUPS.join(",") : "all"}`);
  pieces.push(`container-runtimes=${LIGHT_CONTAINER_RUNTIMES.length ? LIGHT_CONTAINER_RUNTIMES.join(",") : "all"}`);
  if (FORCE_LOGGING) {
    pieces.push("force-logging=true");
  }
  if (MACHINE_HASH_SCOPE) {
    pieces.push(`machine-hash-scope=${MACHINE_HASH_SCOPE}`);
  }
  return pieces.join("; ");
}

function readCompileMode(value: string): lotusCompileMode {
  return value.trim().toLowerCase() === "light" ? "light" : "strict";
}

function normalizeList(values: unknown): string[] {
  const raw = Array.isArray(values) ? values : String(values ?? "").split(",");
  return [...new Set(raw.map((value) => normalizeToken(String(value))).filter(Boolean))];
}

function normalizeToken(value: string): string {
  return value.trim().toLowerCase();
}

function readMachineHashScope(value: string): lotusCompileMachineHashScope | null {
  const normalized = normalizeToken(value);
  return normalized === "install" || normalized === "vault" || normalized === "install-vault" ? normalized : null;
}

function formatAuditProfileSummary(): string {
  const pieces: string[] = [];
  if (FORCE_LOGGING) {
    pieces.push("force-logging=true");
  }
  if (MACHINE_HASH_SCOPE) {
    pieces.push(`machine-hash-scope=${MACHINE_HASH_SCOPE}`);
  }
  return pieces.length ? `; ${pieces.join("; ")}` : "";
}
