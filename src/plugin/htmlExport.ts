
import { Modal, Setting, TFile } from "obsidian";
import { LOTUS_D3_MIME, LOTUS_PLOTLY_MIME, PLOTLY_MIME } from "./visualization/javascriptGraphs";
import { isRecord } from "../engine/utils/record";
import type { lotusCodeBlock, lotusDisplayOutput, lotusHtmlExportGraphAssetMode, lotusRunArtifact, lotusStoredOutput } from "../engine/types";
import type lotusPlugin from "./main";

export interface lotusHtmlExportSummary {
  path: string;
  resourceUrl: string;
  bytes: number;
  blocks: number;
  outputs: number;
  displays: number;
  artifacts: number;
  graphAssetMode: lotusHtmlExportGraphAssetMode;
}

const LOTUS_HTML_EXPORT_CSS = `
:root{color-scheme:light dark;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;line-height:1.55;color:#1f2933;background:#f6f7f9}
body{margin:0}
main{box-sizing:border-box;width:min(100%,960px);margin:0 auto;padding:32px 20px 56px}
.lotus-export-header{margin:0 0 28px;padding-bottom:16px;border-bottom:1px solid #d8dde5}
.lotus-export-header h1{margin:0;font-size:1.8rem;line-height:1.2}
.lotus-export-header p{margin:6px 0 0;color:#657080;font-size:.9rem}
p{margin:0 0 1rem}
h1,h2,h3,h4,h5,h6{margin:1.35rem 0 .6rem;line-height:1.2}
ul{margin:.2rem 0 1rem;padding-left:1.35rem}
hr{border:0;border-top:1px solid #d8dde5;margin:1.5rem 0}
pre{overflow:auto;border-radius:8px;background:#101820;color:#eef4ff;padding:12px 14px;font-size:.88rem;line-height:1.45}
code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.lotus-export-code{margin:1rem 0}
.lotus-export-output{margin:1rem 0 1.5rem;padding:12px;border:1px solid #c8d8f0;border-radius:8px;background:#fff}
.lotus-export-output-meta{margin:0 0 .7rem;color:#526070;font-size:.82rem}
.lotus-export-stream{margin:.7rem 0}
.lotus-export-label{margin:.2rem 0 .35rem;color:#526070;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em}
.lotus-export-display{margin:.8rem 0}
.lotus-export-html{width:100%;height:520px;border:1px solid #d8dde5;border-radius:8px;background:#fff}
.lotus-export-inline-graph{box-sizing:border-box;width:100%;border:1px solid #d8dde5;border-radius:8px;background:#fbfcfe;overflow:hidden}
.lotus-export-image{max-width:100%;height:auto;background:#fff}
.lotus-export-artifacts{display:grid;gap:.4rem;margin:.7rem 0}
.lotus-export-artifact{display:flex;justify-content:space-between;gap:1rem;padding:.55rem .65rem;border:1px solid #d8dde5;border-radius:8px;background:#f8fafc}
.lotus-export-artifact a{color:#1c64d1;text-decoration:none}
.lotus-export-artifact small{color:#657080}
@media (prefers-color-scheme:dark){:root{color:#e6edf5;background:#111418}.lotus-export-header{border-color:#30363f}.lotus-export-output{background:#171b21;border-color:#2b4a72}.lotus-export-artifact{background:#111820;border-color:#30363f}.lotus-export-header p,.lotus-export-output-meta,.lotus-export-label,.lotus-export-artifact small{color:#aab4c0}}
`.trim();

function renderMarkdownFragment(source: string): string {
  const lines = source.split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length) {
      html.push(`<p>${paragraph.join("<br>")}</p>`);
      paragraph = [];
    }
  };
  const flushList = () => {
    if (list.length) {
      html.push(`<ul>${list.map((item) => `<li>${item}</li>`).join("")}</ul>`);
      list = [];
    }
  };

  for (const raw of lines) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      flushParagraph();
      flushList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushParagraph();
      flushList();
      html.push(`<h${heading[1].length}>${renderInlineMarkdown(heading[2])}</h${heading[1].length}>`);
      continue;
    }
    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      flushList();
      html.push("<hr>");
      continue;
    }
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    if (bullet) {
      flushParagraph();
      list.push(renderInlineMarkdown(bullet[1]));
      continue;
    }
    flushList();
    paragraph.push(renderInlineMarkdown(trimmed));
  }
  flushParagraph();
  flushList();
  return html.join("\n");
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>");
}

