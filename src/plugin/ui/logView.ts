import { ItemView, Notice, normalizePath, setIcon, type WorkspaceLeaf } from "obsidian";
import type lotusPlugin from "../main";

export const LOTUS_LOG_VIEW_TYPE = "lotus-log-view";

interface lotusLogRecord {
  timestamp: string;
  type: string;
  message: string;
  note: string;
  target: string;
  block: string;
  success: "success" | "failure" | "unknown";
  exitCode: string;
  durationMs: string;
  machineHash: string;
  raw: Record<string, unknown>;
}

export class lotusLogView extends ItemView {
  private query = "";
  private typeFilter = "all";
  private statusFilter = "all";
  private events: lotusLogRecord[] = [];

  constructor(
    leaf: WorkspaceLeaf,
    private readonly plugin: lotusPlugin,
  ) {
    super(leaf);
  }

  getViewType(): string {
    return LOTUS_LOG_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Lotus logs";
  }

  getIcon(): string {
    return "list-filter";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("lotus-log-view");

    const header = container.createDiv({ cls: "lotus-log-view-header" });
    header.createEl("h2", { text: "Lotus logs" });
    const actions = header.createDiv({ cls: "lotus-log-view-actions" });
    const refreshButton = actions.createEl("button", { attr: { "aria-label": "Refresh logs" } });
    setIcon(refreshButton, "refresh-cw");
    refreshButton.addEventListener("click", () => void this.refresh());

    const path = normalizeLogPath(this.plugin.app.vault.configDir, this.plugin.settings.loggingViewerJsonlPath || this.plugin.settings.loggingGlobalJsonlPath);
    container.createDiv({ cls: "lotus-log-view-path", text: path || "No JSONL log path configured." });

    this.events = path ? await this.readEvents(path) : [];
    this.renderFilters(container);
    this.renderEvents(container);
  }

  private renderFilters(container: HTMLElement): void {
    const filters = container.createDiv({ cls: "lotus-log-filters" });
    const query = filters.createEl("input", {
      cls: "lotus-log-filter-query",
      attr: {
        type: "search",
        placeholder: "Search logs",
      },
    });
    query.value = this.query;
    query.addEventListener("input", () => {
      this.query = query.value;
      this.renderEvents(container);
    });

    const typeSelect = filters.createEl("select");
    addOption(typeSelect, "all", "All types");
    for (const type of [...new Set(this.events.map((event) => event.type).filter(Boolean))].sort()) {
      addOption(typeSelect, type, type);
    }
    typeSelect.value = this.typeFilter;
    typeSelect.addEventListener("change", () => {
      this.typeFilter = typeSelect.value;
      this.renderEvents(container);
    });

    const statusSelect = filters.createEl("select");
    addOption(statusSelect, "all", "All statuses");
    addOption(statusSelect, "success", "Success");
    addOption(statusSelect, "failure", "Failure");
    addOption(statusSelect, "unknown", "Unknown");
    statusSelect.value = this.statusFilter;
    statusSelect.addEventListener("change", () => {
      this.statusFilter = statusSelect.value;
      this.renderEvents(container);
    });
  }

  private renderEvents(container: HTMLElement): void {
    container.querySelector(".lotus-log-events")?.remove();
    const list = container.createDiv({ cls: "lotus-log-events" });
    const filtered = this.filteredEvents();

    const summary = list.createDiv({ cls: "lotus-log-summary" });
    summary.setText(`${filtered.length} of ${this.events.length} events`);

    if (!this.events.length) {
      list.createDiv({ cls: "lotus-log-empty", text: "No structured log events found." });
      return;
    }
    if (!filtered.length) {
      list.createDiv({ cls: "lotus-log-empty", text: "No events match these filters." });
      return;
    }

    for (const event of filtered.slice(0, 500)) {
      this.renderEvent(list, event);
    }
  }

