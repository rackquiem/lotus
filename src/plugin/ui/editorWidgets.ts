
import { MarkdownRenderChild } from "obsidian";
import { StateEffect } from "@codemirror/state";
import { WidgetType } from "@codemirror/view";
import type { lotusCodeBlock } from "../../engine/types";
import type lotusPlugin from "../main";

export const lotusRefreshEffect = StateEffect.define<void>();

export class lotusToolbarRenderChild extends MarkdownRenderChild {
  private panelContainer: HTMLDivElement | null = null;
  private toolbarElement: HTMLElement | null = null;
  private unregisterOutputListener: (() => void) | null = null;

  constructor(
    containerEl: HTMLElement,
    private readonly plugin: lotusPlugin,
    private readonly block: lotusCodeBlock,
    private readonly codeElement: HTMLElement,
  ) {
    super(containerEl);
  }

  onload(): void {
    this.codeElement.classList.add("lotus-codeblock-shell");
    this.toolbarElement = this.plugin.createToolbarElement(this.block);
    this.codeElement.appendChild(this.toolbarElement);

    if (this.plugin.settings.pdfExportMode === "output") {
      this.codeElement.classList.add("lotus-print-hide-code");
    }

    const hostClasses = ["lotus-inline-output-host"];
    if (this.plugin.settings.pdfExportMode === "code") {
      hostClasses.push("lotus-print-hide-output");
    }
    this.panelContainer = createEl("div", { cls: hostClasses.join(" ") });
    this.codeElement.insertAdjacentElement("afterend", this.panelContainer);

    this.plugin.renderOutputInto(this.block, this.panelContainer);
    this.unregisterOutputListener = this.plugin.registerOutputListener(this.block.id, () => {
      if (this.panelContainer) {
        this.plugin.renderOutputInto(this.block, this.panelContainer);
      }
    });
  }

  onunload(): void {
    this.unregisterOutputListener?.();
    this.panelContainer?.remove();
    this.toolbarElement?.remove();
  }
}

export class lotusToolbarWidget extends WidgetType {
  private readonly isRunning: boolean;
  private readonly showTranspile: boolean;
  private readonly showVisualize: boolean;

  constructor(
    private readonly plugin: lotusPlugin,
    private readonly block: lotusCodeBlock,
  ) {
    super();
    this.isRunning = plugin.isBlockRunning(block.id);
    this.showTranspile = plugin.shouldShowTranspileButton(block);
    this.showVisualize = plugin.shouldShowCodeVisualizationButton();
  }

  eq(other: lotusToolbarWidget): boolean {
    return other.block.id === this.block.id
      && other.isRunning === this.isRunning
      && other.showTranspile === this.showTranspile
      && other.showVisualize === this.showVisualize;
  }

  toDOM(): HTMLElement {
    return this.plugin.createToolbarElement(this.block);
  }
}

export class lotusOutputWidget extends WidgetType {
  constructor(
    private readonly plugin: lotusPlugin,
    private readonly block: lotusCodeBlock,
  ) {
    super();
  }

  eq(other: lotusOutputWidget): boolean {
    return false;
  }

  toDOM(): HTMLElement {
    const wrapper = createEl("div", { cls: "lotus-inline-output-host" });
    this.plugin.renderOutputInto(this.block, wrapper);
    return wrapper;
  }
}
