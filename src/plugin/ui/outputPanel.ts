import { Notice, setIcon } from "obsidian";
import { addSyntaxLanguageClass, highlightCodeElement, normalizeSyntaxLanguage } from "../syntaxHighlight";
import type {
  lotusDisplayOutput,
  lotusDisplayRenderer,
  lotusDisplayRendererCleanup,
  lotusRunArtifact,
  lotusSourcePreviewStage,
  lotusStoredOutput,
} from "../../engine/types";

interface lotusOutputPanelOptions {
  defaultVisibleLines: number;
  displayRenderers?: readonly lotusDisplayRenderer[];
}

export interface lotusDisplayOutputOptions {
  defaultVisibleLines: number;
  displayRenderers?: readonly lotusDisplayRenderer[];
}

export interface lotusRunningPanelOptions {
  runnerName?: string;
  stdout?: string;
  stderr?: string;
  inputEnabled?: boolean;
  onSendInput?: (input: string) => void;
  onCloseInput?: () => void;
}

function getStatusKind(output: lotusStoredOutput): "success" | "warning" | "failure" {
  if (output.result.success) {
    return output.result.stderr.trim() || output.result.warning?.trim() ? "warning" : "success";
  }

  return "failure";
}

export function createOutputPanel(output: lotusStoredOutput, options: lotusOutputPanelOptions): HTMLDivElement {
  const panel = createEl("div", { cls: `lotus-output-panel is-${getStatusKind(output)}${output.visible ? "" : " is-hidden"}` });
  panel.dataset.lotusBlockId = output.blockId;
  renderOutputPanel(panel, output, options);
  return panel;
}

export function renderOutputPanel(panel: HTMLElement, output: lotusStoredOutput, options: lotusOutputPanelOptions): void {
  const kind = getStatusKind(output);
  panel.className = `lotus-output-panel is-${kind}${output.visible ? "" : " is-hidden"}${output.collapsed ? " is-collapsed" : ""}`;
  panel.empty();
  const visibleLines = resolveVisibleLines(output, options.defaultVisibleLines);

  const header = panel.createDiv({ cls: "lotus-output-header" });
  const badge = header.createDiv({ cls: "lotus-output-badge" });
  setIcon(badge, kind === "success" ? "check-circle-2" : kind === "warning" ? "alert-triangle" : "x-circle");

  const title = header.createDiv({ cls: "lotus-output-title" });
  title.setText(`${output.result.runnerName} · exit ${output.result.exitCode ?? "?"}`);

  const meta = header.createDiv({ cls: "lotus-output-meta" });
  meta.setText(`${output.result.durationMs} ms · ${new Date(output.result.finishedAt).toLocaleTimeString()}`);
  const copyableOutput = formatCopyableOutput(output);
  if (copyableOutput) {
    const actions = header.createDiv({ cls: "lotus-output-actions" });
    createCopyButton(actions, "Copy output", copyableOutput);
  }

  const body = panel.createDiv({ cls: "lotus-output-body" });
  if (output.result.stdout.trim()) {
    createStream(body, "Stdout", output.result.stdout, visibleLines, output.result.stdoutLanguage, output.result.stdoutRole);
  }
  if (output.result.warning?.trim()) {
    createStream(body, "Warning", output.result.warning, visibleLines);
  }
  if (output.result.stderr.trim()) {
    createStream(body, "Stderr", output.result.stderr, visibleLines);
  }
  if (output.result.displays?.length) {
    for (const display of output.result.displays) {
      createDisplay(body, display, visibleLines, options.displayRenderers ?? []);
    }
  }
  if (output.result.artifacts?.length) {
    createArtifactList(body, output.result.artifacts);
  }
  if (output.sourcePreview?.content.trim()) {
    createSourcePreview(body, output.sourcePreview);
  }
  if (
    !output.result.stdout.trim()
    && !output.result.warning?.trim()
    && !output.result.stderr.trim()
    && !output.result.displays?.length
    && !output.result.artifacts?.length
    && !output.sourcePreview?.content.trim()
  ) {
    const empty = body.createDiv({ cls: "lotus-output-empty" });
    empty.setText("No output");
  }
}

export function renderDisplayOutput(container: HTMLElement, display: lotusDisplayOutput, options: lotusDisplayOutputOptions): void {
  createDisplay(container, display, options.defaultVisibleLines, options.displayRenderers ?? []);
}