  private renderEvent(list: HTMLElement, event: lotusLogRecord): void {
    const row = list.createEl("details", { cls: `lotus-log-event is-${event.success}` });
    const summary = row.createEl("summary", { cls: "lotus-log-event-summary" });
    summary.createSpan({ cls: "lotus-log-event-time", text: formatTimestamp(event.timestamp) });
    summary.createSpan({ cls: "lotus-log-event-type", text: event.type || "event" });
    summary.createSpan({ cls: "lotus-log-event-message", text: event.message });

    const meta = row.createDiv({ cls: "lotus-log-event-meta" });
    addMeta(meta, "note", event.note);
    addMeta(meta, "block", event.block);
    addMeta(meta, "target", event.target);
    addMeta(meta, "status", event.success);
    addMeta(meta, "exit", event.exitCode);
    addMeta(meta, "duration", event.durationMs ? `${event.durationMs} ms` : "");
    addMeta(meta, "machine", event.machineHash ? event.machineHash.slice(0, 16) : "");
    row.createEl("pre", { cls: "lotus-log-event-json", text: JSON.stringify(event.raw, null, 2) });
  }

  private filteredEvents(): lotusLogRecord[] {
    const query = this.query.trim().toLowerCase();
    return this.events.filter((event) => {
      if (this.typeFilter !== "all" && event.type !== this.typeFilter) {
        return false;
      }
      if (this.statusFilter !== "all" && event.success !== this.statusFilter) {
        return false;
      }
      if (!query) {
        return true;
      }
      return JSON.stringify(event.raw).toLowerCase().includes(query);
    });
  }

  private async readEvents(path: string): Promise<lotusLogRecord[]> {
    const adapter = this.app.vault.adapter;
    if (!(await adapter.exists(path))) {
      return [];
    }

    try {
      const lines = (await adapter.read(path)).split(/\r?\n/).filter((line) => line.trim());
      return lines
        .slice(-2_000)
        .map((line) => parseLogRecord(line))
        .filter((event): event is lotusLogRecord => Boolean(event))
        .reverse();
    } catch (error) {
      new Notice(`Failed to read Lotus logs: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }
}

function parseLogRecord(line: string): lotusLogRecord | null {
  try {
    const raw = JSON.parse(line) as Record<string, unknown>;
    const data = readRecord(raw.data);
    const note = readRecord(raw.note);
    const block = readRecord(raw.block);
    const target = readRecord(raw.target);
    const success = typeof data.success === "boolean"
      ? data.success ? "success" : "failure"
      : raw.type === "lotus.run.failed" ? "failure" : "unknown";

    return {
      timestamp: readString(raw.timestamp),
      type: readString(raw.type),
      message: readString(raw.message),
      note: readString(note.name) || readString(note.path) || readString(note.pathHash),
      target: readString(target.containerGroup) || readString(target.runnerName) || readString(data.runnerName),
      block: formatBlock(block),
      success,
      exitCode: data.exitCode == null ? "" : String(data.exitCode),
      durationMs: data.durationMs == null ? "" : String(data.durationMs),
      machineHash: readString(raw.machineHash),
      raw,
    };
  } catch {
    return null;
  }
}

function formatBlock(block: Record<string, unknown>): string {
  const ordinal = block.ordinal == null ? "" : `#${String(block.ordinal)}`;
  const language = readString(block.language);
  const hash = readString(block.hash);
  return [ordinal, language, hash ? hash.slice(0, 12) : ""].filter(Boolean).join(" ");
}

function readRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function addOption(select: HTMLSelectElement, value: string, text: string): void {
  const option = select.createEl("option", { text });
  option.value = value;
}

function addMeta(container: HTMLElement, label: string, value: string): void {
  if (!value) {
    return;
  }
  const item = container.createSpan({ cls: "lotus-log-meta-item" });
  item.createSpan({ cls: "lotus-log-meta-label", text: label });
  item.createSpan({ text: value });
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function normalizeLogPath(configDir: string, rawPath: string): string | null {
  const trimmed = rawPath.trim();
  if (!trimmed || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }
  const path = normalizePath(trimmed.startsWith("/") ? trimmed.slice(1) : trimmed);
  const parts = path.split("/").filter(Boolean);
  if (!parts.length || parts.includes("..") || path === configDir || path.startsWith(`${configDir}/`) || path === ".git" || path.startsWith(".git/")) {
    return null;
  }
  return path;
}
