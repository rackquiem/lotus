import { dirname } from "path";
import type { lotusRunFile } from "./types";

export interface lotusNoteInfo extends lotusRunFile {
  stat: { mtime: number };
}

export interface lotusVaultHost {
  readonly configDir: string;
  readonly vaultBasePath: string | undefined;
  listNotes(): lotusNoteInfo[];
  noteExists(path: string): boolean;
  readNote(path: string): Promise<string | null>;
  processNote(path: string, transform: (content: string) => string): Promise<void>;
  writeNote(path: string, content: string): Promise<void>;
  readFrontmatter(path: string): Record<string, unknown> | undefined;
  processFrontmatter(path: string, update: (frontmatter: Record<string, unknown>) => void): Promise<void>;
  exists(path: string): Promise<boolean>;
  read(path: string): Promise<string>;
  write(path: string, content: string): Promise<void>;
  mkdir(path: string): Promise<void>;
}

export async function readNoteOrThrow(vault: lotusVaultHost, path: string): Promise<string> {
  const content = await vault.readNote(path);
  if (content == null) {
    throw new Error(`Note not found: ${path}`);
  }
  return content;
}

export async function ensureVaultFolder(vault: lotusVaultHost, folder: string): Promise<void> {
  let current = "";
  for (const part of folder.split("/").filter(Boolean)) {
    current = current ? `${current}/${part}` : part;
    if (!(await vault.exists(current))) {
      await vault.mkdir(current);
    }
  }
}

export async function ensureVaultParentFolder(vault: lotusVaultHost, path: string): Promise<void> {
  const folder = dirname(path);
  if (!folder || folder === ".") {
    return;
  }
  await ensureVaultFolder(vault, folder);
}
