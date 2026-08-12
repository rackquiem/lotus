[![Lotus show and tell](https://img.youtube.com/vi/PzJ5QUtpxws/0.jpg)](https://www.youtube.com/watch?v=PzJ5QUtpxws)

# lotus

Obsidian plugin for executing ordinary fenced Markdown code blocks.

lotus is intended for research and exploratory notes where code, proofs, solver queries, and runtime output should stay readable in the document. It adds execution controls to normal fenced code blocks and renders transient output beneath the block. The source block is not rewritten into a plugin-specific format.

## Model

lotus treats a fenced block as executable when the fence info string resolves to a supported language alias. The parser walks the active Markdown buffer, skips managed lotus output sections, normalises the fence language, and creates a stable block descriptor.

Each block receives an ID derived from these values:
- Vault-relative file path
- Supported block ordinal
- Normalised language
- Source content hash

That ID is used for output replacement and toolbar state. Rerunning a block updates the existing output panel instead of appending another panel.

## Installation

### Via Community Plugins
If Lotus is listed in the Community Plugins directory, install it from **Settings > Community plugins > Browse**.

### Manual Installation
1. Download `main.js`, `manifest.json`, and `styles.css` from the latest release.
2. Create a folder named `lotus` under your vault's plugin directory: `<vault>/.obsidian/plugins/lotus/`.
3. Copy the downloaded files into that directory.
4. Reload Obsidian and enable **lotus** in the Community Plugins list.

## Security

Lotus executes code blocks locally on your machine without sandboxing or isolation by default.

> [!CAUTION]
> Running code blocks in untrusted notes can execute malicious commands on your host machine. Lotus displays a consent modal before allowing local execution. For security isolation, consider setting up [Execution Groups](docs/execution-groups.md) to run code inside Docker/Podman containers or remote SSH/QEMU environments.

### Community Directory Disclosures

Lotus is desktop-only because it uses Node.js APIs and local processes for code execution, hashing, signing, logging, and toolchain integration.

Lotus does not include client-side telemetry, dynamic ads, static ads, or a self-updater. It does not send data to a remote service unless you configure a feature that requires one.

Optional features that can use the network:

- SSH and QEMU execution groups connect to the targets you configure.
- Docker and Podman execution groups may pull images if your local runtime is configured to do so.
- The built in Godbolt execution group posts snippet source to Compiler Explorer and returns a public shortlink.
- The HTTP logging sink posts structured execution events to the endpoint you configure.

Optional features that can access files or processes outside the vault:

- Native code execution runs local interpreters, compilers, and helper processes.
- Execution groups can run Docker, Podman, WSL, SSH, QEMU, or custom wrapper commands.
- OpenSSH signing can call `ssh-keygen` and use configured key files or `SSH_AUTH_SOCK`.
- Logging can write to vault-relative files, per-note files, or a local process sink that you configure.

Lotus is licensed under the MIT license. See [LICENSE](LICENSE).

## Quick Start

1. Enable the plugin.
2. In any Markdown file, create a standard fenced code block:
   ````markdown
   ```python
   print("Hello from lotus!")
   ```
   ````
3. Hover over the block and click the **Run** button on the floating toolbar to execute the block and view the output.

## Supported Languages

Languages are grouped into vault-level packages. You can enable only the packs you need, and optionally disable individual languages inside them.

| Package | Languages | Typical Vault |
| :--- | :--- | :--- |
| **Interpreted** | Python, JavaScript, TypeScript, Shell, Ruby, Perl, Lua, PHP, Go, Haskell, OCaml | ops notes, scripting, research scratchpads |
| **Obsidian Context** | Obsidian JavaScript | vault and plugin integration snippets |
| **Native Compiled** | C, C++ | systems, exploit dev, native debugging |
| **Managed Compiled** | Rust, Java | application and service notes |
| **Proofs** | Lean, Coq, SMT LIB | formal methods, solver work |
| **LLVM** | LLVM IR | compiler and PL research |
| **eBPF** | eBPF C, bpftrace | kernel tracing, observability, verifier experiments |
| **Custom languages** | User-defined command-backed languages, inherited highlighting, transpile mode | toy languages, local DSLs, compiler experiments |

By default, every built-in package is enabled. Use **Language Packages** in settings to customize your active languages.

## Managed Output

By default, lotus does not write output into the note. If `Write output back to note` is enabled, lotus writes managed regions under blocks:

````markdown
<!-- lotus:output:start id=<stable-block-id> -->
```text
runner=Python
exit=0
duration=8ms
timestamp=2026-06-20T00:00:00.000Z

stdout:
hello
```
<!-- lotus:output:end -->
````

Rich displays are stored in a `lotus-display` fence inside the same managed region so Lotus can render that MIME data back into the visual output in reading view and PDF exports instead of showing the serialized SVG or JSON as code while the parser continues to skip managed regions and generated output blocks are never executed.

### Output Window Limits
Output panels can be capped to a visible line window while keeping the full output scrollable. Set **Visible output lines** in settings for a vault-wide default, or use the `lotus-output-lines=20` attribute on a specific block. Use `0` to keep output unlimited.

### Redirection to Files
Blocks can materialise output into vault files with `lotus-output-file="path/to/file.txt"`. Relative paths resolve from the note folder, leading slash paths resolve from the vault root, and lotus creates missing parent folders. By default, the file receives stdout and is overwritten on each run.

Use `lotus-output-file-mode=append`, `lotus-output-file-streams=metadata,stdout,stderr,warning,displays`, or `lotus-output-file-format=json` when a block needs a different artifact shape.

### Standard Input (Stdin)
Blocks can receive standard input through the toolbar input control or through attributes. Click the stdin toolbar button to open a per-block input buffer. For reproducible notes, use `lotus-stdin="line one\nline two"` or `lotus-stdin-file="inputs/payload.txt"`. The attribute `lotus-input=true` keeps the input field visible whenever the note renders.

### Dynamic Inputs
Lotus can preprocess a block with controls rendered directly beneath it. Add comment directives to the source and reference each named value with `{{name}}`:

````markdown
```python
# @lotus-slider name=count label="Count" min=1 max=20 step=1 default=5
# @lotus-text name=message label="Message" default="hello"
# @lotus-checkbox name=verbose label="Verbose" checked=true value=True unchecked=False
# @lotus-select name=mode label="Mode" options="Fast:fast,Safe:safe" default=safe
# @lotus-button name=operation label="Add" value=add
# @lotus-button name=operation label="Multiply" value=multiply

print("{{message}}", {{count}}, {{verbose}}, "{{mode}}", "{{operation}}")
```
````

Supported directives are `@lotus-slider`, `@lotus-number`, `@lotus-text`, `@lotus-checkbox`, `@lotus-select`, and `@lotus-button`. Directive lines may start with `#`, `//`, `--`, `;`, `%`, `/*`, or `(*` so they remain comments in common source languages. Sliders default to `min=0 max=100 step=1`; selects use comma-separated `label:value` options. A button without `name` only runs the block. Multiple buttons may share a name to set different values before execution.

Changing a control updates its transient per-block value. The panel's run button applies the current values; add `run=true` to a slider, number, text, checkbox, or select to run when the value is committed. Directives are replaced with blank lines and placeholders are substituted immediately before the existing custom preprocessor and runner pipeline. Substitution is raw source text, so quote or escape text placeholders according to the target language.

## Rich Displays

Lotus can render rich display outputs in addition to stdout and stderr. Display outputs use MIME bundles inspired by Jupyter outputs. Supported render targets include `text/html`, `image/svg+xml`, `image/png`, `image/jpeg`, `image/gif`, `text/vnd.graphviz`, `application/json`, and `text/plain`. Trusted plugins can register custom MIME renderers for application-specific payloads. The full producer contract is documented in [Rich Display Contract](docs/display-contract.md).

Obsidian JavaScript blocks receive a `display` helper:

````markdown
```obsidian-js
display.svg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 60">
  <rect x="10" y="10" width="140" height="40" fill="white" stroke="black"/>
  <text x="80" y="36" text-anchor="middle">lotus</text>
</svg>`, { title: "Inline SVG" });

```
````

External processes can append JSON records to the path in `LOTUS_DISPLAY_JSONL`:

```json
{"title":"CFG","role":"visualization","data":{"text/vnd.graphviz":"digraph g { a -> b }","text/plain":"CFG graph"}}
```

When a display contains `text/vnd.graphviz`, Lotus runs the configured Graphviz executable (`dot` by default) to add an SVG representation. If the block resolves to an execution group, Graphviz runs inside that group with the synthetic `graphviz` language. Use the toolbar visualize button or command palette action to run a block and treat stdout as Graphviz DOT. The toolbar button is enabled by default and can be hidden in settings. Blocks can request visualization persistently with `lotus-visualize=graphviz`, or treat stdout as SVG with `lotus-visualize=svg`.

Lotus also ships first-party JavaScript graph display adapters for declarative D3 charts, Plotly figures, JSXGraph boards, ELK JSON graphs, hardware-schematic ELK fallbacks, and Cytoscape.js graphs. Use `display.d3(...)`, `display.plotly(...)`, `display.jsxgraph(...)`, `display.elk(...)`, `display.hwschematic(...)`, or `display.cytoscape(...)` from `obsidian-js`, or emit the corresponding MIME payloads from any runner. For larger graphs, keep the payload in a JSON file and call helpers such as `await display.elkFile("graphs/pipeline.json")`.

Rich displays are controlled by the `rich-displays` compile feature. Light builds can omit that feature to remove image/plot/source-visualization surfaces:

```bash
npm run build:light -- --features=container-groups,signing
```

## Observability

Lotus can write execution, note mutation, reproducibility, and signature events to text logs, JSONL logs, per-note logs, a local process, or a remote HTTP endpoint. Structured event payloads support redaction rules before they leave the plugin.

Use `lotus: Open Log Viewer` to inspect the configured JSONL log inside Obsidian. See [Observability, Logging, and Signing](docs/observability.md) for sink configuration, redaction rules, live input behavior, and cryptographic note signatures.

## Advanced Topics

For more specialized setups, refer to the guides in the [docs/](docs/) directory:

- [Custom Languages](docs/custom-languages.md): Configure local interpreters, highlighting inheritance, transpile-only outputs, staged preprocessors, JSON request/response schema extractors, and C partial-extraction strategies.
- [Godbolt Showcase](docs/godbolt-showcase.md): Push a snippet through the built in Godbolt execution group and get a Compiler Explorer shortlink.
- [Rich Display Contract](docs/display-contract.md): Emit SVG, raster images, Graphviz DOT, JSON, and text display records from runners and external processes.
- [Execution Groups](docs/execution-groups.md): Run code blocks inside Docker/Podman containers, WSL distros, remote SSH nodes, or local QEMU virtual machines.
- [Partial Source Extraction](docs/source-extraction.md): Run a specific symbol or line range from an external file, and generate function call harnesses.
- [Note-scoped Code Packages](docs/code-packages.md): Compile C or C++ examples split across several fenced blocks in one note.
- [eBPF Execution](docs/ebpf.md): Compile BPF programs, inspect ELF objects, and load probes safely.
- [Hashing & Reproducibility](docs/reproducibility.md): Verify notes and code blocks against snapshots to guarantee document reproducibility.
- [Observability, Logging, and Signing](docs/observability.md): Configure local/remote logs, redaction rules, log viewing, live input, and note signatures.
- [Developer Guide](docs/development.md): Runner API contracts, Obsidian context (`obsidian-js`) integrations, and the smoke testing suite.
* [Process](docs/process.md) Branch model PR expectations and release tagging checklist

## Commands Reference

Lotus registers several commands in the Obsidian command palette (`Ctrl/Cmd + P`):

- **`lotus: Run Current Code Block`**: Executes the block under the cursor.
- **`lotus: Run All Supported Code Blocks in Current Note`**: Executes all runnable blocks in the active file.
- **`lotus: Cancel Current Code Block`**: Stops the running block under the cursor.
- **`lotus: Cancel All Running Code Blocks`**: Stops all active block runs.
- **`lotus: Clear lotus Outputs in Current Note`**: Removes all rendered output panels and written output blocks in the active file.
- **`lotus: Open Log Viewer`**: Opens the structured JSONL log viewer.
- **`lotus: Save Reproducibility Snapshot`**: Saves the current block and note hashes to the note's frontmatter.
- **`lotus: Verify Reproducibility Snapshot`**: Compares the current note against the saved snapshot.
- **`lotus: Sign Current Note`**: Signs the active note's reproducibility payload.
- **`lotus: Verify Current Note Signature`**: Verifies the active note against `lotus-signature`.
- **`lotus: Copy Current Note Signature`**: Copies the active note signature as JSON.
- **`lotus: Sign All Notes`**: Signs every Markdown note in the vault.
- **`lotus: Verify All Note Signatures`**: Verifies note signatures across the vault.

*See [docs/reproducibility.md](docs/reproducibility.md) for the complete list of hashing and verification commands.*

*See [docs/observability.md](docs/observability.md) for logging and signing configuration.*



## Development

### Native Toolchains
To run languages natively on your host machine, their compilers or interpreters must be installed and available in Obsidian's PATH. See [docs/development.md](docs/development.md) for details on toolchain configurations.

### Build from Source
To build the plugin locally:

```bash
npm install --legacy-peer-deps
npm run build
```

### Smoke Tests
To run the smoke suite locally:

```bash
npm run smoke -- --profile minimal
```

On Windows, use the Python launcher name available on the runner or workstation:

```powershell
$env:LOTUS_SMOKE_PYTHON = "python"
npm run smoke -- --profile minimal
```

For the Windows systems profile, point the smoke harness at the host C/C++ compiler if it is not already on `PATH`:

```powershell
$env:LOTUS_SMOKE_C = "gcc"
$env:LOTUS_SMOKE_CPP = "g++"
npm run smoke -- --profile systems
```
