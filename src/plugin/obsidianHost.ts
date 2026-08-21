
import { TFile, requestUrl, type App } from "obsidian";
import type { lotusLogHost } from "../engine/logging";
import type { lotusVaultHost } from "../engine/vaultHost";

export function createObsidianVaultHost(app: App): lotusVaultHost {
  const adapter = app.vault.adapter;
  const noteAt = (path: string): TFile | null => {
    const file = app.vault.getAbstractFileByPath(path);
    return file instanceof TFile ? file : null;
  };
  return {
    get configDir() {
      return app.vault.configDir;
    },
    get vaultBasePath() {
      return (adapter as { basePath?: string }).basePath;
    },
    listNotes: () => app.vault.getMarkdownFiles(),
    noteExists: (path) => noteAt(path) !== null,
    readNote: async (path) => {
      const file = noteAt(path);
      return file ? app.vault.cachedRead(file) : null;
    },
    processNote: async (path, transform) => {
      const file = noteAt(path);
      if (!file) {
        throw new Error(`Note not found: ${path}`);
      }
      await app.vault.process(file, transform);
    },
    writeNote: async (path, content) => {
      const file = noteAt(path);
      if (!file) {
        throw new Error(`Note not found: ${path}`);
      }
      await app.vault.modify(file, content);
    },
    readFrontmatter: (path) => {
      const file = noteAt(path);
      const frontmatter: unknown = file ? app.metadataCache.getFileCache(file)?.frontmatter : undefined;
      return frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter) ? frontmatter as Record<string, unknown> : undefined;
    },
    processFrontmatter: async (path, update) => {
      const file = noteAt(path);
      if (!file) {
        throw new Error(`Note not found: ${path}`);
      }
      await app.fileManager.processFrontMatter(file, (frontmatter) => update(frontmatter as Record<string, unknown>));
    },
    exists: (path) => adapter.exists(path),
    read: (path) => adapter.read(path),
    write: (path, content) => adapter.write(path, content),
    mkdir: (path) => adapter.mkdir(path),
  };
}

export function createObsidianLogHost(app: App): lotusLogHost {
  const adapter = app.vault.adapter;
  return {
    get vaultName() {
      return app.vault.getName();
    },
    get configDir() {
      return app.vault.configDir;
    },
    get vaultBasePath() {
      return (adapter as { basePath?: string }).basePath;
    },
    exists: (path) => adapter.exists(path),
    read: (path) => adapter.read(path),
    append: (path, content) => adapter.append(path, content),
    write: (path, content) => adapter.write(path, content),
    mkdir: (path) => adapter.mkdir(path),
    postJson: async (url, headers, body) => {
      await requestUrl({ url, method: "POST", contentType: "application/json", headers, body });
    },
  };
}