function createArtifactList(container: HTMLElement, artifacts: readonly lotusRunArtifact[]): void {
  const section = container.createDiv({ cls: "lotus-output-artifacts" });
  section.createDiv({ cls: "lotus-output-stream-label", text: `Artifacts · ${artifacts.length}` });
  const list = section.createDiv({ cls: "lotus-output-artifact-list" });
  for (const artifact of artifacts) {
    const row = list.createDiv({ cls: "lotus-output-artifact" });
    const info = row.createDiv({ cls: "lotus-output-artifact-info" });
    info.createDiv({ cls: "lotus-output-artifact-name", text: artifact.path || artifact.name });
    info.createDiv({ cls: "lotus-output-artifact-meta", text: `${artifact.mimeType} · ${formatByteSize(artifact.size)}` });
    const actions = row.createDiv({ cls: "lotus-output-artifact-actions" });
    createArtifactButton(actions, "Open artifact", "external-link", () => openArtifact(artifact));
    createArtifactButton(actions, "Download artifact", "download", () => downloadArtifact(artifact));
    if (isTextArtifact(artifact)) {
      createArtifactButton(actions, "Copy artifact", "copy", () => {
        void copyButtonContent("Artifact", decodeArtifactText(artifact));
      });
    }
  }
}

function createArtifactButton(container: HTMLElement, label: string, iconName: string, onClick: () => void): HTMLButtonElement {
  const button = container.createEl("button", { cls: "lotus-output-artifact-button" });
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  setIcon(button, iconName);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function openArtifact(artifact: lotusRunArtifact): void {
  const url = createArtifactObjectUrl(artifact);
  window.open(url, "_blank", "noopener,noreferrer");
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function downloadArtifact(artifact: lotusRunArtifact): void {
  const url = createArtifactObjectUrl(artifact);
  const link = activeDocument.body.createEl("a", { href: url, attr: { download: artifact.name || "artifact" } });
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function createArtifactObjectUrl(artifact: lotusRunArtifact): string {
  return URL.createObjectURL(new Blob([decodeArtifactArrayBuffer(artifact)], { type: artifact.mimeType || "application/octet-stream" }));
}

function decodeArtifactArrayBuffer(artifact: lotusRunArtifact): ArrayBuffer {
  const bytes = decodeArtifactBytes(artifact);
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function decodeArtifactBytes(artifact: lotusRunArtifact): Uint8Array {
  const binary = atob(artifact.dataBase64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function decodeArtifactText(artifact: lotusRunArtifact): string {
  return new TextDecoder().decode(decodeArtifactBytes(artifact));
}

function isTextArtifact(artifact: lotusRunArtifact): boolean {
  return artifact.mimeType.startsWith("text/") || artifact.mimeType === "application/json" || artifact.mimeType === "application/x-tex";
}

function formatByteSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function createStream(
  container: HTMLElement,
  label: string,
  content: string,
  visibleLines: number,
  language?: string,
  role?: "output" | "transpiled-source",
): void {
  const section = container.createDiv({ cls: "lotus-output-stream" });
  const lineCount = countLines(content);
  const header = section.createDiv({ cls: "lotus-output-stream-header" });
  header.createDiv({
    cls: "lotus-output-stream-label",
    text: formatStreamLabel(formatStreamKind(label, language, role), lineCount, visibleLines),
  });
  createCopyButton(header, `Copy ${label.toLowerCase()}`, content);
  const pre = createCodePre(section, content, language, "lotus-output-pre");
  if (visibleLines > 0 && lineCount > visibleLines) {
    pre.addClass("is-scroll-limited");
    pre.style.setProperty("--lotus-output-visible-lines", String(visibleLines));
  }
}

function createCopyButton(container: HTMLElement, label: string, content: string): HTMLButtonElement {
  const button = container.createEl("button", { cls: "lotus-output-copy-button" });
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  setIcon(button, "copy");
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void copyButtonContent(label, content);
  });
  return button;
}

async function copyButtonContent(label: string, content: string): Promise<void> {
  try {
    await writeClipboardText(content);
    new Notice(`${label} copied.`);
  } catch (error) {
    new Notice(`Failed to copy output: ${formatUnknownError(error)}`);
  }
}

async function writeClipboardText(content: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(content);
    return;
  }

  throw new Error("Clipboard is not available.");
}

function createDisplay(
  container: HTMLElement,
  display: lotusDisplayOutput,
  visibleLines: number,
  displayRenderers: readonly lotusDisplayRenderer[],
): void {
  const section = container.createDiv({ cls: "lotus-output-display" });
  const custom = selectCustomDisplayRenderer(display, displayRenderers);
  const selected = custom ?? selectDisplayMime(display);
  section.createDiv({
    cls: "lotus-output-stream-label",
    text: formatDisplayLabel(display, custom ? undefined : selected?.mime),
  });

  if (!selected) {
    section.createEl("pre", {
      cls: "lotus-output-pre",
      text: `Unsupported display data: ${Object.keys(display.data).join(", ") || "(empty)"}`,
    });
    return;
  }

  if (custom) {
    renderCustomDisplay(section, display, custom, visibleLines);
    return;
  }

  if (selected.mime.startsWith("image/") && typeof selected.value === "string") {
    createImageDisplay(section, display, selected.mime, selected.value);
    return;
  }

  if (selected.mime === "text/html" && typeof selected.value === "string") {
    createHtmlDisplay(section, display, selected.mime, selected.value);
    return;
  }

  if (selected.mime === "application/json" || selected.mime.endsWith("+json")) {
    createTextDisplay(section, JSON.stringify(selected.value, null, 2), visibleLines);
    return;
  }

  createTextDisplay(section, typeof selected.value === "string" ? selected.value : JSON.stringify(selected.value, null, 2), visibleLines);
}

function renderCustomDisplay(
  section: HTMLElement,
  display: lotusDisplayOutput,
  selected: SelectedCustomDisplayRenderer,
  visibleLines: number,
): void {
  try {
    const cleanup = selected.renderer.render(section, {
      mime: selected.mime,
      value: selected.value,
      display,
      metadata: readDisplayMetadata(display, selected.mime),
      visibleLines,
    });
    if (isPromiseLike(cleanup)) {
      cleanup
        .then((resolvedCleanup) => {
          installDisplayCleanup(section, resolvedCleanup);
        })
        .catch((error: unknown) => {
          renderCustomDisplayError(section, display, selected.mime, error, visibleLines);
        });
      return;
    }
    installDisplayCleanup(section, cleanup);
  } catch (error) {
    renderCustomDisplayError(section, display, selected.mime, error, visibleLines);
  }
}

function renderCustomDisplayError(
  section: HTMLElement,
  display: lotusDisplayOutput,
  mime: string,
  error: unknown,
  visibleLines: number,
): void {
  section.empty();
  section.createDiv({
    cls: "lotus-output-stream-label",
    text: formatDisplayLabel(display, mime),
  });
  createTextDisplay(section, `Custom display renderer failed: ${formatUnknownError(error)}`, visibleLines);
}

function createImageDisplay(container: HTMLElement, display: lotusDisplayOutput, mime: string, value: string): void {
  const metadata = readDisplayMetadata(display, mime);
  const frame = container.createDiv({ cls: "lotus-output-image-frame" });
  const image = readImageDisplay(display, metadata, mime, value);
  const width = readPositiveNumber(metadata.width);
  const height = readPositiveNumber(metadata.height);
  const viewer = createImageViewer(frame, image, {
    width,
    height,
    initialZoom: 1,
    maxZoom: 3,
    fullscreen: false,
    onFullscreen: () => openImageFullscreen(display, image, width, height, viewer.getZoom()),
  });
  viewer.update();
}

interface LotusImageDisplayData {
  src: string;
  alt: string;
  title: string;
}

interface LotusImageViewer {
  getZoom(): number;
  update(): void;
}

interface LotusImageViewerOptions {
  width?: number;
  height?: number;
  initialZoom: number;
  maxZoom: number;
  fullscreen: boolean;
  onFullscreen?: () => void;
}

function readImageDisplay(display: lotusDisplayOutput, metadata: Record<string, unknown>, mime: string, value: string): LotusImageDisplayData {
  return {
    src: imageDataUrl(mime, value),
    alt: readString(metadata.alt) ?? display.title ?? readString(display.data["text/plain"]) ?? "Lotus display output",
    title: display.title?.trim() || "Lotus display",
  };
}

function createImageViewer(container: HTMLElement, image: LotusImageDisplayData, options: LotusImageViewerOptions): LotusImageViewer {
  const frame = container;
  if (options.fullscreen) {
    frame.addClass("is-fullscreen");
  }
  const toolbar = frame.createDiv({ cls: "lotus-output-image-toolbar" });
  const viewport = frame.createDiv({ cls: "lotus-output-image-viewport" });
  const img = viewport.createEl("img", { cls: "lotus-output-image" });
  img.draggable = false;
  img.src = image.src;
  img.alt = image.alt;
  let baseWidth = options.width ?? 900;
  const baseHeight = options.height;
  let zoom = Math.max(0.5, Math.min(options.maxZoom, options.initialZoom));

  const zoomOut = createImageToolbarButton(toolbar, "Zoom out", "zoom-out", () => setZoom(zoom - 0.15));
  const slider = toolbar.createEl("input", {
    cls: "lotus-output-image-zoom-slider",
    attr: {
      type: "range",
      min: "50",
      max: String(Math.round(options.maxZoom * 100)),
      step: "10",
      value: String(Math.round(zoom * 100)),
      "aria-label": "Image zoom",
    },
  });
  const zoomIn = createImageToolbarButton(toolbar, "Zoom in", "zoom-in", () => setZoom(zoom + 0.15));
  const reset = createImageToolbarButton(toolbar, "Reset zoom", "rotate-ccw", () => setZoom(1));
  if (options.onFullscreen) {
    createImageToolbarButton(toolbar, "Open fullscreen", "maximize-2", options.onFullscreen);
  }
  const valueEl = toolbar.createSpan({ cls: "lotus-output-image-zoom-value", text: `${Math.round(zoom * 100)}%` });

  slider.addEventListener("input", () => {
    setZoom(Number.parseInt(slider.value, 10) / 100);
  });

  installImagePan(viewport);

  img.addEventListener("load", () => {
    if (!options.width && img.naturalWidth > 0) {
      baseWidth = Math.max(360, Math.min(img.naturalWidth, baseWidth));
      updateImageZoom();
    }
  });

  zoomOut.disabled = false;
  zoomIn.disabled = false;
  reset.disabled = false;
  updateImageZoom();

  function setZoom(value: number): void {
    const center = readViewportCenter(viewport);
    zoom = Math.max(0.5, Math.min(options.maxZoom, value));
    updateImageZoom(center);
  }

  function updateImageZoom(center = readViewportCenter(viewport)): void {
    const scaledWidth = Math.round(baseWidth * zoom);
    img.setCssStyles({
      width: `${scaledWidth}px`,
      maxWidth: "none",
      height: baseHeight ? `${Math.round(baseHeight * zoom)}px` : "auto",
    });
    const percent = Math.round(zoom * 100);
    slider.value = String(percent);
    valueEl.setText(`${percent}%`);
    window.requestAnimationFrame(() => restoreViewportCenter(viewport, center));
  }

  return {
    getZoom: () => zoom,
    update: updateImageZoom,
  };
}

function openImageFullscreen(
  display: lotusDisplayOutput,
  image: LotusImageDisplayData,
  width: number | undefined,
  height: number | undefined,
  initialZoom: number,
): void {
  const overlay = createEl("div", { cls: "lotus-output-image-fullscreen" });
  overlay.tabIndex = -1;

  const shell = overlay.createDiv({ cls: "lotus-output-image-fullscreen-shell" });
  const header = shell.createDiv({ cls: "lotus-output-image-fullscreen-header" });
  header.createDiv({ cls: "lotus-output-image-fullscreen-title", text: display.title?.trim() || image.title });
  const close = createImageToolbarButton(header, "Close fullscreen", "x", () => closeFullscreen());
  close.addClass("lotus-output-image-fullscreen-close");

  const frame = shell.createDiv({ cls: "lotus-output-image-frame" });
  createImageViewer(frame, image, {
    width,
    height,
    initialZoom,
    maxZoom: 6,
    fullscreen: true,
  }).update();

  const closeFullscreen = () => {
    overlay.remove();
  };

  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) {
      closeFullscreen();
    }
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closeFullscreen();
    }
  });

  activeDocument.body.appendChild(overlay);
  overlay.focus();
}

