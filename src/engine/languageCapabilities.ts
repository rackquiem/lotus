import type { lotusNormalizedLanguage } from "./types";

export interface lotusLanguageCapability {
  language: lotusNormalizedLanguage;
  symbolExtraction: "ast" | "top-level" | "generic" | "external";
  dependencyTracing: "ast" | "top-level" | "generic" | "external";
  callHarness: "built-in" | "raw" | "external";
  sourcePreview: boolean;
}

const BUILT_IN_CAPABILITIES: Record<string, lotusLanguageCapability> = {
  python: {
    language: "python",
    symbolExtraction: "ast",
    dependencyTracing: "ast",
    callHarness: "built-in",
    sourcePreview: true,
  },
  javascript: {
    language: "javascript",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "built-in",
    sourcePreview: true,
  },
  "obsidian-js": {
    language: "obsidian-js",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "built-in",
    sourcePreview: true,
  },
  typescript: {
    language: "typescript",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "built-in",
    sourcePreview: true,
  },
  c: {
    language: "c",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "built-in",
    sourcePreview: true,
  },
  cpp: {
    language: "cpp",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "built-in",
    sourcePreview: true,
  },
  "llvm-ir": {
    language: "llvm-ir",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "raw",
    sourcePreview: true,
  },
  haskell: {
    language: "haskell",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "raw",
    sourcePreview: true,
  },
  ocaml: {
    language: "ocaml",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "built-in",
    sourcePreview: true,
  },
  java: {
    language: "java",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "raw",
    sourcePreview: true,
  },
  "ebpf-c": {
    language: "ebpf-c",
    symbolExtraction: "top-level",
    dependencyTracing: "top-level",
    callHarness: "raw",
    sourcePreview: true,
  },
  bpftrace: {
    language: "bpftrace",
    symbolExtraction: "generic",
    dependencyTracing: "generic",
    callHarness: "raw",
    sourcePreview: true,
  },
};

export function getLanguageCapability(language: lotusNormalizedLanguage, hasExternalExtractor = false): lotusLanguageCapability {
  if (hasExternalExtractor) {
    return {
      language,
      symbolExtraction: "external",
      dependencyTracing: "external",
      callHarness: "external",
      sourcePreview: true,
    };
  }

  return BUILT_IN_CAPABILITIES[language] ?? {
    language,
    symbolExtraction: "generic",
    dependencyTracing: "generic",
    callHarness: "raw",
    sourcePreview: true,
  };
}

export function getBuiltInLanguageCapabilities(): lotusLanguageCapability[] {
  return Object.values(BUILT_IN_CAPABILITIES);
}
