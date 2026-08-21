import { setIcon } from "obsidian";

export interface lotusToolbarHandlers {
  onRun: () => void;
  onTranspile: () => void;
  onEdit: () => void;
  onCopy: () => void;
  onRemove: () => void;
  onToggleInput: () => void;
  onToggleOutput: () => void;
  onVisualize: () => void;
}

export interface lotusToolbarOptions {
  inputButtonLabel?: string;
  showTranspile?: boolean;
  showVisualize?: boolean;
}

export function createCodeBlockToolbar(
  blockId: string,
  isRunning: boolean,
  handlers: lotusToolbarHandlers,
  options: lotusToolbarOptions = {},
): HTMLDivElement {
  const toolbar = activeDocument.createElement("div");
  toolbar.className = "lotus-code-toolbar";
  toolbar.dataset.lotusBlockId = blockId;

  toolbar.appendChild(createButton(isRunning ? "Cancel block" : "Run block", isRunning ? "square" : "play", handlers.onRun, false));
  if (!isRunning && options.showTranspile) {
    toolbar.appendChild(createButton("Transpile block", "redo-2", handlers.onTranspile, false));
  }
  if (options.showVisualize ?? true) {
    toolbar.appendChild(createButton("Visualize code", "git-fork", handlers.onVisualize, false));
  }
  toolbar.appendChild(createButton("Edit block", "pencil", handlers.onEdit, false));
  toolbar.appendChild(createButton(options.inputButtonLabel ?? "Toggle stdin input", "text-cursor-input", handlers.onToggleInput, false));
  toolbar.appendChild(createButton("Copy code", "copy", handlers.onCopy, false));
  toolbar.appendChild(createButton("Remove snippet", "trash-2", handlers.onRemove, false));
  toolbar.appendChild(createButton("Toggle output", "panel-bottom-open", handlers.onToggleOutput, false));

  return toolbar;
}

function createButton(label: string, iconName: string, onClick: () => void, spinning: boolean): HTMLButtonElement {
  const button = activeDocument.createElement("button");
  button.className = `lotus-toolbar-button${spinning ? " is-running" : ""}`;
  button.type = "button";
  button.setAttribute("aria-label", label);
  button.title = label;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  setIcon(button, iconName);
  return button;
}
