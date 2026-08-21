import * as d3 from "d3";
import ELK from "elkjs";
import type JXG from "jsxgraph";
import type cytoscape from "cytoscape";
import type { lotusDisplayRenderer, lotusDisplayRendererContext, lotusDisplayRendererCleanup } from "../../engine/types";

export const LOTUS_D3_MIME = "application/vnd.lotus.d3+json";
export const LOTUS_PLOTLY_MIME = "application/vnd.lotus.plotly+json";
export const PLOTLY_MIME = "application/vnd.plotly.v1+json";
export const LOTUS_JSXGRAPH_MIME = "application/vnd.lotus.jsxgraph+json";
export const LOTUS_ELK_MIME = "application/vnd.lotus.elk+json";
export const ELK_MIME = "application/vnd.elk+json";
export const LOTUS_HWSCHEMATIC_MIME = "application/vnd.lotus.hwschematic+json";
export const LOTUS_CYTOSCAPE_MIME = "application/vnd.lotus.cytoscape+json";
export const CYTOSCAPE_MIME = "application/vnd.cytoscapejs+json";

const SVG_NS = "http://www.w3.org/2000/svg";
const GRAPH_BLACK = "#111111";
const GRAPH_WHITE = "#ffffff";
const GRAPH_BORDER = "#111111";
const GRAPH_GRID = "#e5e5e5";
let graphIdCounter = 0;
let jsxGraphLoad: Promise<JsxGraphModule> | undefined;
let cytoscapeLoad: Promise<CytoscapeModule> | undefined;

type JsxGraphModule = typeof JXG;
type CytoscapeModule = typeof cytoscape;

interface ElkInstance {
  layout(graph: unknown, options?: Record<string, unknown>): Promise<unknown>;
  terminateWorker?: () => void;
}

interface GraphDimensions {
  width: number;
  height: number;
}

interface D3ChartSpec {
  kind: "bar" | "line" | "scatter";
  data: Record<string, unknown>[];
  xKey: string;
  yKey: string;
  labelKey: string;
  valueKey: string;
  color: string;
}

interface ChartPoint {
  x: number;
  y: number;
  label: string;
}

interface ElkNode {
  id?: string | number;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  labels?: Array<{ text?: string; width?: number; height?: number }>;
  children?: ElkNode[];
  edges?: ElkEdge[];
}

interface ElkEdge {
  id?: string | number;
  sources?: Array<string | number>;
  targets?: Array<string | number>;
  sections?: ElkEdgeSection[];
}

interface ElkEdgeSection {
  startPoint?: ElkPoint;
  endPoint?: ElkPoint;
  bendPoints?: ElkPoint[];
}

interface ElkPoint {
  x?: number;
  y?: number;
}

