const LANGUAGE_CLASS_ALIASES: Record<string, string> = {
  "c++": "cpp",
  cc: "cpp",
  cxx: "cpp",
  js: "javascript",
  ts: "typescript",
  sh: "shell",
  bash: "shell",
  llvm: "llvm-ir",
  llvmir: "llvm-ir",
  ll: "llvm-ir",
};

export function normalizeSyntaxLanguage(language: string | null | undefined): string | null {
  const trimmed = language?.trim().toLowerCase() ?? "";
  if (!trimmed) {
    return null;
  }

  const aliased = LANGUAGE_CLASS_ALIASES[trimmed] ?? trimmed;
  const normalized = aliased
    .replace(/[^a-z0-9_.-]/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}
