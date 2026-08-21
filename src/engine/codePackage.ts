import { extname } from "path";
import type { lotusCodeBlock, lotusCodePackage, lotusCodePackageFile } from "./types";
import { shortHash } from "./utils/hash";

const NATIVE_PACKAGE_LANGUAGES = new Set(["c", "cpp"]);
const CPP_SOURCE_EXTENSIONS = new Set([".c", ".cc", ".cp", ".cpp", ".cxx", ".c++"]);

export function attachCodePackages(blocks: lotusCodeBlock[]): void {
  const groups = new Map<string, lotusCodeBlock[]>();

  for (const block of blocks) {
    const rawName = readPackageName(block);
    if (rawName == null) {
      continue;
    }
    const name = rawName.trim();
    const members = groups.get(name) ?? [];
    members.push(block);
    groups.set(name, members);
  }

  for (const [name, members] of groups) {
    const codePackage = createCodePackage(name, members);
    for (const block of members) {
      block.codePackage = codePackage;
      block.id = shortHash(`${block.id}:code-package:${codePackage.hash}`);
    }
  }
}

export function assertRunnableCodePackage(block: lotusCodeBlock): void {
  const codePackage = block.codePackage;
  if (!codePackage) {
    return;
  }
  if (codePackage.errors.length) {
    const label = codePackage.name || "(empty name)";
    throw new Error(`code package ${JSON.stringify(label)} is invalid: ${codePackage.errors.join(" ")}`);
  }
}

export function getCodePackageTranslationUnits(block: lotusCodeBlock): lotusCodePackageFile[] {
  assertRunnableCodePackage(block);
  const codePackage = block.codePackage;
  if (!codePackage) {
    return [];
  }

  return codePackage.files.filter((file) => isTranslationUnit(block.language, file.path));
}

function createCodePackage(name: string, members: lotusCodeBlock[]): lotusCodePackage {
  const errors: string[] = [];
  if (!name) {
    errors.push("lotus-code-package needs a non-empty name.");
  }

  const languages = [...new Set(members.map((block) => block.language))];
  if (languages.some((language) => !NATIVE_PACKAGE_LANGUAGES.has(language))) {
    errors.push("code packages currently support c and c++ blocks only.");
  }
  if (languages.length > 1) {
    errors.push(`all blocks in a code package must use the same language; found ${languages.join(", ")}.`);
  }
  if (members.some((block) => block.sourceReference)) {
    errors.push("lotus-file source extraction can't be combined with lotus-code-package.");
  }

  const files = members.map((block) => createPackageFile(block, errors));
  const paths = new Map<string, lotusCodePackageFile>();
  for (const file of files) {
    const existing = paths.get(file.path.toLowerCase());
    if (existing) {
      errors.push(`filename ${JSON.stringify(file.path)} is used by blocks ${existing.ordinal} and ${file.ordinal}.`);
      continue;
    }
    paths.set(file.path.toLowerCase(), file);
  }

  if (NATIVE_PACKAGE_LANGUAGES.has(languages[0] ?? "") && !files.some((file) => isTranslationUnit(languages[0], file.path))) {
    errors.push("the package needs at least one compilable source file.");
  }

  const hash = shortHash(JSON.stringify({
    name,
    files: files.map((file) => ({
      path: file.path,
      content: file.content,
      ordinal: file.ordinal,
      language: file.language,
      sourceLanguage: file.sourceLanguage,
    })),
    errors,
  }));

  return { name, hash, files, errors };
}

function createPackageFile(block: lotusCodeBlock, errors: string[]): lotusCodePackageFile {
  const explicitPath = readFileName(block);
  const path = explicitPath == null
    ? `block-${block.ordinal}${inferFileExtension(block)}`
    : explicitPath.trim();

  if (explicitPath != null && !path) {
    errors.push(`block ${block.ordinal} has an empty lotus-code-file.`);
  } else {
    const pathError = validatePackagePath(path);
    if (pathError) {
      errors.push(`block ${block.ordinal} has invalid filename ${JSON.stringify(path)}: ${pathError}`);
    }
  }

  return {
    path,
    content: block.content,
    ordinal: block.ordinal,
    language: block.language,
    sourceLanguage: block.sourceLanguage,
  };
}

function validatePackagePath(path: string): string | null {
  if (!path) {
    return "the filename is empty.";
  }
  if (path.includes("\0")) {
    return "null bytes aren't allowed.";
  }
  if (path.includes("\\")) {
    return "use forward slashes for nested paths.";
  }
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) {
    return "the filename must be relative.";
  }

  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return "empty, . and .. path segments aren't allowed.";
  }
  return null;
}

function inferFileExtension(block: lotusCodeBlock): string {
  const alias = block.sourceLanguage.trim().toLowerCase();
  if (block.language === "c") {
    return alias === "h" ? ".h" : ".c";
  }
  if (block.language === "cpp") {
    if (alias === "cc") return ".cc";
    if (alias === "cxx") return ".cxx";
    return ".cpp";
  }
  return ".txt";
}

function isTranslationUnit(language: string, path: string): boolean {
  const extension = extname(path);
  if (language === "c") {
    return extension === ".c";
  }
  return extension === ".C" || CPP_SOURCE_EXTENSIONS.has(extension.toLowerCase());
}

function readPackageName(block: lotusCodeBlock): string | undefined {
  return block.attributes["lotus-code-package"] ?? block.attributes["code-package"];
}

function readFileName(block: lotusCodeBlock): string | undefined {
  return block.attributes["lotus-code-file"] ?? block.attributes["code-file"];
}