function installImagePan(viewport: HTMLElement): void {
  let drag: {
    pointerId: number;
    startX: number;
    startY: number;
    scrollLeft: number;
    scrollTop: number;
  } | null = null;

  viewport.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || !canPanViewport(viewport)) {
      return;
    }
    drag = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      scrollLeft: viewport.scrollLeft,
      scrollTop: viewport.scrollTop,
    };
    viewport.addClass("is-panning");
    viewport.setPointerCapture(event.pointerId);
    event.preventDefault();
    event.stopPropagation();
  });

  viewport.addEventListener("pointermove", (event) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    viewport.scrollLeft = drag.scrollLeft - (event.clientX - drag.startX);
    viewport.scrollTop = drag.scrollTop - (event.clientY - drag.startY);
    event.preventDefault();
    event.stopPropagation();
  });

  const endDrag = (event: PointerEvent) => {
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    drag = null;
    viewport.removeClass("is-panning");
    try {
      viewport.releasePointerCapture(event.pointerId);
    } catch {
      return;
    }
  };

  viewport.addEventListener("pointerup", endDrag);
  viewport.addEventListener("pointercancel", endDrag);
  viewport.addEventListener("lostpointercapture", () => {
    drag = null;
    viewport.removeClass("is-panning");
  });
}

