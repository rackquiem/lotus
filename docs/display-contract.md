# Rich Display Contract

Lotus rich displays are enabled by the `rich-displays` compile feature. Builds that omit that feature must not expose image, plot, or source-visualization UI.

## Display Records

Display outputs are MIME bundles. A record has this shape:

```json
{
  "id": "optional-stable-id",
  "title": "Optional title",
  "role": "visualization",
  "data": {
    "image/svg+xml": "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
    "text/plain": "fallback text"
  },
  "metadata": {
    "width": 900,
    "height": 480,
    "alt": "Accessible description"
  }
}
```

`data` is required. `id`, `title`, `role`, and `metadata` are optional. Supported roles are `result`, `visualization`, `diagnostic`, and `artifact`.

External processes can also write regular files into `LOTUS_ARTIFACT_DIR`. Lotus copies those files into the run result as durable artifacts before the temp workspace is removed, then exposes open, download, and copy actions in the output panel.

Lotus currently renders these MIME types, in priority order:

```text
application/vnd.lotus.plotly+json
application/vnd.plotly.v1+json
application/vnd.lotus.d3+json
text/html
image/svg+xml
image/png
image/jpeg
image/gif
text/markdown
text/vnd.graphviz
application/json
text/plain
```

HTML values are full HTML documents or fragments. Lotus renders them in a sandboxed iframe with scripts enabled but without same-origin access to Obsidian. Use declarative graph MIME types for trusted first-party graph adapters when you need tighter integration with Obsidian styling or static print snapshots.

SVG values are raw SVG strings. Raster image values are base64 strings unless they already include a `data:` URL.

Lotus HTML export also prefers Plotly and D3 graph MIME types over generic JSON or text fallbacks. In settings, **HTML graph export assets** controls whether exported Plotly and D3 displays load chart libraries from a CDN for interactive charts, or render self-contained SVG fallbacks for offline publishing.

Custom MIME types can be emitted in the same `data` object. If no trusted renderer is registered for that MIME type, Lotus falls back to JSON/text rendering or reports the display data as unsupported.

## External Process Channel

Every local process receives these environment variables:

```text
LOTUS_DISPLAY_JSONL
LOTUS_ARTIFACT_DIR
```

Append one JSON display record per line to `LOTUS_DISPLAY_JSONL`. Lotus reads the file after the process exits and attaches valid records to the output panel.

`LOTUS_ARTIFACT_DIR` is a temporary directory for files produced during the run. Lotus reads regular files from this directory after the process exits and stores them as run artifacts. Artifact capture is capped by file count and total size.

The JSONL file is capped at 10 MiB. Invalid records produce a warning and are not rendered.

## Obsidian JavaScript Helper

`obsidian-js` blocks receive a `display` helper:

```javascript
display.svg(svg, { title: "SVG", alt: "Control-flow graph", width: 900 });
display.graphviz("digraph g { a -> b }", { title: "CFG" });
display.png(base64Png, { title: "PNG" });
display.jpeg(base64Jpeg, { title: "JPEG" });
display.image(base64Image, { mimeType: "image/gif", title: "GIF" });
display.d3({ kind: "bar", data: [{ label: "A", value: 4 }] }, { title: "D3" });
display.plotly({ data: [{ x: [1, 2], y: [2, 5], type: "scatter" }] }, { title: "Plotly" });
display.jsxgraph({ boundingbox: [-5, 5, 5, -5], objects: [{ type: "point", args: [1, 2] }] }, { title: "JSXGraph" });
display.elk({ id: "root", children: [{ id: "a" }, { id: "b" }], edges: [{ id: "ab", sources: ["a"], targets: ["b"] }] }, { title: "ELK" });
display.hwschematic({ graph: elkHardwareGraph }, { title: "Hardware schematic" });
display.cytoscape({ elements: [{ data: { id: "a" } }, { data: { id: "b" } }, { data: { source: "a", target: "b" } }] }, { title: "Cytoscape.js" });
display.mime({ "application/json": { ok: true } }, { title: "Data" });
display.mime({ "application/vnd.my-tool.image+json": { path: "diagram.bin" } }, { title: "Custom image" });
```

Graphviz displays use `text/vnd.graphviz`. When Graphviz is configured, Lotus runs `dot -Tsvg` and adds an `image/svg+xml` representation. If the block resolves to an execution group, Lotus runs Graphviz inside that group with the synthetic `graphviz` language instead of requiring `dot` on the host.

## JavaScript Graph Display Adapters

Lotus includes trusted first-party renderers for common JavaScript graphing libraries. Display records remain declarative JSON; Lotus does not execute JavaScript from display output.

Supported MIME types:

```text
application/vnd.lotus.d3+json
application/vnd.lotus.plotly+json
application/vnd.plotly.v1+json
application/vnd.lotus.jsxgraph+json
application/vnd.lotus.elk+json
application/vnd.elk+json
application/vnd.lotus.hwschematic+json
application/vnd.lotus.cytoscape+json
application/vnd.cytoscapejs+json
```