function renderExportCodeBlock(block: lotusCodeBlock): string {
  const label = escapeHtml(block.sourceLanguage || block.language);
  return `<section class="lotus-export-code"><div class="lotus-export-label">${label}</div><pre><code>${escapeHtml(block.content)}</code></pre></section>`;
}

function renderExportOutput(output: lotusStoredOutput, graphAssetMode: lotusHtmlExportGraphAssetMode): string {
  const result = output.result;
  const parts = [
    `<div class="lotus-export-output-meta">${escapeHtml(result.runnerName)} · exit ${escapeHtml(String(result.exitCode ?? "?"))} · ${result.durationMs} ms · ${escapeHtml(result.finishedAt)}</div>`,
    result.stdout.trim() ? renderExportStream("stdout", result.stdout) : "",
    result.warning?.trim() ? renderExportStream("warning", result.warning) : "",
    result.stderr.trim() ? renderExportStream("stderr", result.stderr) : "",
    ...(result.displays ?? []).map((display) => renderExportDisplay(display, graphAssetMode)),
    result.artifacts?.length ? renderExportArtifacts(result.artifacts) : "",
  ].filter(Boolean);
  return `<section class="lotus-export-output">${parts.join("\n")}</section>`;
}

function renderExportStream(label: string, content: string): string {
  return `<div class="lotus-export-stream"><div class="lotus-export-label">${escapeHtml(label)}</div><pre><code>${escapeHtml(content)}</code></pre></div>`;
}