interface AbsoluteNode {
  id: string;
  label: string;
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

interface AbsoluteEdge {
  id: string;
  source?: string;
  target?: string;
  sections?: ElkEdgeSection[];
  offsetX: number;
  offsetY: number;
}

export function createJavaScriptGraphDisplayRenderers(): lotusDisplayRenderer[] {
  return [
    {
      id: "lotus-d3",
      mimeTypes: [LOTUS_D3_MIME],
      render: renderD3Display,
    },
    {
      id: "lotus-plotly",
      mimeTypes: [LOTUS_PLOTLY_MIME, PLOTLY_MIME],
      render: renderPlotlyDisplay,
    },
    {
      id: "lotus-jsxgraph",
      mimeTypes: [LOTUS_JSXGRAPH_MIME],
      render: renderJsxGraphDisplay,
    },
    {
      id: "lotus-elk",
      mimeTypes: [LOTUS_ELK_MIME, ELK_MIME],
      render: renderElkDisplay,
    },
    {
      id: "lotus-hwschematic",
      mimeTypes: [LOTUS_HWSCHEMATIC_MIME],
      render: renderHwSchematicDisplay,
    },
    {
      id: "lotus-cytoscape",
      mimeTypes: [LOTUS_CYTOSCAPE_MIME, CYTOSCAPE_MIME],
      render: renderCytoscapeDisplay,
    },
  ];
}

async function renderD3Display(container: HTMLElement, context: lotusDisplayRendererContext): Promise<lotusDisplayRendererCleanup> {
  const { surface } = createGraphSurface(container, context, 720, 360);
  const spec = readD3ChartSpec(context.value);
  try {
    renderD3Chart(surface, spec, readDimensions(context, 720, 360));
  } catch (error) {
    surface.empty();
    createGraphNotice(surface, `D3 could not render this chart, so Lotus rendered a static fallback: ${formatUnknownError(error)}`);
    renderNativeChart(surface, spec, readDimensions(context, 720, 360));
  }
  return () => surface.empty();
}

async function renderPlotlyDisplay(container: HTMLElement, context: lotusDisplayRendererContext): Promise<lotusDisplayRendererCleanup> {
  const { surface } = createGraphSurface(container, context, 760, 420);
  const dimensions = readDimensions(context, 760, 420);
  renderNativeChart(surface, readPlotlyChartSpec(context.value), dimensions);
  addSvgPrintSnapshot(surface, readDisplayAlt(context, "Plotly figure"));
  return () => surface.empty();
}

async function renderJsxGraphDisplay(container: HTMLElement, context: lotusDisplayRendererContext): Promise<lotusDisplayRendererCleanup> {
  const { surface } = createGraphSurface(container, context, 520, 420);
  const jxg = await loadJsxGraph();
  const payload = readRecordPayload(context.value);
  const boardOptions = readRecord(payload.board) ?? {};
  const boardId = nextGraphId("jsxgraph");
  surface.id = boardId;
  surface.addClass("jxgbox");
  const board = jxg.JSXGraph.initBoard(boardId, {
    boundingbox: readBoundingBox(payload.boundingbox) ?? [-5, 5, 5, -5],
    axis: payload.axis !== false,
    showCopyright: false,
    showNavigation: true,
    ...boardOptions,
  });

  for (const objectSpec of readArray(payload.objects)) {
    const objectRecord = readRecord(objectSpec);
    if (!objectRecord) {
      continue;
    }
    const type = readString(objectRecord.type);
    if (!type) {
      continue;
    }
    const args = readArray(objectRecord.args ?? objectRecord.parameters);
    const attributes = {
      ...defaultJsxGraphAttributes(type),
      ...(readRecord(objectRecord.attributes) ?? readRecord(objectRecord.options) ?? {}),
    };
    board.create(type, args, attributes);
  }
  window.requestAnimationFrame(() => {
    addSvgPrintSnapshot(surface, readDisplayAlt(context, "JSXGraph board"));
  });

  return () => {
    jxg.JSXGraph.freeBoard(board);
    surface.empty();
  };
}

async function renderElkDisplay(container: HTMLElement, context: lotusDisplayRendererContext): Promise<lotusDisplayRendererCleanup> {
  const { surface } = createGraphSurface(container, context, 760, 420);
  const payload = readRecordPayload(context.value);
  const graph = readGraphPayload(payload);

  try {
    const elk = await createElkInstance(payload);
    const layoutOptions = readRecord(payload.layoutOptions) ?? { "elk.algorithm": "layered" };
    const laidOutGraph = await elk.layout(cloneJson(graph), { layoutOptions });
    renderElkGraph(surface, readElkNode(laidOutGraph), readDimensions(context, 760, 420));
    return () => {
      elk.terminateWorker?.();
      surface.empty();
    };
  } catch (error) {
    surface.empty();
    createGraphNotice(surface, `ELK could not be loaded, so Lotus rendered a static fallback: ${formatUnknownError(error)}`);
    renderElkGraph(surface, assignFallbackElkLayout(readElkNode(graph)), readDimensions(context, 760, 420));
    return () => surface.empty();
  }
}

async function renderHwSchematicDisplay(container: HTMLElement, context: lotusDisplayRendererContext): Promise<lotusDisplayRendererCleanup> {
  const { surface } = createGraphSurface(container, context, 820, 460);
  const payload = readRecordPayload(context.value);
  const graph = readGraphPayload(payload);
  const dimensions = readDimensions(context, 820, 460);

  surface.addClass("lotus-hwschematic-surface");
  createGraphNotice(surface, "Lotus rendered this hardware schematic with the built-in ELK fallback.");
  renderElkGraph(surface, assignFallbackElkLayout(readElkNode(readHwSchematicGraph(graph, payload))), dimensions);

  return () => surface.empty();
}

async function renderCytoscapeDisplay(container: HTMLElement, context: lotusDisplayRendererContext): Promise<lotusDisplayRendererCleanup> {
  const { surface } = createGraphSurface(container, context, 700, 420);
  const payload = readRecordPayload(context.value);
  try {
    const cytoscape = await loadCytoscape();
    const options = payload as Partial<cytoscape.CytoscapeOptions>;
    const cy = cytoscape({
      ...options,
      container: surface,
      elements: options.elements ?? [],
      style: options.style ?? defaultCytoscapeStyle(),
      layout: options.layout ?? { name: "cose" },
    });
    window.requestAnimationFrame(() => {
      cy.fit();
      addDataUrlPrintSnapshot(surface, cy.png({ output: "base64uri", full: true, scale: 2 }), readDisplayAlt(context, "Cytoscape.js graph"));
    });
    return () => {
      cy.destroy();
      surface.empty();
    };
  } catch (error) {
    surface.empty();
    createGraphNotice(surface, `Cytoscape.js could not be loaded, so Lotus rendered a static fallback: ${formatUnknownError(error)}`);
    renderCytoscapeFallback(surface, payload, readDimensions(context, 700, 420));
    return () => surface.empty();
  }
}

function createGraphSurface(
  container: HTMLElement,
  context: lotusDisplayRendererContext,
  defaultWidth: number,
  defaultHeight: number,
): { frame: HTMLElement; surface: HTMLElement } {
  const dimensions = readDimensions(context, defaultWidth, defaultHeight);
  const frame = container.createDiv({ cls: "lotus-js-graph-frame" });
  frame.style.setProperty("--lotus-js-graph-height", `${dimensions.height}px`);
  const surface = frame.createDiv({ cls: "lotus-js-graph-surface" });
  surface.style.minHeight = `${dimensions.height}px`;
  surface.style.height = `${dimensions.height}px`;
  surface.style.maxWidth = `${dimensions.width}px`;
  return { frame, surface };
}

function readDimensions(context: lotusDisplayRendererContext, defaultWidth: number, defaultHeight: number): GraphDimensions {
  const payload = readRecord(context.value);
  return {
    width: readPositiveNumber(context.metadata.width) ?? readPositiveNumber(payload?.width) ?? defaultWidth,
    height: readPositiveNumber(context.metadata.height) ?? readPositiveNumber(payload?.height) ?? defaultHeight,
  };
}

function readDisplayAlt(context: lotusDisplayRendererContext, fallback: string): string {
  return readString(context.metadata.alt)
    ?? context.display.title
    ?? readString(context.display.data["text/plain"])
    ?? fallback;
}

function readD3ChartSpec(value: unknown): D3ChartSpec {
  const payload = Array.isArray(value) ? { data: value } : readRecordPayload(value);
  const kind = readString(payload.kind)?.toLowerCase();
  const data = readArray(payload.data)
    .map((datum) => readRecord(datum))
    .filter((datum): datum is Record<string, unknown> => Boolean(datum));

  return {
    kind: kind === "line" || kind === "scatter" ? kind : "bar",
    data,
    xKey: readString(payload.xKey) ?? "x",
    yKey: readString(payload.yKey) ?? "y",
    labelKey: readString(payload.labelKey) ?? "label",
    valueKey: readString(payload.valueKey) ?? "value",
    color: readString(payload.color) ?? GRAPH_BLACK,
  };
}

function renderD3Chart(surface: HTMLElement, spec: D3ChartSpec, dimensions: GraphDimensions): void {
  const margin = { top: 22, right: 24, bottom: 42, left: 52 };
  const innerWidth = Math.max(1, dimensions.width - margin.left - margin.right);
  const innerHeight = Math.max(1, dimensions.height - margin.top - margin.bottom);
  const svg = d3.select(surface)
    .append("svg")
    .attr("viewBox", `0 0 ${dimensions.width} ${dimensions.height}`)
    .attr("width", "100%")
    .attr("height", dimensions.height);

  const plot = svg.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

  if (spec.kind === "bar") {
    const bars = spec.data.map((datum, index) => ({
      label: readDatumLabel(datum, spec, index),
      value: readDatumValue(datum, spec, index),
    }));
    const maxValue = Math.max(1, d3.max(bars, (datum) => datum.value) ?? 1);
    const x = d3.scaleBand()
      .domain(bars.map((datum) => datum.label))
      .range([0, innerWidth])
      .padding(0.22);
    const y = d3.scaleLinear()
      .domain([0, maxValue])
      .nice()
      .range([innerHeight, 0]);

    plot.append("g")
      .attr("transform", `translate(0,${innerHeight})`)
      .call(d3.axisBottom(x));
    plot.append("g").call(d3.axisLeft(y).ticks(5));
    plot.selectAll("rect")
      .data(bars)
      .join("rect")
      .attr("x", (datum: { label: string }) => Number(x(datum.label)))
      .attr("y", (datum: { value: number }) => Number(y(datum.value)))
      .attr("width", x.bandwidth())
      .attr("height", (datum: { value: number }) => innerHeight - Number(y(datum.value)))
      .attr("rx", 4)
      .attr("fill", spec.color);
    plot.selectAll("text.lotus-d3-bar-value")
      .data(bars)
      .join("text")
      .attr("class", "lotus-d3-bar-value")
      .attr("x", (datum: { label: string }) => Number(x(datum.label)) + Number(x.bandwidth()) / 2)
      .attr("y", (datum: { value: number }) => Math.min(innerHeight - 8, Number(y(datum.value)) + 18))
      .attr("text-anchor", "middle")
      .attr("fill", GRAPH_WHITE)
      .attr("font-size", 12)
      .attr("font-family", "var(--font-interface)")
      .text((datum: { value: number }) => String(datum.value));
    return;
  }

  const points = readChartPoints(spec);
  const maxX = Math.max(1, ...points.map((point) => point.x));
  const maxY = Math.max(1, ...points.map((point) => point.y));
  const x = d3.scaleLinear().domain([0, maxX]).nice().range([0, innerWidth]);
  const y = d3.scaleLinear().domain([0, maxY]).nice().range([innerHeight, 0]);
  plot.append("g").attr("transform", `translate(0,${innerHeight})`).call(d3.axisBottom(x).ticks(5));
  plot.append("g").call(d3.axisLeft(y).ticks(5));

  if (spec.kind === "line") {
    const line = d3.line<ChartPoint>()
      .x((datum: ChartPoint) => Number(x(datum.x)))
      .y((datum: ChartPoint) => Number(y(datum.y)));
    plot.append("path")
      .datum(points)
      .attr("fill", "none")
      .attr("stroke", spec.color)
      .attr("stroke-width", 2)
      .attr("d", line);
  }

  plot.selectAll("circle")
    .data(points)
    .join("circle")
    .attr("cx", (datum: ChartPoint) => Number(x(datum.x)))
    .attr("cy", (datum: ChartPoint) => Number(y(datum.y)))
    .attr("r", 4)
    .attr("fill", spec.color);
}

function renderNativeChart(surface: HTMLElement, spec: D3ChartSpec, dimensions: GraphDimensions): void {
  const margin = { top: 22, right: 24, bottom: 42, left: 52 };
  const innerWidth = Math.max(1, dimensions.width - margin.left - margin.right);
  const innerHeight = Math.max(1, dimensions.height - margin.top - margin.bottom);
  const svg = createResponsiveSvg(dimensions);
  surface.appendChild(svg);
  const plot = svgGroup(margin.left, margin.top);
  svg.appendChild(plot);
  drawAxes(plot, innerWidth, innerHeight);

  if (spec.kind === "bar") {
    const bars = spec.data.map((datum, index) => ({
      label: readDatumLabel(datum, spec, index),
      value: readDatumValue(datum, spec, index),
    }));
    const maxValue = Math.max(1, ...bars.map((datum) => datum.value));
    const barWidth = Math.max(8, innerWidth / Math.max(1, bars.length) * 0.68);
    const step = innerWidth / Math.max(1, bars.length);
    bars.forEach((bar, index) => {
      const height = innerHeight * (bar.value / maxValue);
      const rect = svgElement("rect");
      rect.setAttribute("x", `${index * step + (step - barWidth) / 2}`);
      rect.setAttribute("y", `${innerHeight - height}`);
      rect.setAttribute("width", `${barWidth}`);
      rect.setAttribute("height", `${height}`);
      rect.setAttribute("rx", "4");
      rect.setAttribute("fill", spec.color);
      plot.appendChild(rect);
      const valueText = appendSvgText(plot, String(bar.value), index * step + step / 2, Math.min(innerHeight - 8, innerHeight - height + 18), "middle", "lotus-js-graph-bar-value");
      valueText.setAttribute("fill", GRAPH_WHITE);
      appendSvgText(plot, bar.label, index * step + step / 2, innerHeight + 22, "middle", "lotus-js-graph-axis-text");
    });
    return;
  }

  const points = readChartPoints(spec);
  const maxX = Math.max(1, ...points.map((point) => point.x));
  const maxY = Math.max(1, ...points.map((point) => point.y));
  const mapped = points.map((point) => ({
    x: (point.x / maxX) * innerWidth,
    y: innerHeight - (point.y / maxY) * innerHeight,
  }));
  if (spec.kind === "line" && mapped.length) {
    const polyline = svgElement("polyline");
    polyline.setAttribute("points", mapped.map((point) => `${point.x},${point.y}`).join(" "));
    polyline.setAttribute("fill", "none");
    polyline.setAttribute("stroke", spec.color);
    polyline.setAttribute("stroke-width", "2");
    plot.appendChild(polyline);
  }
  for (const point of mapped) {
    const circle = svgElement("circle");
    circle.setAttribute("cx", `${point.x}`);
    circle.setAttribute("cy", `${point.y}`);
    circle.setAttribute("r", "4");
    circle.setAttribute("fill", spec.color);
    plot.appendChild(circle);
  }
}

function readPlotlyChartSpec(value: unknown): D3ChartSpec {
  const payload = Array.isArray(value) ? { data: value } : readRecordPayload(value);
  const trace = readRecord(readArray(payload.data)[0]) ?? {};
  const type = readString(trace.type)?.toLowerCase();
  const mode = readString(trace.mode)?.toLowerCase() ?? "";
  const xValues = readArray(trace.x);
  const yValues = readArray(trace.y);
  const textValues = readArray(trace.text);
  const labels = xValues.length ? xValues : textValues;
  const dataLength = Math.max(xValues.length, yValues.length, labels.length);
  const data = Array.from({ length: dataLength }, (_, index) => ({
    x: readNumber(xValues[index]) ?? index,
    y: readNumber(yValues[index]) ?? 0,
    label: readString(labels[index]) ?? readString(textValues[index]) ?? String(index + 1),
    value: readNumber(yValues[index]) ?? 0,
  }));

  return {
    kind: type === "bar" ? "bar" : mode.includes("lines") ? "line" : "scatter",
    data,
    xKey: "x",
    yKey: "y",
    labelKey: "label",
    valueKey: "value",
    color: GRAPH_BLACK,
  };
}

function defaultJsxGraphAttributes(type: string): Record<string, unknown> {
  switch (type.toLowerCase()) {
    case "point":
      return {
        strokeColor: GRAPH_BLACK,
        fillColor: GRAPH_BLACK,
        highlightStrokeColor: GRAPH_BLACK,
        highlightFillColor: GRAPH_BLACK,
        label: { color: GRAPH_BLACK },
      };
    case "line":
    case "segment":
    case "arrow":
    case "circle":
    case "curve":
    case "functiongraph":
      return {
        strokeColor: GRAPH_BLACK,
        highlightStrokeColor: GRAPH_BLACK,
      };
    case "polygon":
      return {
        borders: { strokeColor: GRAPH_BLACK },
        fillColor: GRAPH_WHITE,
        highlightFillColor: GRAPH_WHITE,
      };
    default:
      return {};
  }
}

function readChartPoints(spec: D3ChartSpec): ChartPoint[] {
  return spec.data.map((datum, index) => ({
    x: readNumber(datum[spec.xKey]) ?? index,
    y: readDatumValue(datum, spec, index),
    label: readDatumLabel(datum, spec, index),
  }));
}

function readDatumValue(datum: Record<string, unknown>, spec: D3ChartSpec, index: number): number {
  return readNumber(datum[spec.yKey]) ?? readNumber(datum[spec.valueKey]) ?? index;
}

function readDatumLabel(datum: Record<string, unknown>, spec: D3ChartSpec, index: number): string {
  return readString(datum[spec.labelKey])
    ?? readString(datum[spec.xKey])
    ?? readString(datum.id)
    ?? String(index + 1);
}

async function createElkInstance(payload: Record<string, unknown>): Promise<ElkInstance> {
  const options = readRecord(payload.elkOptions) ?? {};
  return new ELK(options);
}

function readGraphPayload(payload: Record<string, unknown>): unknown {
  return payload.graph ?? payload.elk ?? payload.schematic ?? payload;
}

function readHwSchematicGraph(graph: unknown, payload: Record<string, unknown>): unknown {
  const selectedRoot = readString(payload.root);
  if (!selectedRoot) {
    return graph;
  }
  return selectGraphRootByPath(graph, selectedRoot) ?? graph;
}

function selectGraphRootByPath(graph: unknown, rootPath: string): Record<string, unknown> | null {
  const root = readRecord(graph);
  if (!root) {
    return null;
  }
  const segments = rootPath
    .split(/[/.]/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (!segments.length || graphNodeMatchesPathSegment(root, segments[0])) {
    segments.shift();
  }

  let current: Record<string, unknown> | null = root;
  for (const segment of segments) {
    current = current ? findGraphChildByPathSegment(current, segment) : null;
    if (!current) {
      return null;
    }
  }
  return current;
}

function findGraphChildByPathSegment(node: Record<string, unknown>, segment: string): Record<string, unknown> | null {
  for (const child of readArray(node.children)) {
    const childRecord = readRecord(child);
    if (childRecord && graphNodeMatchesPathSegment(childRecord, segment)) {
      return childRecord;
    }
  }
  return null;
}

function graphNodeMatchesPathSegment(node: Record<string, unknown>, segment: string): boolean {
  if (String(node.id ?? "") === segment) {
    return true;
  }
  const labels = readArray(node.labels)
    .map((label) => readRecord(label))
    .filter((label): label is Record<string, unknown> => Boolean(label));
  return labels.some((label) => readString(label.text) === segment || String(label.id ?? "") === segment);
}

function readElkNode(value: unknown): ElkNode {
  const record = readRecord(value);
  if (!record) {
    throw new Error("ELK graph payload must be an object.");
  }
  return record;
}

function assignFallbackElkLayout(root: ElkNode): ElkNode {
  const graph = cloneJson(root) as ElkNode;
  const children = graph.children ?? [];
  const width = graph.width ?? Math.max(220, children.length * 150);
  graph.width = width;
  graph.height = graph.height ?? Math.max(110, children.length ? 170 : 80);
  children.forEach((child, index) => {
    child.width = child.width ?? 100;
    child.height = child.height ?? 48;
    child.x = child.x ?? 40 + index * 140;
    child.y = child.y ?? 48 + (index % 2) * 46;
    assignFallbackElkLayout(child);
  });
  return graph;
}

function renderElkGraph(surface: HTMLElement, graph: ElkNode, dimensions: GraphDimensions): void {
  const { nodes, edges } = collectElkGraph(graph);
  const bounds = readGraphBounds(nodes, dimensions);
  const svg = createResponsiveSvg({
    width: Math.max(dimensions.width, bounds.width + 48),
    height: Math.max(dimensions.height, bounds.height + 48),
  });
  svg.setAttribute("viewBox", `${bounds.x - 24} ${bounds.y - 24} ${Math.max(dimensions.width, bounds.width + 48)} ${Math.max(dimensions.height, bounds.height + 48)}`);
  surface.appendChild(svg);

  const defs = svgElement("defs");
  const marker = svgElement("marker");
  marker.setAttribute("id", nextGraphId("lotus-elk-arrow"));
  marker.setAttribute("viewBox", "0 0 10 10");
  marker.setAttribute("refX", "9");
  marker.setAttribute("refY", "5");
  marker.setAttribute("markerWidth", "6");
  marker.setAttribute("markerHeight", "6");
  marker.setAttribute("orient", "auto-start-reverse");
  const arrow = svgElement("path");
  arrow.setAttribute("d", "M 0 0 L 10 5 L 0 10 z");
  arrow.setAttribute("fill", GRAPH_BLACK);
  marker.appendChild(arrow);
  defs.appendChild(marker);
  svg.appendChild(defs);
  const markerUrl = `url(#${marker.id})`;

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  for (const edge of edges) {
    const path = svgElement("path");
    path.setAttribute("class", "lotus-js-graph-edge");
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", GRAPH_BLACK);
    path.setAttribute("stroke-width", "1.8");
    path.setAttribute("marker-end", markerUrl);
    path.setAttribute("d", readElkEdgePath(edge, nodeById));
    svg.appendChild(path);
  }

  for (const node of nodes) {
    const group = svgElement("g");
    group.setAttribute("class", "lotus-js-graph-node");
    group.setAttribute("transform", `translate(${node.x},${node.y})`);
    const rect = svgElement("rect");
    rect.setAttribute("width", `${node.width}`);
    rect.setAttribute("height", `${node.height}`);
    rect.setAttribute("rx", "6");
    if (node.depth === 0 && nodes.length > 1) {
      continue;
    }
    rect.setAttribute("fill", GRAPH_BLACK);
    rect.setAttribute("stroke", GRAPH_BORDER);
    rect.setAttribute("stroke-width", "1.6");
    group.appendChild(rect);
    const text = appendSvgText(group, node.label, node.width / 2, node.height / 2 + 4, "middle", "lotus-js-graph-node-label");
    text.setAttribute("fill", GRAPH_WHITE);
    svg.appendChild(group);
  }
}

function collectElkGraph(root: ElkNode): { nodes: AbsoluteNode[]; edges: AbsoluteEdge[] } {
  const nodes: AbsoluteNode[] = [];
  const edges: AbsoluteEdge[] = [];
  const walk = (node: ElkNode, offsetX: number, offsetY: number, depth: number) => {
    const x = offsetX + (node.x ?? 0);
    const y = offsetY + (node.y ?? 0);
    const id = String(node.id ?? (depth === 0 ? "root" : nodes.length + 1));
    nodes.push({
      id,
      label: readElkNodeLabel(node, id),
      x,
      y,
      width: node.width ?? 100,
      height: node.height ?? 48,
      depth,
    });
    for (const edge of node.edges ?? []) {
      edges.push({
        id: String(edge.id ?? `edge-${edges.length + 1}`),
        source: edge.sources?.[0] != null ? String(edge.sources[0]) : undefined,
        target: edge.targets?.[0] != null ? String(edge.targets[0]) : undefined,
        sections: edge.sections,
        offsetX: x,
        offsetY: y,
      });
    }
    for (const child of node.children ?? []) {
      walk(child, x, y, depth + 1);
    }
  };
  walk(root, 0, 0, 0);
  return { nodes, edges };
}

function readElkNodeLabel(node: ElkNode, fallback: string): string {
  return node.labels?.map((label) => label.text).find((text): text is string => Boolean(text?.trim())) ?? fallback;
}

function readGraphBounds(nodes: AbsoluteNode[], dimensions: GraphDimensions): { x: number; y: number; width: number; height: number } {
  if (!nodes.length) {
    return { x: 0, y: 0, width: dimensions.width, height: dimensions.height };
  }
  const minX = Math.min(...nodes.map((node) => node.x));
  const minY = Math.min(...nodes.map((node) => node.y));
  const maxX = Math.max(...nodes.map((node) => node.x + node.width));
  const maxY = Math.max(...nodes.map((node) => node.y + node.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function readElkEdgePath(edge: AbsoluteEdge, nodeById: Map<string, AbsoluteNode>): string {
  const section = edge.sections?.[0];
  if (section?.startPoint && section.endPoint) {
    const points = [
      section.startPoint,
      ...(section.bendPoints ?? []),
      section.endPoint,
    ];
    return points.map((point, index) => `${index === 0 ? "M" : "L"} ${edge.offsetX + (point.x ?? 0)} ${edge.offsetY + (point.y ?? 0)}`).join(" ");
  }

  const source = edge.source ? nodeById.get(edge.source) : undefined;
  const target = edge.target ? nodeById.get(edge.target) : undefined;
  if (!source || !target) {
    return "M 0 0 L 0 0";
  }
  const start = { x: source.x + source.width, y: source.y + source.height / 2 };
  const end = { x: target.x, y: target.y + target.height / 2 };
  const middleX = (start.x + end.x) / 2;
  return `M ${start.x} ${start.y} C ${middleX} ${start.y}, ${middleX} ${end.y}, ${end.x} ${end.y}`;
}

function renderCytoscapeFallback(surface: HTMLElement, payload: Record<string, unknown>, dimensions: GraphDimensions): void {
  const elements = readArray(payload.elements)
    .map((element) => readRecord(element))
    .filter((element): element is Record<string, unknown> => Boolean(element));
  const nodes = elements.filter((element) => !readRecord(element.data)?.source).map((element, index) => {
    const data = readRecord(element.data) ?? {};
    return {
      id: readString(data.id) ?? String(index + 1),
      label: readString(data.label) ?? readString(data.id) ?? String(index + 1),
    };
  });
  const edges = elements.filter((element) => Boolean(readRecord(element.data)?.source)).map((element, index) => {
    const data = readRecord(element.data) ?? {};
    return {
      id: readString(data.id) ?? `edge-${index + 1}`,
      source: readString(data.source) ?? "",
      target: readString(data.target) ?? "",
    };
  });
  const radius = Math.max(70, Math.min(dimensions.width, dimensions.height) / 2 - 70);
  const center = { x: dimensions.width / 2, y: dimensions.height / 2 };
  const positions = new Map<string, { x: number; y: number }>();
  nodes.forEach((node, index) => {
    const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length) - Math.PI / 2;
    positions.set(node.id, {
      x: center.x + radius * Math.cos(angle),
      y: center.y + radius * Math.sin(angle),
    });
  });

  const svg = createResponsiveSvg(dimensions);
  surface.appendChild(svg);
  for (const edge of edges) {
    const source = positions.get(edge.source);
    const target = positions.get(edge.target);
    if (!source || !target) {
      continue;
    }
    const line = svgElement("line");
    line.setAttribute("x1", `${source.x}`);
    line.setAttribute("y1", `${source.y}`);
    line.setAttribute("x2", `${target.x}`);
    line.setAttribute("y2", `${target.y}`);
    line.setAttribute("stroke", GRAPH_BLACK);
    line.setAttribute("stroke-width", "2");
    svg.appendChild(line);
  }
  for (const node of nodes) {
    const position = positions.get(node.id);
    if (!position) {
      continue;
    }
    const rect = svgElement("rect");
    rect.setAttribute("x", `${position.x - 38}`);
    rect.setAttribute("y", `${position.y - 18}`);
    rect.setAttribute("width", "76");
    rect.setAttribute("height", "36");
    rect.setAttribute("rx", "7");
    rect.setAttribute("fill", GRAPH_BLACK);
    rect.setAttribute("stroke", GRAPH_BLACK);
    rect.setAttribute("stroke-width", "2");
    svg.appendChild(rect);
    const text = appendSvgText(svg, node.label, position.x, position.y + 4, "middle", "lotus-js-graph-node-label");
    text.setAttribute("fill", GRAPH_WHITE);
  }
}

function defaultCytoscapeStyle(): cytoscape.StylesheetJson {
  return [
    {
      selector: "node",
      style: {
        "background-color": GRAPH_BLACK,
        "shape": "round-rectangle",
        "label": "data(label)",
        "color": GRAPH_WHITE,
        "text-valign": "center",
        "text-halign": "center",
        "text-outline-width": 0,
        "width": 64,
        "height": 34,
      },
    },
    {
      selector: "edge",
      style: {
        "width": 2,
        "line-color": GRAPH_BLACK,
        "target-arrow-color": GRAPH_BLACK,
        "target-arrow-shape": "triangle",
        "curve-style": "bezier",
      },
    },
  ];
}

function drawAxes(group: SVGGElement, width: number, height: number): void {
  const xAxis = svgElement("line");
  xAxis.setAttribute("x1", "0");
  xAxis.setAttribute("y1", `${height}`);
  xAxis.setAttribute("x2", `${width}`);
  xAxis.setAttribute("y2", `${height}`);
  xAxis.setAttribute("stroke", GRAPH_BLACK);
  xAxis.setAttribute("stroke-width", "1.2");
  group.appendChild(xAxis);

  const yAxis = svgElement("line");
  yAxis.setAttribute("x1", "0");
  yAxis.setAttribute("y1", "0");
  yAxis.setAttribute("x2", "0");
  yAxis.setAttribute("y2", `${height}`);
  yAxis.setAttribute("stroke", GRAPH_BLACK);
  yAxis.setAttribute("stroke-width", "1.2");
  group.appendChild(yAxis);
}

function createResponsiveSvg(dimensions: GraphDimensions): SVGSVGElement {
  const svg = svgElement("svg");
  svg.setAttribute("class", "lotus-js-graph-svg");
  svg.setAttribute("viewBox", `0 0 ${dimensions.width} ${dimensions.height}`);
  svg.setAttribute("width", "100%");
  svg.setAttribute("height", `${dimensions.height}`);
  return svg;
}

function svgGroup(x: number, y: number): SVGGElement {
  const group = svgElement("g");
  group.setAttribute("transform", `translate(${x},${y})`);
  return group;
}

function appendSvgText(
  parent: SVGElement,
  value: string,
  x: number,
  y: number,
  anchor: "start" | "middle" | "end",
  className: string,
): SVGTextElement {
  const text = svgElement("text");
  text.setAttribute("class", className);
  text.setAttribute("x", `${x}`);
  text.setAttribute("y", `${y}`);
  text.setAttribute("text-anchor", anchor);
  text.textContent = value;
  parent.appendChild(text);
  return text;
}

function applyMonochromeSchematicTheme(svg: SVGSVGElement): void {
  const backgroundRects = findSchematicBackgroundRects(svg);
  svg.querySelectorAll("rect, polygon").forEach((element) => {
    if (backgroundRects.has(element)) {
      element.setAttribute("fill", GRAPH_WHITE);
      element.setAttribute("stroke", GRAPH_GRID);
      return;
    }
    element.setAttribute("fill", GRAPH_BLACK);
    element.setAttribute("stroke", GRAPH_BLACK);
  });
  svg.querySelectorAll("path, line, polyline").forEach((element) => {
    element.setAttribute("stroke", GRAPH_BLACK);
  });
  svg.querySelectorAll("text").forEach((element) => {
    element.setAttribute("fill", GRAPH_WHITE);
  });
}

function findSchematicBackgroundRects(svg: SVGSVGElement): Set<Element> {
  const backgroundRects = new Set<Element>();
  const viewBox = svg.viewBox.baseVal;
  const viewBoxArea = viewBox.width > 0 && viewBox.height > 0 ? viewBox.width * viewBox.height : 0;
  if (!viewBoxArea) {
    return backgroundRects;
  }

  svg.querySelectorAll("rect").forEach((rect) => {
    const width = Number.parseFloat(rect.getAttribute("width") ?? "0");
    const height = Number.parseFloat(rect.getAttribute("height") ?? "0");
    const className = rect.getAttribute("class") ?? "";
    if (className.includes("background") || width * height > viewBoxArea * 0.55) {
      backgroundRects.add(rect);
    }
  });
  return backgroundRects;
}

function svgElement<K extends keyof SVGElementTagNameMap>(tagName: K): SVGElementTagNameMap[K] {
  return activeDocument.createElementNS(SVG_NS, tagName);
}

function createGraphNotice(container: HTMLElement, message: string): void {
  container.createDiv({ cls: "lotus-js-graph-notice", text: message });
}

async function loadJsxGraph(): Promise<JsxGraphModule> {
  jsxGraphLoad ??= import("jsxgraph").then((module) => module.default ?? module);
  return jsxGraphLoad;
}

async function loadCytoscape(): Promise<CytoscapeModule> {
  cytoscapeLoad ??= import("cytoscape").then((module) => module.default ?? module);
  return cytoscapeLoad;
}

function addSvgPrintSnapshot(surface: HTMLElement, alt: string): void {
  const svg = surface.querySelector("svg");
  if (!svg) {
    return;
  }
  const serialized = new XMLSerializer().serializeToString(svg);
  addDataUrlPrintSnapshot(surface, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`, alt);
}

function addDataUrlPrintSnapshot(surface: HTMLElement, src: string, alt: string): void {
  if (!src || surface.querySelector(".lotus-js-graph-print-snapshot")) {
    return;
  }
  const image = activeDocument.createElement("img");
  image.className = "lotus-js-graph-print-snapshot";
  image.src = src;
  image.alt = alt;
  surface.appendChild(image);
}

function readRecordPayload(value: unknown): Record<string, unknown> {
  const record = readRecord(value);
  if (!record) {
    throw new Error("Graph display payload must be an object.");
  }
  return record;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function readArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readBoundingBox(value: unknown): [number, number, number, number] | undefined {
  if (!Array.isArray(value) || value.length !== 4) {
    return undefined;
  }
  const numbers = value.map(readNumber);
  return numbers.every((number): number is number => number !== undefined)
    ? [numbers[0], numbers[1], numbers[2], numbers[3]]
    : undefined;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

function nextGraphId(prefix: string): string {
  graphIdCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${graphIdCounter.toString(36)}`;
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