The adapters are bundled and loaded on demand when their MIME type is rendered. Plotly, JSXGraph, and Cytoscape.js also add static print snapshots so Obsidian PDF export has a stable image even when the interactive renderer uses browser-only DOM or canvas state.

`obsidian-js` can load graph specs from JSON files relative to the current note:

```obsidian-js
await display.elkFile("graphs/pipeline.json", { title: "Pipeline" });
await display.cytoscapeFile("graphs/network.json", { title: "Network" });
const graph = await display.jsonFile("graphs/pipeline.json");
```

Payload shapes:

```javascript
display.d3({
  kind: "bar", // bar, line, scatter
  data: [{ label: "parse", value: 8 }, { label: "run", value: 13 }]
});

display.plotly({
  data: [{ x: [1, 2, 3], y: [2, 5, 4], type: "scatter" }],
  layout: { margin: { t: 24 } },
  config: { responsive: true }
});

display.jsxgraph({
  boundingbox: [-5, 5, 5, -5],
  axis: true,
  objects: [
    { type: "point", args: [1, 2], attributes: { name: "A" } },
    { type: "circle", args: [[0, 0], 2] }
  ]
});

display.elk({
  graph: {
    id: "root",
    children: [{ id: "a", width: 80, height: 40 }, { id: "b", width: 80, height: 40 }],
    edges: [{ id: "ab", sources: ["a"], targets: ["b"] }]
  },
  layoutOptions: { "elk.algorithm": "layered" }
});

display.hwschematic({
  graph: elkHardwareGraph,
  format: "elk", // elk or yosys
  root: "/optional/submodule/path"
});

display.cytoscape({
  elements: [
    { data: { id: "a", label: "A" } },
    { data: { id: "b", label: "B" } },
    { data: { id: "ab", source: "a", target: "b" } }
  ],
  layout: { name: "grid" }
});
```

## Custom MIME Renderers

Custom MIME renderers are trusted JavaScript connectors registered with the Lotus plugin instance. Display records may carry arbitrary MIME bundles, but Lotus does not execute JavaScript from display output. A connector decides how its MIME payload is loaded and rendered. Builds that omit the `rich-displays` feature treat registration as a no-op.

```typescript
declare function loadImageUrlFromPayload(value: unknown): string;

const lotus = app.plugins.plugins.lotus as {
  registerDisplayRenderer?: (renderer: {
    id?: string;
    mimeTypes: readonly string[];
    render: (
      container: HTMLElement,
      context: {
        mime: string;
        value: unknown;
        display: { title?: string };
        metadata: Record<string, unknown>;
        visibleLines: number;
      },
    ) => void | (() => void) | Promise<void | (() => void)>;
  }) => () => void;
};

const unregister = lotus.registerDisplayRenderer?.({
  id: "my-tool-image",
  mimeTypes: ["application/vnd.my-tool.image+json", "image/tiff"],
  render(container, context) {
    const url = loadImageUrlFromPayload(context.value);
    const image = container.createEl("img", {
      attr: {
        src: url,
        alt: String(context.metadata.alt ?? context.display.title ?? "Custom image"),
      },
    });
    return () => {
      URL.revokeObjectURL(url);
      image.remove();
    };
  },
});
```

`mimeTypes` supports exact MIME matches, `type/*` wildcards, and `*/*`. Custom renderers run before the built-in renderer priority. Register the returned cleanup function with the owning plugin so the renderer is removed when that connector unloads.

## Visualization Attributes

Blocks can request display synthesis from stdout:

```text
lotus-visualize=graphviz
lotus-visualize=svg
```

`graphviz`, `dot`, `gv`, and `cfg` are accepted Graphviz aliases. `svg` and `image/svg+xml` are accepted SVG aliases. `false`, `off`, `none`, and similar values disable synthesis. The toolbar source graph button is enabled by default and can be hidden with the **Show code graph button** setting.

## UI Behavior

Image displays render on a white viewport with zoom controls. Zoom preserves the current viewport center. When the image is larger than the viewport, dragging inside the image viewport pans the image. The fullscreen button opens the display in a full-window overlay with the same zoom and drag controls plus a larger zoom range.

When **Write output back to note** is enabled Lotus stores display records in a managed `lotus-display` fence that preserves the MIME bundle in source mode and renders it as the original visual in reading view and PDF exports.

## HTML Displays

`text/html` displays are intended for self-contained compiler or publisher output previews. They run in an isolated iframe using the browser sandbox, so page scripts cannot access the Obsidian document or plugin APIs. Prefer the built-in declarative graph MIME types when the result should participate in Lotus print snapshots or use trusted renderer integrations.

HTML display metadata may include `height` to set the iframe height in pixels. Custom language manifests can set this with `displayHeight`.