function canPanViewport(viewport: HTMLElement): boolean {
  return viewport.scrollWidth > viewport.clientWidth || viewport.scrollHeight > viewport.clientHeight;
}

function readViewportCenter(viewport: HTMLElement): { x: number; y: number } {
  const width = Math.max(1, viewport.scrollWidth);
  const height = Math.max(1, viewport.scrollHeight);
  return {
    x: (viewport.scrollLeft + viewport.clientWidth / 2) / width,
    y: (viewport.scrollTop + viewport.clientHeight / 2) / height,
  };
}

function restoreViewportCenter(viewport: HTMLElement, center: { x: number; y: number }): void {
  viewport.scrollLeft = Math.max(0, center.x * viewport.scrollWidth - viewport.clientWidth / 2);
  viewport.scrollTop = Math.max(0, center.y * viewport.scrollHeight - viewport.clientHeight / 2);
}

function createImageToolbarButton(container: HTMLElement, label: string, iconName: string, onClick: () => void): HTMLButtonElement {
  const button = container.createEl("button", { cls: "lotus-output-image-zoom-button" });
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  setIcon(button, iconName);
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

function createTextDisplay(container: HTMLElement, content: string, visibleLines: number): void {
  const lineCount = countLines(content);
  const pre = createCodePre(container, content, null, "lotus-output-pre");
  if (visibleLines > 0 && lineCount > visibleLines) {
    pre.addClass("is-scroll-limited");
    pre.style.setProperty("--lotus-output-visible-lines", String(visibleLines));
  }
}

function createHtmlDisplay(container: HTMLElement, display: lotusDisplayOutput, mime: string, value: string): void {
  const metadata = readDisplayMetadata(display, mime);
  const frame = container.createDiv({ cls: "lotus-output-html-frame" });
  const iframe = frame.createEl("iframe", {
    cls: "lotus-output-html-iframe",
    attr: {
      sandbox: "allow-forms allow-popups allow-scripts",
      referrerpolicy: "no-referrer",
      title: display.title?.trim() || "Lotus HTML display",
    },
  });
  const height = readPositiveNumber(metadata.height);
  if (height) {
    iframe.style.height = `${Math.round(height)}px`;
  }
  iframe.srcdoc = value;
}

function selectDisplayMime(display: lotusDisplayOutput): { mime: string; value: unknown } | null {
  for (const mime of [
    "text/html",
    "image/svg+xml",
    "image/png",
    "image/jpeg",
    "image/gif",
    "text/markdown",
    "text/vnd.graphviz",
    "application/json",
    "text/plain",
  ]) {
    if (display.data[mime] != null) {
      return { mime, value: display.data[mime] };
    }
  }

  const firstMime = Object.keys(display.data)[0];
  return firstMime ? { mime: firstMime, value: display.data[firstMime] } : null;
}

interface SelectedCustomDisplayRenderer {
  renderer: lotusDisplayRenderer;
  mime: string;
  value: unknown;
}

function selectCustomDisplayRenderer(
  display: lotusDisplayOutput,
  displayRenderers: readonly lotusDisplayRenderer[],
): SelectedCustomDisplayRenderer | null {
  if (!displayRenderers.length) {
    return null;
  }

  for (const mime of Object.keys(display.data)) {
    const renderer = displayRenderers.find((candidate) => supportsDisplayMime(candidate, mime));
    if (renderer) {
      return { renderer, mime, value: display.data[mime] };
    }
  }

  return null;
}

function supportsDisplayMime(renderer: lotusDisplayRenderer, mime: string): boolean {
  return renderer.mimeTypes.some((pattern) => matchesMimePattern(pattern, mime));
}

function matchesMimePattern(pattern: string, mime: string): boolean {
  const normalizedPattern = pattern.trim().toLowerCase();
  const normalizedMime = mime.trim().toLowerCase();
  if (!normalizedPattern || !normalizedMime) {
    return false;
  }
  if (normalizedPattern === normalizedMime || normalizedPattern === "*/*") {
    return true;
  }
  if (normalizedPattern.endsWith("/*")) {
    return normalizedMime.startsWith(normalizedPattern.slice(0, -1));
  }
  return false;
}

function installDisplayCleanup(section: HTMLElement, cleanup: void | lotusDisplayRendererCleanup): void {
  if (typeof cleanup !== "function") {
    return;
  }

  let cleaned = false;
  const runCleanup = () => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    observer.disconnect();
    try {
      cleanup();
    } catch {
      return;
    }
  };
  const observer = new MutationObserver(() => {
    if (!section.isConnected) {
      runCleanup();
    }
  });

  observer.observe(activeDocument.body, { childList: true, subtree: true });
  window.requestAnimationFrame(() => {
    if (!section.isConnected) {
      runCleanup();
    }
  });
}