export class lotusHtmlExportSummaryModal extends Modal {
  constructor(
    private readonly lotusPlugin: lotusPlugin,
    private readonly summary: lotusHtmlExportSummary,
  ) {
    super(lotusPlugin.app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Lotus HTML Export" });
    contentEl.createEl("p", { text: this.summary.path });

    const stats = contentEl.createEl("ul");
    stats.createEl("li", { text: `Size: ${formatByteSize(this.summary.bytes)}` });
    stats.createEl("li", { text: `Blocks: ${this.summary.blocks}` });
    stats.createEl("li", { text: `Outputs: ${this.summary.outputs}` });
    stats.createEl("li", { text: `Displays: ${this.summary.displays}` });
    stats.createEl("li", { text: `Artifacts: ${this.summary.artifacts}` });
    stats.createEl("li", { text: `Graph assets: ${formatHtmlExportGraphAssetMode(this.summary.graphAssetMode)}` });

    new Setting(contentEl)
      .addButton((button) =>
        button
          .setButtonText("Open")
          .setCta()
          .onClick(() => this.lotusPlugin.openHtmlExport(this.summary)),
      )
      .addButton((button) =>
        button
          .setButtonText("Copy Path")
          .onClick(() => {
            void this.lotusPlugin.copyHtmlExportPath(this.summary);
          }),
      )
      .addButton((button) =>
        button
          .setButtonText("Close")
          .onClick(() => this.close()),
      );
  }
}

function formatHtmlExportGraphAssetMode(mode: lotusHtmlExportGraphAssetMode): string {
  return mode === "self-contained" ? "Self-contained SVG" : "CDN libraries";
}

export function formatByteSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function renderExportHtmlFrame(label: string, html: string, height: number): string {
  return `<div class="lotus-export-display"><div class="lotus-export-label">${label}</div><iframe class="lotus-export-html" sandbox="allow-forms allow-popups allow-scripts" referrerpolicy="no-referrer" style="height:${Math.round(height)}px" srcdoc="${escapeAttribute(html)}"></iframe></div>`;
}

function renderPlotlyExportHtml(value: unknown, display: lotusDisplayOutput): string {
  const payload = serializeExportJson(value);
  const title = escapeHtml(display.title?.trim() || "Lotus Plotly display");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<script src="https://cdn.plot.ly/plotly-2.35.2.min.js"></script>
<style>
html,body{margin:0;width:100%;height:100%;background:#fbfcfe;color:#1f2937;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#chart{box-sizing:border-box;width:100%;height:100%;min-height:320px;padding:8px 10px 6px 6px}
.fallback{display:none;margin:16px;padding:12px;border:1px solid #d8dde5;border-radius:6px;background:#f8fafc;color:#475569;font-size:14px}
</style>
</head>
<body>
<div id="chart" role="img" aria-label="${title}"></div>
<p id="fallback" class="fallback">Plotly could not load. The display data is still available in the exported HTML source.</p>
<script>
const figure = ${payload};
const data = Array.isArray(figure?.data) ? figure.data : Array.isArray(figure) ? figure : [];
const colorway = ["#344054", "#667085", "#0f766e", "#9a3412", "#7c3aed", "#475569"];
const styledData = data.map((trace, index) => {
  if (!trace || typeof trace !== "object") return trace;
  const color = colorway[index % colorway.length];
  return {
    ...trace,
    marker: { color, size: 6, ...(trace.marker || {}) },
    line: { color, width: 2, ...(trace.line || {}) }
  };
});
const figureLayout = figure && typeof figure === "object" && !Array.isArray(figure) ? figure.layout || {} : {};
const baseAxis = {
  automargin: true,
  showline: true,
  linecolor: "#d0d5dd",
  tickcolor: "#d0d5dd",
  tickfont: { color: "#667085", size: 11 },
  zeroline: false
};
const baseLayout = {
  paper_bgcolor: "#fbfcfe",
  plot_bgcolor: "#fbfcfe",
  colorway,
  margin: { l: 56, r: 28, t: 44, b: 52 },
  font: { family: "Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif", color: "#344054", size: 12 },
  title: { font: { size: 15, color: "#1f2937" }, x: 0.02, xanchor: "left" },
  xaxis: { ...baseAxis, showgrid: false },
  yaxis: { ...baseAxis, gridcolor: "#e5e7eb", gridwidth: 1 },
  hovermode: "x unified",
  hoverlabel: { bgcolor: "#111827", bordercolor: "#111827", font: { color: "#ffffff", size: 12 } },
  legend: { orientation: "h", y: 1.1, x: 0, font: { size: 11, color: "#475569" } }
};
const layout = {
  ...baseLayout,
  ...figureLayout,
  margin: { ...baseLayout.margin, ...(figureLayout.margin || {}) },
  font: { ...baseLayout.font, ...(figureLayout.font || {}) },
  title: { ...baseLayout.title, ...(figureLayout.title || {}) },
  xaxis: { ...baseLayout.xaxis, ...(figureLayout.xaxis || {}) },
  yaxis: { ...baseLayout.yaxis, ...(figureLayout.yaxis || {}) },
  legend: { ...baseLayout.legend, ...(figureLayout.legend || {}) }
};
const config = {
  responsive: true,
  displaylogo: false,
  modeBarButtonsToRemove: ["lasso2d", "select2d"],
  ...(figure && typeof figure === "object" && !Array.isArray(figure) ? figure.config || {} : {})
};
if (window.Plotly && data.length) {
  window.Plotly.newPlot("chart", styledData, layout, config);
} else {
  document.getElementById("chart").style.display = "none";
  document.getElementById("fallback").style.display = "block";
}
</script>
</body>
</html>`;
}

function renderD3ExportHtml(value: unknown, display: lotusDisplayOutput): string {
  const payload = serializeExportJson(value);
  const title = escapeHtml(display.title?.trim() || "Lotus D3 display");
  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<script src="https://cdn.jsdelivr.net/npm/d3@7/dist/d3.min.js"></script>
<style>
html,body{margin:0;width:100%;height:100%;background:#fbfcfe;color:#1f2937;font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
#chart{box-sizing:border-box;width:100%;height:100%;min-height:320px;padding:14px 16px 10px}
.axis text{fill:#667085;font-size:11px}.axis path,.axis line{stroke:#d0d5dd}.axis .domain{stroke:#d0d5dd}.grid line{stroke:#e5e7eb}.grid .domain{display:none}.series{fill:none;stroke:#475569;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}.dot{fill:#475569;stroke:#fbfcfe;stroke-width:2}.bar{fill:#475569}.fallback{display:none;margin:16px;padding:12px;border:1px solid #d8dde5;border-radius:6px;background:#f8fafc;color:#475569;font-size:14px}
</style>
</head>
<body>
<div id="chart" role="img" aria-label="${title}"></div>
<p id="fallback" class="fallback">D3 could not load. The display data is still available in the exported HTML source.</p>
<script>
const spec = ${payload};
function readNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}
function readRows(spec) {
  return Array.isArray(spec?.data) ? spec.data : [];
}
function render() {
  if (!window.d3) {
    document.getElementById("fallback").style.display = "block";
    return;
  }
  const rows = readRows(spec);
  const kind = spec?.kind || "line";
  const xKey = spec?.xKey || "x";
  const yKey = spec?.yKey || "y";
  const labelKey = spec?.labelKey || "label";
  const valueKey = spec?.valueKey || "value";
  const color = spec?.color || "#475569";
  const root = d3.select("#chart");
  const rect = root.node().getBoundingClientRect();
  const width = Math.max(360, rect.width || 760);
  const height = Math.max(300, rect.height || 420);
  const margin = { top: 18, right: 24, bottom: 42, left: 54 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const svg = root.append("svg").attr("viewBox", [0, 0, width, height]).attr("width", "100%").attr("height", height);
  const plot = svg.append("g").attr("transform", "translate(" + margin.left + "," + margin.top + ")");
  if (kind === "bar") {
    const data = rows.map((row, index) => ({ label: String(row[labelKey] ?? row[xKey] ?? index + 1), value: readNumber(row[valueKey] ?? row[yKey], 0) }));
    const x = d3.scaleBand().domain(data.map((row) => row.label)).range([0, innerWidth]).padding(0.25);
    const y = d3.scaleLinear().domain([0, d3.max(data, (row) => row.value) || 1]).nice().range([innerHeight, 0]);
    plot.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-innerWidth).tickFormat(""));
    plot.append("g").attr("class", "axis").attr("transform", "translate(0," + innerHeight + ")").call(d3.axisBottom(x));
    plot.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5));
    plot.selectAll("rect").data(data).join("rect").attr("class", "bar").attr("x", (row) => x(row.label) || 0).attr("y", (row) => y(row.value)).attr("width", x.bandwidth()).attr("height", (row) => innerHeight - y(row.value)).attr("rx", 3).attr("fill", (row) => row.color || color);
    return;
  }
  const data = rows.map((row, index) => ({ x: readNumber(row[xKey], index), y: readNumber(row[yKey] ?? row[valueKey], 0) }));
  const x = d3.scaleLinear().domain(d3.extent(data, (row) => row.x)).nice().range([0, innerWidth]);
  const y = d3.scaleLinear().domain(d3.extent(data, (row) => row.y)).nice().range([innerHeight, 0]);
  plot.append("g").attr("class", "grid").call(d3.axisLeft(y).ticks(5).tickSize(-innerWidth).tickFormat(""));
  plot.append("g").attr("class", "axis").attr("transform", "translate(0," + innerHeight + ")").call(d3.axisBottom(x).ticks(6));
  plot.append("g").attr("class", "axis").call(d3.axisLeft(y).ticks(5));
  if (kind !== "scatter") {
    plot.append("path").datum(data).attr("class", "series").attr("stroke", color).attr("d", d3.line().x((row) => x(row.x)).y((row) => y(row.y)));
  }
  plot.selectAll("circle").data(data).join("circle").attr("class", "dot").attr("fill", color).attr("cx", (row) => x(row.x)).attr("cy", (row) => y(row.y)).attr("r", 3.8);
}
render();
</script>
</body>
</html>`;
}

function renderExportInlineGraph(label: string, svg: string, height: number): string {
  return `<div class="lotus-export-display"><div class="lotus-export-label">${label}</div><div class="lotus-export-inline-graph" style="min-height:${Math.round(height)}px">${svg}</div></div>`;
}

function renderPlotlyExportSvg(value: unknown, display: lotusDisplayOutput): string {
  const figure = isRecord(value) ? value : {};
  const traces = Array.isArray(figure.data) ? figure.data.filter(isRecord) : Array.isArray(value) ? value.filter(isRecord) : [];
  if (!traces.length) {
    return renderExportGraphNoticeSvg(display.title ?? "Plotly Display", "No plottable traces were found.");
  }

  const series = traces
    .map((trace, index) => {
      const y = readNumberArray(trace.y);
      if (!y.length) {
        return null;
      }
      const xValues = readLabelArray(trace.x, y.length);
      return {
        name: readStringValue(trace.name) || `Series ${index + 1}`,
        xLabels: xValues,
        y,
        color: readTraceColor(trace, index),
      };
    })
    .filter((trace): trace is { name: string; xLabels: string[]; y: number[]; color: string } => Boolean(trace));

  if (!series.length) {
    return renderExportGraphNoticeSvg(display.title ?? "Plotly Display", "No numeric Y values were found.");
  }

  const labels = series[0].xLabels;
  return renderExportLineSvg({
    title: readPlotTitle(figure) || display.title || "Plotly Display",
    labels,
    series,
    yTitle: readAxisTitle(figure, "yaxis"),
  });
}

function renderD3ExportSvg(value: unknown, display: lotusDisplayOutput): string {
  if (!isRecord(value)) {
    return renderExportGraphNoticeSvg(display.title ?? "D3 Display", "The D3 payload was not an object.");
  }
  const rows = Array.isArray(value.data) ? value.data.filter(isRecord) : [];
  if (!rows.length) {
    return renderExportGraphNoticeSvg(display.title ?? "D3 Display", "No rows were found.");
  }
  const kind = readStringValue(value.kind) || "line";
  const xKey = readStringValue(value.xKey) || "x";
  const yKey = readStringValue(value.yKey) || "y";
  const labelKey = readStringValue(value.labelKey) || "label";
  const valueKey = readStringValue(value.valueKey) || "value";
  const color = readStringValue(value.color) || "#475569";

  if (kind === "bar") {
    return renderExportBarSvg({
      title: display.title || "D3 Display",
      bars: rows.map((row, index) => ({
        label: readStringValue(row[labelKey]) || readStringValue(row[xKey]) || String(index + 1),
        value: readExportNumber(row[valueKey] ?? row[yKey], 0),
        color: readStringValue(row.color) || color,
      })),
    });
  }

  const points = rows.map((row, index) => ({
    label: readStringValue(row[labelKey]) || String(readExportNumber(row[xKey], index)),
    y: readExportNumber(row[yKey] ?? row[valueKey], 0),
  }));
  return renderExportLineSvg({
    title: display.title || "D3 Display",
    labels: points.map((point) => point.label),
    series: [{ name: display.title || "Value", xLabels: points.map((point) => point.label), y: points.map((point) => point.y), color }],
  });
}

function renderExportLineSvg(spec: { title: string; labels: string[]; series: Array<{ name: string; xLabels: string[]; y: number[]; color: string }>; yTitle?: string }): string {
  const width = 920;
  const height = 420;
  const margin = { top: 56, right: 32, bottom: 56, left: 72 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const allY = spec.series.flatMap((series) => series.y);
  const yMin = Math.min(0, ...allY);
  const yMax = Math.max(1, ...allY);
  const ySpan = yMax - yMin || 1;
  const xFor = (index: number, count: number) => margin.left + (count <= 1 ? innerWidth / 2 : (index / (count - 1)) * innerWidth);
  const yFor = (value: number) => margin.top + innerHeight - ((value - yMin) / ySpan) * innerHeight;
  const ticks = Array.from({ length: 5 }, (_, index) => yMin + (ySpan * index) / 4);
  const longest = spec.series.reduce((count, series) => Math.max(count, series.y.length), 0);
  const labels = spec.labels.length ? spec.labels : Array.from({ length: longest }, (_, index) => String(index + 1));
  const labelStep = Math.max(1, Math.ceil(labels.length / 6));

  const grid = ticks.map((tick) => {
    const y = yFor(tick);
    return `<line x1="${margin.left}" y1="${roundSvg(y)}" x2="${width - margin.right}" y2="${roundSvg(y)}" stroke="#e5e7eb"/><text x="${margin.left - 12}" y="${roundSvg(y + 4)}" text-anchor="end" fill="#667085" font-size="11">${escapeHtml(formatSvgTick(tick))}</text>`;
  }).join("");
  const paths = spec.series.map((series) => {
    const path = series.y.map((value, index) => `${index === 0 ? "M" : "L"}${roundSvg(xFor(index, series.y.length))},${roundSvg(yFor(value))}`).join(" ");
    const dots = series.y.map((value, index) => `<circle cx="${roundSvg(xFor(index, series.y.length))}" cy="${roundSvg(yFor(value))}" r="3.8" fill="${escapeAttribute(series.color)}" stroke="#fbfcfe" stroke-width="2"/>`).join("");
    return `<path d="${path}" fill="none" stroke="${escapeAttribute(series.color)}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>${dots}`;
  }).join("");
  const xLabels = labels
    .map((label, index) => index % labelStep === 0 || index === labels.length - 1
      ? `<text x="${roundSvg(xFor(index, labels.length))}" y="${height - 24}" text-anchor="middle" fill="#667085" font-size="11">${escapeHtml(label)}</text>`
      : "")
    .join("");
  const legend = spec.series.map((series, index) => {
    const x = margin.left + index * 120;
    return `<g transform="translate(${x},22)"><line x1="0" y1="0" x2="20" y2="0" stroke="${escapeAttribute(series.color)}" stroke-width="2"/><text x="28" y="4" fill="#475569" font-size="11">${escapeHtml(series.name)}</text></g>`;
  }).join("");

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(spec.title)}" style="display:block;width:100%;height:auto;background:#fbfcfe">
<rect width="${width}" height="${height}" fill="#fbfcfe"/>
<text x="${margin.left}" y="32" fill="#1f2937" font-size="16" font-family="ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">${escapeHtml(spec.title)}</text>
${legend}
<g font-family="ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
${grid}
<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#d0d5dd"/>
<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#d0d5dd"/>
${xLabels}
${spec.yTitle ? `<text x="18" y="${margin.top + innerHeight / 2}" transform="rotate(-90 18 ${margin.top + innerHeight / 2})" text-anchor="middle" fill="#667085" font-size="11">${escapeHtml(spec.yTitle)}</text>` : ""}
${paths}
</g>
</svg>`;
}

function renderExportBarSvg(spec: { title: string; bars: Array<{ label: string; value: number; color: string }> }): string {
  const width = 920;
  const height = 420;
  const margin = { top: 56, right: 32, bottom: 64, left: 72 };
  const innerWidth = width - margin.left - margin.right;
  const innerHeight = height - margin.top - margin.bottom;
  const max = Math.max(1, ...spec.bars.map((bar) => bar.value));
  const band = innerWidth / Math.max(1, spec.bars.length);
  const barWidth = Math.max(16, band * 0.56);
  const ticks = Array.from({ length: 5 }, (_, index) => (max * index) / 4);
  const yFor = (value: number) => margin.top + innerHeight - (value / max) * innerHeight;
  const grid = ticks.map((tick) => {
    const y = yFor(tick);
    return `<line x1="${margin.left}" y1="${roundSvg(y)}" x2="${width - margin.right}" y2="${roundSvg(y)}" stroke="#e5e7eb"/><text x="${margin.left - 12}" y="${roundSvg(y + 4)}" text-anchor="end" fill="#667085" font-size="11">${escapeHtml(formatSvgTick(tick))}</text>`;
  }).join("");
  const bars = spec.bars.map((bar, index) => {
    const x = margin.left + index * band + (band - barWidth) / 2;
    const y = yFor(bar.value);
    return `<rect x="${roundSvg(x)}" y="${roundSvg(y)}" width="${roundSvg(barWidth)}" height="${roundSvg(height - margin.bottom - y)}" rx="3" fill="${escapeAttribute(bar.color)}"/><text x="${roundSvg(x + barWidth / 2)}" y="${height - 32}" text-anchor="middle" fill="#667085" font-size="11">${escapeHtml(bar.label)}</text>`;
  }).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeAttribute(spec.title)}" style="display:block;width:100%;height:auto;background:#fbfcfe">
<rect width="${width}" height="${height}" fill="#fbfcfe"/>
<text x="${margin.left}" y="32" fill="#1f2937" font-size="16" font-family="ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">${escapeHtml(spec.title)}</text>
<g font-family="ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">
${grid}
<line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="#d0d5dd"/>
<line x1="${margin.left}" y1="${margin.top}" x2="${margin.left}" y2="${height - margin.bottom}" stroke="#d0d5dd"/>
${bars}
</g>
</svg>`;
}

function renderExportGraphNoticeSvg(title: string, message: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 760 220" role="img" aria-label="${escapeAttribute(title)}" style="display:block;width:100%;height:auto;background:#fbfcfe">
<rect x="1" y="1" width="758" height="218" rx="8" fill="#fbfcfe" stroke="#d8dde5"/>
<text x="32" y="72" fill="#1f2937" font-size="18" font-family="ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">${escapeHtml(title)}</text>
<text x="32" y="112" fill="#667085" font-size="13" font-family="ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif">${escapeHtml(message)}</text>
</svg>`;
}

function readNumberArray(value: unknown): number[] {
  return Array.isArray(value)
    ? value.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    : [];
}

function readLabelArray(value: unknown, fallbackLength: number): string[] {
  if (Array.isArray(value) && value.length) {
    return value.map((item) => String(item));
  }
  return Array.from({ length: fallbackLength }, (_, index) => String(index + 1));
}

function readExportNumber(value: unknown, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function readStringValue(value: unknown): string {
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

function readTraceColor(trace: Record<string, unknown>, index: number): string {
  const colorway = ["#344054", "#667085", "#0f766e", "#9a3412", "#7c3aed", "#475569"];
  const line = isRecord(trace.line) ? readStringValue(trace.line.color) : "";
  const marker = isRecord(trace.marker) ? readStringValue(trace.marker.color) : "";
  return line || marker || colorway[index % colorway.length];
}

function readPlotTitle(figure: Record<string, unknown>): string {
  const layout = isRecord(figure.layout) ? figure.layout : {};
  const title = layout.title;
  if (typeof title === "string") {
    return title;
  }
  return isRecord(title) ? readStringValue(title.text) : "";
}

function readAxisTitle(figure: Record<string, unknown>, axis: string): string {
  const layout = isRecord(figure.layout) ? figure.layout : {};
  const axisConfig = isRecord(layout[axis]) ? layout[axis] : {};
  const title = axisConfig.title;
  if (typeof title === "string") {
    return title;
  }
  return isRecord(title) ? readStringValue(title.text) : "";
}

function roundSvg(value: number): string {
  return Number.isFinite(value) ? value.toFixed(2).replace(/\.?0+$/, "") : "0";
}

function formatSvgTick(value: number): string {
  if (Math.abs(value) >= 100) {
    return String(Math.round(value));
  }
  if (Math.abs(value) >= 10) {
    return value.toFixed(1).replace(/\.0$/, "");
  }
  return value.toFixed(2).replace(/\.?0+$/, "");
}

function renderExportDisplay(display: lotusDisplayOutput, graphAssetMode: lotusHtmlExportGraphAssetMode): string {
  const selected = selectExportDisplayMime(display);
  if (!selected) {
    return "";
  }
  const label = escapeHtml(formatExportDisplayLabel(display, selected.mime));
  const metadata = readExportDisplayMetadata(display, selected.mime);
  const height = readExportPositiveNumber(metadata.height) ?? 520;
  if (selected.mime === LOTUS_PLOTLY_MIME || selected.mime === PLOTLY_MIME) {
    if (graphAssetMode === "self-contained") {
      return renderExportInlineGraph(label, renderPlotlyExportSvg(selected.value, display), height);
    }
    return renderExportHtmlFrame(label, renderPlotlyExportHtml(selected.value, display), height);
  }
  if (selected.mime === LOTUS_D3_MIME) {
    if (graphAssetMode === "self-contained") {
      return renderExportInlineGraph(label, renderD3ExportSvg(selected.value, display), height);
    }
    return renderExportHtmlFrame(label, renderD3ExportHtml(selected.value, display), height);
  }
  if (selected.mime === "text/html" && typeof selected.value === "string") {
    return renderExportHtmlFrame(label, selected.value, height);
  }
  if (selected.mime.startsWith("image/") && typeof selected.value === "string") {
    return `<div class="lotus-export-display"><div class="lotus-export-label">${label}</div><img class="lotus-export-image" alt="${escapeAttribute(display.title ?? "Lotus image display")}" src="${escapeAttribute(imageExportDataUrl(selected.mime, selected.value))}"></div>`;
  }
  const content = typeof selected.value === "string" ? selected.value : JSON.stringify(selected.value, null, 2);
  return `<div class="lotus-export-display"><div class="lotus-export-label">${label}</div><pre><code>${escapeHtml(content)}</code></pre></div>`;
}

function renderExportArtifacts(artifacts: readonly lotusRunArtifact[]): string {
  return `<div class="lotus-export-artifacts"><div class="lotus-export-label">artifacts</div>${artifacts.map((artifact) => {
    const href = `data:${artifact.mimeType || "application/octet-stream"};base64,${artifact.dataBase64}`;
    return `<div class="lotus-export-artifact"><a href="${escapeAttribute(href)}" download="${escapeAttribute(artifact.name)}" target="_blank" rel="noopener noreferrer">${escapeHtml(artifact.path || artifact.name)}</a><small>${escapeHtml(artifact.mimeType)} · ${artifact.size} bytes</small></div>`;
  }).join("")}</div>`;
}

function selectExportDisplayMime(display: lotusDisplayOutput): { mime: string; value: unknown } | null {
  for (const mime of [LOTUS_PLOTLY_MIME, PLOTLY_MIME, LOTUS_D3_MIME, "text/html", "image/svg+xml", "image/png", "image/jpeg", "image/gif", "text/markdown", "text/vnd.graphviz", "application/json", "text/plain"]) {
    if (display.data[mime] != null) {
      return { mime, value: display.data[mime] };
    }
  }
  const firstMime = Object.keys(display.data)[0];
  return firstMime ? { mime: firstMime, value: display.data[firstMime] } : null;
}

function formatExportDisplayLabel(display: lotusDisplayOutput, mime: string): string {
  return `${display.title?.trim() || display.role || "display"} · ${mime}`;
}

function readExportDisplayMetadata(display: lotusDisplayOutput, mime: string): Record<string, unknown> {
  const globalMetadata = isRecord(display.metadata) ? display.metadata : {};
  const mimeMetadata = isRecord(globalMetadata[mime]) ? globalMetadata[mime] : {};
  return { ...globalMetadata, ...mimeMetadata };
}

function readExportPositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function serializeExportJson(value: unknown): string {
  return JSON.stringify(value ?? null)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

function imageExportDataUrl(mime: string, value: string): string {
  if (value.startsWith("data:")) {
    return value;
  }
  if (mime === "image/svg+xml") {
    return `data:${mime};charset=utf-8,${encodeURIComponent(value)}`;
  }
  return `data:${mime};base64,${value.replace(/\s/g, "")}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[char] ?? char);
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/\n/g, "&#10;");
}

export function renderLotusHtmlExport(outputs: ReadonlyMap<string, lotusStoredOutput>, graphAssetMode: lotusHtmlExportGraphAssetMode, file: TFile, source: string, blocks: lotusCodeBlock[]): string {
  const lines = source.split(/\r?\n/);
  const pieces: string[] = [];
  let cursor = 0;
  for (const block of blocks) {
    if (block.startLine > cursor) {
      pieces.push(renderMarkdownFragment(lines.slice(cursor, block.startLine).join("\n")));
    }
    pieces.push(renderExportCodeBlock(block));
    const output = outputs.get(block.id);
    if (output) {
      pieces.push(renderExportOutput(output, graphAssetMode));
    }
    cursor = block.endLine + 1;
  }
  if (cursor < lines.length) {
    pieces.push(renderMarkdownFragment(lines.slice(cursor).join("\n")));
  }

  return [
    "<!doctype html>",
    "<html>",
    "<head>",
    "<meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">",
    `<title>${escapeHtml(file.basename || file.path)}</title>`,
    `<style>${LOTUS_HTML_EXPORT_CSS}</style>`,
    "</head>",
    "<body>",
    "<main>",
    `<header class="lotus-export-header"><h1>${escapeHtml(file.basename || file.path)}</h1><p>${escapeHtml(file.path)}</p></header>`,
    pieces.filter((piece) => piece.trim()).join("\n"),
    "</main>",
    "</body>",
    "</html>",
  ].join("\n");
}

export function createHtmlExportSummary(storedOutputs: ReadonlyMap<string, lotusStoredOutput>, resourceUrl: string, graphAssetMode: lotusHtmlExportGraphAssetMode, targetPath: string, html: string, blocks: lotusCodeBlock[]): lotusHtmlExportSummary {
  const outputs = blocks
    .map((block) => storedOutputs.get(block.id))
    .filter((output): output is lotusStoredOutput => Boolean(output));
  return {
    path: targetPath,
    resourceUrl: resourceUrl,
    bytes: new TextEncoder().encode(html).byteLength,
    blocks: blocks.length,
    outputs: outputs.length,
    displays: outputs.reduce((count, output) => count + (output.result.displays?.length ?? 0), 0),
    artifacts: outputs.reduce((count, output) => count + (output.result.artifacts?.length ?? 0), 0),
    graphAssetMode: graphAssetMode,
  };
}