function isPromiseLike<T>(value: unknown): value is PromiseLike<T> {
  return typeof value === "object"
    && value !== null
    && typeof (value as { then?: unknown }).then === "function";
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDisplayLabel(display: lotusDisplayOutput, mime: string | undefined): string {
  const title = display.title?.trim() || display.role || "Display";
  return mime ? `${title} · ${mime}` : title;
}

function formatCopyableOutput(output: lotusStoredOutput): string {
  const parts: { label: string; content: string }[] = [];
  addCopyPart(parts, "Stdout", output.result.stdout);
  addCopyPart(parts, "Warning", output.result.warning ?? "");
  addCopyPart(parts, "Stderr", output.result.stderr);

  for (const display of output.result.displays ?? []) {
    const selected = selectDisplayMime(display);
    const content = selected ? stringifyCopyableDisplayValue(selected.value) : "";
    addCopyPart(parts, formatDisplayLabel(display, selected?.mime), content);
  }

  if (parts.length === 1) {
    return parts[0].content;
  }
  return parts.map((part) => `${part.label}\n${part.content}`).join("\n\n");
}

function addCopyPart(parts: { label: string; content: string }[], label: string, content: string): void {
  if (content.trim()) {
    parts.push({ label, content });
  }
}

function stringifyCopyableDisplayValue(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}

function imageDataUrl(mime: string, value: string): string {
  if (value.startsWith("data:")) {
    return value;
  }
  if (mime === "image/svg+xml") {
    return `data:${mime};charset=utf-8,${encodeURIComponent(value)}`;
  }
  return `data:${mime};base64,${value.replace(/\s/g, "")}`;
}

function readDisplayMetadata(display: lotusDisplayOutput, mime: string): Record<string, unknown> {
  const globalMetadata = isRecord(display.metadata) ? display.metadata : {};
  const mimeMetadata = isRecord(globalMetadata[mime]) ? globalMetadata[mime] : {};
  return { ...globalMetadata, ...mimeMetadata };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function createSourcePreview(container: HTMLElement, preview: NonNullable<lotusStoredOutput["sourcePreview"]>): void {
  const details = container.createEl("details", { cls: "lotus-source-preview" });
  details.open = preview.expanded;
  const summary = details.createEl("summary", { cls: "lotus-source-preview-summary" });
  summary.createSpan({ text: preview.stages?.length ? "Source stages" : "Extracted source" });
  summary.createSpan({ cls: "lotus-source-preview-meta", text: formatSourcePreviewMeta(preview) });
  if (preview.stages?.length) {
    for (const stage of preview.stages) {
      const stageDetails = details.createEl("details", { cls: "lotus-source-preview-stage" });
      stageDetails.open = preview.expanded;
      const stageSummary = stageDetails.createEl("summary", { cls: "lotus-source-preview-summary" });
      stageSummary.createSpan({ text: stage.label });
      stageSummary.createSpan({ cls: "lotus-source-preview-meta", text: formatSourceStageMeta(stage) });
      createCodePre(stageDetails, stage.content, stage.language, "lotus-output-pre lotus-source-preview-pre");
    }
    return;
  }
  createCodePre(details, preview.content, preview.language, "lotus-output-pre lotus-source-preview-pre");
}

function createCodePre(container: HTMLElement, content: string, language: string | null | undefined, className: string): HTMLPreElement {
  const pre = container.createEl("pre", { cls: className });
  const code = pre.createEl("code");
  code.setText(content);
  const normalized = normalizeSyntaxLanguage(language);
  if (normalized) {
    addSyntaxLanguageClass(pre, normalized);
    highlightCodeElement(code, content, normalized);
  }
  return pre;
}

function formatSourcePreviewMeta(preview: NonNullable<lotusStoredOutput["sourcePreview"]>): string {
  const capability = preview.capability;
  if (!capability || !preview.showCapabilityMetadata) {
    return `${preview.language} · ${preview.description}`;
  }
  return [
    preview.language,
    preview.description,
    `symbols:${capability.symbolExtraction}`,
    `deps:${capability.dependencyTracing}`,
    `call:${capability.callHarness}`,
  ].join(" · ");
}

function formatSourceStageMeta(stage: lotusSourcePreviewStage): string {
  return [
    stage.language,
    stage.extension,
    stage.description,
    stage.path,
  ].filter(Boolean).join(" · ");
}

function resolveVisibleLines(output: lotusStoredOutput, defaultVisibleLines: number): number {
  const override = output.block.attributes["lotus-output-lines"] ?? output.block.attributes["output-lines"];
  if (override != null) {
    return normalizeVisibleLines(Number.parseInt(override.trim(), 10));
  }
  return normalizeVisibleLines(defaultVisibleLines);
}

function normalizeVisibleLines(value: number): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  return Math.min(Math.floor(value), 2000);
}

function countLines(content: string): number {
  return content.replace(/\n$/, "").split("\n").length;
}

function formatStreamLabel(label: string, lineCount: number, visibleLines: number): string {
  if (visibleLines > 0 && lineCount > visibleLines) {
    return `${label} · ${lineCount} lines · showing ${visibleLines}`;
  }
  return label;
}

function formatStreamKind(label: string, language: string | undefined, role: "output" | "transpiled-source" | undefined): string {
  const kind = role === "transpiled-source" ? "Transpiled source" : label;
  const normalized = normalizeSyntaxLanguage(language);
  return normalized ? `${kind} · ${normalized}` : kind;
}

export function createRunningPanel(options: lotusRunningPanelOptions = {}): HTMLDivElement {
  const panel = createEl("div", { cls: "lotus-output-panel is-running" });

  const header = panel.createDiv({ cls: "lotus-output-header" });
  const spinner = header.createDiv({ cls: "lotus-spinner" });
  setIcon(spinner, "loader-circle");
  const title = header.createDiv({ cls: "lotus-output-title" });
  title.setText(options.runnerName ? `Running ${options.runnerName}` : "Running");
  const meta = header.createDiv({ cls: "lotus-output-meta" });
  meta.setText("Executing...");
  spinner.setAttribute("aria-hidden", "true");

  const body = panel.createDiv({ cls: "lotus-output-body" });
  if (options.stdout?.length) {
    createStream(body, "Stdout", options.stdout, 200);
  }
  if (options.stderr?.length) {
    createStream(body, "Stderr", options.stderr, 200);
  }
  if (options.inputEnabled && options.onSendInput) {
    createLiveInput(body, options);
  }

  return panel;
}

function createLiveInput(container: HTMLElement, options: lotusRunningPanelOptions): void {
  const form = container.createDiv({ cls: "lotus-live-input" });
  const textarea = form.createEl("textarea", {
    cls: "lotus-live-input-field",
    attr: {
      rows: "2",
      placeholder: "Stdin for the running process",
    },
  });
  const actions = form.createDiv({ cls: "lotus-live-input-actions" });
  const sendButton = actions.createEl("button", { text: "Send" });
  const eofButton = actions.createEl("button", { text: "EOF" });

  const send = () => {
    const value = textarea.value;
    if (!value.length) {
      return;
    }
    options.onSendInput?.(value.endsWith("\n") ? value : `${value}\n`);
    textarea.value = "";
    textarea.focus();
  };

  textarea.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      send();
    }
  });
  sendButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    send();
  });
  eofButton.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    options.onCloseInput?.();
  });
}
