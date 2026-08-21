import type { lotusCodeBlock, lotusDisplayOutput, lotusNormalizedLanguage } from "../types";

interface GraphNode {
  id: string;
  label: string;
  align?: "center" | "left";
  fontSize?: number;
  padding?: number;
}

interface GraphEdge {
  from: string;
  to: string;
  label?: string;
}

interface LlvmFunction {
  name: string;
  header: string;
  blocks: LlvmBasicBlock[];
}

interface LlvmBasicBlock {
  name: string;
  lines: string[];
  terminator: string;
}

interface CodeConstruct {
  kind: string;
  label: string;
  snippets: string[];
  depth: number;
  lineNumber: number;
}

const MAX_LLVM_BLOCKS = 48;
const MAX_GENERIC_NODES = 36;
const MAX_LABEL_LINE_LENGTH = 140;
const WRAP_LABEL_LINE_LENGTH = 38;
const DEFAULT_WIDTH = 900;
const GRAPH_FONT = "DejaVu Sans Mono";
const NODE_FONT_SIZE = 11;
const NODE_PADDING = 10;
const EDGE_LABEL_FONT_SIZE = 10;
const EDGE_LABEL_PADDING = 4;

export function createStdoutVisualizationDisplay(stdout: string, mode: "graphviz" | "svg"): lotusDisplayOutput | null {
  const content = stdout.trim();
  if (!content) {
    return null;
  }

  if (mode === "svg") {
    if (!looksLikeSvg(content)) {
      return null;
    }
    return {
      title: "SVG",
      role: "visualization",
      data: {
        "image/svg+xml": content,
        "text/plain": "SVG output",
      },
      metadata: {
        width: DEFAULT_WIDTH,
      },
    };
  }

  if (!looksLikeGraphvizDot(content)) {
    return null;
  }
  return {
    title: "Graphviz",
    role: "visualization",
    data: {
      "text/vnd.graphviz": content,
      "text/plain": "Graphviz DOT output",
    },
    metadata: {
      width: DEFAULT_WIDTH,
    },
  };
}

export function createSourceVisualizationDisplay(block: lotusCodeBlock): lotusDisplayOutput {
  const dot = block.language === "llvm-ir"
    ? createLlvmCfgDot(block)
    : createGenericCodeGraphDot(block);

  return {
    title: block.language === "llvm-ir" ? "LLVM IR CFG" : "Code Graph",
    role: "visualization",
    data: {
      "text/vnd.graphviz": dot,
      "text/plain": `${block.language} source visualization`,
    },
    metadata: {
      width: DEFAULT_WIDTH,
    },
  };
}

function createLlvmCfgDot(block: lotusCodeBlock): string {
  const functions = parseLlvmFunctions(block.content);
  if (!functions.length) {
    return createGenericCodeGraphDot(block);
  }

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  nodes.push({
    id: "root",
    label: ["root", block.sourceLanguage || block.language].join("\\n"),
    align: "center",
    fontSize: 12,
  });

  let blockCount = 0;
  let truncated = false;

  functions.forEach((fn, fnIndex) => {
    const functionId = `fn_${fnIndex}`;
    nodes.push({
      id: functionId,
      label: formatNodeLabel(["function", fn.name]),
      align: "center",
      fontSize: 12,
    });
    edges.push({ from: "root", to: functionId, label: "entry" });

    const limitedBlocks = fn.blocks.slice(0, MAX_LLVM_BLOCKS - blockCount);
    if (limitedBlocks.length < fn.blocks.length) {
      truncated = true;
    }
    const blockIds = new Map<string, string>();
    limitedBlocks.forEach((basicBlock, index) => {
      const id = `fn_${fnIndex}_bb_${index}`;
      blockIds.set(basicBlock.name, id);
      nodes.push({
        id,
        label: formatNodeLabel([
          basicBlock.name,
          ...summarizeLlvmBlockLines(basicBlock),
        ]),
      });
    });

    if (limitedBlocks[0]) {
      edges.push({ from: functionId, to: blockIds.get(limitedBlocks[0].name)!, label: "entry" });
    }

    for (let index = 0; index < limitedBlocks.length; index += 1) {
      const basicBlock = limitedBlocks[index];
      const from = blockIds.get(basicBlock.name)!;
      const outgoing = readLlvmOutgoingEdges(basicBlock.terminator);
      if (outgoing.length) {
        for (const edge of outgoing) {
          const target = blockIds.get(edge.target);
          if (target) {
            edges.push({ from, to: target, label: edge.label });
          }
        }
      } else if (!isLlvmTerminalInstruction(basicBlock.terminator) && limitedBlocks[index + 1]) {
        edges.push({ from, to: blockIds.get(limitedBlocks[index + 1].name)!, label: "next" });
      }
    }

    blockCount += limitedBlocks.length;
  });

  if (truncated) {
    nodes.push({ id: "truncated", label: "more blocks\\ntruncated", align: "center", fontSize: 11 });
    edges.push({ from: "root", to: "truncated", label: "..." });
  }

  return renderDot("lotus_llvm_cfg", nodes, edges);
}

function parseLlvmFunctions(source: string): LlvmFunction[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const functions: LlvmFunction[] = [];
  let current: { name: string; header: string; body: string[]; braceDepth: number } | null = null;

  for (const line of lines) {
    if (!current) {
      const match = line.match(/^\s*define\b(.*@([A-Za-z$._-][A-Za-z$._0-9-]*)\s*\([^)]*\).*)\{/);
      if (!match) {
        continue;
      }
      current = {
        name: `@${match[2]}`,
        header: `define ${match[1].trim()}`,
        body: [],
        braceDepth: countChar(line, "{") - countChar(line, "}"),
      };
      continue;
    }

    current.braceDepth += countChar(line, "{") - countChar(line, "}");
    if (current.braceDepth <= 0) {
      functions.push({
        name: current.name,
        header: current.header,
        blocks: parseLlvmBasicBlocks(current.body),
      });
      current = null;
      continue;
    }
    current.body.push(line);
  }

  return functions;
}

function parseLlvmBasicBlocks(lines: string[]): LlvmBasicBlock[] {
  const blocks: LlvmBasicBlock[] = [];
  let current: LlvmBasicBlock | null = null;

  const ensureCurrent = () => {
    if (!current) {
      current = { name: "entry", lines: [], terminator: "" };
    }
    return current;
  };

  for (const rawLine of lines) {
    const label = rawLine.match(/^\s*([A-Za-z$._-][A-Za-z$._0-9-]*|\d+):(?:\s*(?:;.*)?)?$/);
    if (label) {
      if (current) {
        current.terminator = readLastInstruction(current.lines);
        blocks.push(current);
      }
      current = { name: label[1], lines: [], terminator: "" };
      continue;
    }

    const line = stripLlvmComment(rawLine).trim();
    if (!line) {
      continue;
    }
    ensureCurrent().lines.push(line);
  }

  if (current) {
    current.terminator = readLastInstruction(current.lines);
    blocks.push(current);
  }

  return blocks.length ? blocks : [{ name: "entry", lines: [], terminator: "" }];
}

function summarizeLlvmBlockLines(block: LlvmBasicBlock): string[] {
  const meaningful = block.lines
    .filter((line) => line.trim())
    .slice(-4);
  return meaningful.length ? meaningful.map(shortenLabelLine) : ["empty"];
}

function readLlvmOutgoingEdges(terminator: string): Array<{ target: string; label: string }> {
  const line = terminator.trim();
  if (!line) {
    return [];
  }

  const unconditional = line.match(/^br\s+label\s+%?([A-Za-z$._-][A-Za-z$._0-9-]*|\d+)\b/);
  if (unconditional) {
    return [{ target: unconditional[1], label: "next" }];
  }

  const conditional = line.match(/^br\s+i1\b.*?,\s*label\s+%?([A-Za-z$._-][A-Za-z$._0-9-]*|\d+)\s*,\s*label\s+%?([A-Za-z$._-][A-Za-z$._0-9-]*|\d+)/);
  if (conditional) {
    return [
      { target: conditional[1], label: "then" },
      { target: conditional[2], label: "else" },
    ];
  }

  const invoke = line.match(/\bto\s+label\s+%?([A-Za-z$._-][A-Za-z$._0-9-]*|\d+)\s+unwind\s+label\s+%?([A-Za-z$._-][A-Za-z$._0-9-]*|\d+)/);
  if (invoke) {
    return [
      { target: invoke[1], label: "normal" },
      { target: invoke[2], label: "unwind" },
    ];
  }

  if (/^(switch|indirectbr)\b/.test(line)) {
    const labels = Array.from(line.matchAll(/\blabel\s+%?([A-Za-z$._-][A-Za-z$._0-9-]*|\d+)\b/g)).map((match) => match[1]);
    return labels.map((target, index) => ({
      target,
      label: index === 0 ? "default" : `case ${index}`,
    }));
  }

  return [];
}

function isLlvmTerminalInstruction(line: string): boolean {
  return /^(ret|resume|unreachable|cleanupret|catchret|catchswitch)\b/.test(line.trim());
}

function readLastInstruction(lines: string[]): string {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = stripLlvmComment(lines[index] ?? "").trim();
    if (line) {
      return line;
    }
  }
  return "";
}

function stripLlvmComment(line: string): string {
  const commentIndex = line.indexOf(";");
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function createGenericCodeGraphDot(block: lotusCodeBlock): string {
  const constructs = extractCodeConstructs(block.language, block.content);
  const nodes: GraphNode[] = [
    {
      id: "root",
      label: formatNodeLabel(["root", block.sourceLanguage || block.language]),
      align: "center",
      fontSize: 12,
    },
  ];
  const edges: GraphEdge[] = [];

  if (!constructs.length) {
    const chunks = chunkPlainSource(block.content);
    chunks.forEach((chunk, index) => {
      const id = `stmt_${index}`;
      nodes.push({ id, label: formatNodeLabel(chunk) });
      edges.push({ from: index === 0 ? "root" : `stmt_${index - 1}`, to: id, label: index === 0 ? "entry" : "next" });
    });
    return renderDot("lotus_code_graph", nodes, edges);
  }

  const limited = constructs.slice(0, MAX_GENERIC_NODES);
  const stack: Array<{ id: string; depth: number }> = [{ id: "root", depth: -1 }];
  let previousAtDepth = new Map<number, string>();

  limited.forEach((construct, index) => {
    const id = `node_${index}`;
    nodes.push({
      id,
      label: formatNodeLabel([
        `${construct.kind} L${construct.lineNumber}`,
        construct.label,
        ...construct.snippets,
      ]),
    });

    while (stack.length > 1 && stack[stack.length - 1].depth >= construct.depth) {
      stack.pop();
    }
    const parent = stack[stack.length - 1] ?? stack[0];
    const previous = previousAtDepth.get(construct.depth);
    if (previous && previous !== parent.id) {
      edges.push({ from: previous, to: id, label: "next" });
    } else {
      edges.push({ from: parent.id, to: id, label: parent.id === "root" ? "entry" : "body" });
    }

    stack.push({ id, depth: construct.depth });
    previousAtDepth = new Map([...previousAtDepth].filter(([depth]) => depth <= construct.depth));
    previousAtDepth.set(construct.depth, id);
  });

  if (constructs.length > limited.length) {
    nodes.push({ id: "more", label: `more nodes\\n${constructs.length - limited.length} hidden`, align: "center", fontSize: 11 });
    edges.push({ from: limited.length ? `node_${limited.length - 1}` : "root", to: "more", label: "..." });
  }

  return renderDot("lotus_code_graph", nodes, edges);
}

function extractCodeConstructs(language: lotusNormalizedLanguage, source: string): CodeConstruct[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const constructs: CodeConstruct[] = [];
  let braceDepth = 0;

  lines.forEach((line, index) => {
    const withoutStrings = removeQuotedText(line);
    const trimmed = withoutStrings.trim();
    const depth = computeConstructDepth(language, line, braceDepth);
    const construct = detectConstruct(language, trimmed, line.trim(), index + 1, depth);
    if (construct) {
      constructs.push(construct);
    }
    braceDepth = Math.max(0, braceDepth + countChar(withoutStrings, "{") - countChar(withoutStrings, "}"));
  });

  return attachConstructSnippets(constructs, lines, language);
}

function detectConstruct(language: lotusNormalizedLanguage, line: string, originalLine: string, lineNumber: number, depth: number): CodeConstruct | null {
  if (!line || isCommentLine(language, line)) {
    return null;
  }

  const normalized = language.toLowerCase();
  const patterns = getLanguagePatterns(normalized);
  for (const pattern of patterns) {
    const match = line.match(pattern.regex);
    if (match) {
      return {
        kind: pattern.kind,
        label: shortenLabelLine(originalLine),
        snippets: [],
        depth,
        lineNumber,
      };
    }
  }

  const generic = line.match(/\b(if|else\s+if|else|for|while|switch|case|try|catch|finally|return|yield|throw|raise|assert)\b\s*(.*)/);
  if (generic) {
    return {
      kind: generic[1].replace(/\s+/g, " "),
      label: shortenLabelLine(originalLine),
      snippets: [],
      depth,
      lineNumber,
    };
  }

  return null;
}

function attachConstructSnippets(constructs: CodeConstruct[], lines: string[], language: lotusNormalizedLanguage): CodeConstruct[] {
  return constructs.map((construct, index) => {
    const stopLine = constructs[index + 1]?.lineNumber ?? lines.length + 1;
    const constructLines = new Set(constructs.map((candidate) => candidate.lineNumber));
    const snippets: string[] = [];

    for (let lineNumber = construct.lineNumber + 1; lineNumber < stopLine && snippets.length < 2; lineNumber += 1) {
      if (constructLines.has(lineNumber)) {
        continue;
      }
      const rawLine = lines[lineNumber - 1] ?? "";
      const trimmed = rawLine.trim();
      if (!isSnippetLineUseful(language, trimmed)) {
        continue;
      }
      if (usesIndentDepth(language) && computeConstructDepth(language, rawLine, 0) <= construct.depth) {
        continue;
      }
      snippets.push(shortenLabelLine(trimmed));
    }

    return {
      ...construct,
      snippets,
    };
  });
}

function isSnippetLineUseful(language: lotusNormalizedLanguage, trimmed: string): boolean {
  if (!trimmed || isCommentLine(language, trimmed)) {
    return false;
  }
  return !/^(?:[}\])]+|end\b|fi\b|done\b|else\b|elif\b|catch\b|finally\b)/.test(trimmed);
}

function getLanguagePatterns(language: string): Array<{ kind: string; regex: RegExp }> {
  if (language === "python") {
    return [
      { kind: "class", regex: /^class\s+([A-Za-z_][\w.]*)/ },
      { kind: "def", regex: /^(?:async\s+)?def\s+([A-Za-z_][\w]*\s*\([^)]*\))/ },
      { kind: "if", regex: /^if\s+(.+):$/ },
      { kind: "elif", regex: /^elif\s+(.+):$/ },
      { kind: "else", regex: /^else:$/ },
      { kind: "for", regex: /^(?:async\s+)?for\s+(.+):$/ },
      { kind: "while", regex: /^while\s+(.+):$/ },
      { kind: "with", regex: /^(?:async\s+)?with\s+(.+):$/ },
      { kind: "try", regex: /^try:$/ },
      { kind: "except", regex: /^except\b(.*):$/ },
      { kind: "finally", regex: /^finally:$/ },
      { kind: "return", regex: /^return\b(.*)$/ },
    ];
  }

  if (language === "shell") {
    return [
      { kind: "function", regex: /^(?:function\s+)?([A-Za-z_][\w-]*\s*\(\)|[A-Za-z_][\w-]*\s*\(\)\s*\{)/ },
      { kind: "if", regex: /^if\s+(.+)/ },
      { kind: "elif", regex: /^elif\s+(.+)/ },
      { kind: "else", regex: /^else\b(.*)/ },
      { kind: "for", regex: /^for\s+(.+)/ },
      { kind: "while", regex: /^while\s+(.+)/ },
      { kind: "case", regex: /^case\s+(.+)/ },
    ];
  }

  if (language === "ruby") {
    return [
      { kind: "class", regex: /^class\s+(.+)/ },
      { kind: "module", regex: /^module\s+(.+)/ },
      { kind: "def", regex: /^def\s+(.+)/ },
      { kind: "if", regex: /^if\s+(.+)/ },
      { kind: "elsif", regex: /^elsif\s+(.+)/ },
      { kind: "else", regex: /^else\b(.*)/ },
      { kind: "while", regex: /^while\s+(.+)/ },
      { kind: "until", regex: /^until\s+(.+)/ },
      { kind: "return", regex: /^return\b(.*)$/ },
    ];
  }

  if (language === "go") {
    return [
      { kind: "func", regex: /^func\s+(.+?)\s*\{/ },
      { kind: "type", regex: /^type\s+(.+)/ },
      { kind: "if", regex: /^if\s+(.+?)\s*\{/ },
      { kind: "for", regex: /^for\b(.*?)\s*\{/ },
      { kind: "switch", regex: /^switch\b(.*?)\s*\{/ },
      { kind: "case", regex: /^case\s+(.+):$/ },
      { kind: "return", regex: /^return\b(.*)$/ },
    ];
  }

  if (language === "rust") {
    return [
      { kind: "fn", regex: /^(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(.+?)\s*\{/ },
      { kind: "impl", regex: /^impl\b(.*?)\s*\{/ },
      { kind: "struct", regex: /^(?:pub\s+)?struct\s+(.+)/ },
      { kind: "enum", regex: /^(?:pub\s+)?enum\s+(.+)/ },
      { kind: "trait", regex: /^(?:pub\s+)?trait\s+(.+)/ },
      { kind: "if", regex: /^if\s+(.+?)\s*\{/ },
      { kind: "match", regex: /^match\s+(.+?)\s*\{/ },
      { kind: "for", regex: /^for\s+(.+?)\s*\{/ },
      { kind: "while", regex: /^while\s+(.+?)\s*\{/ },
      { kind: "return", regex: /^return\b(.*)$/ },
    ];
  }

  if (language === "java") {
    return [
      { kind: "class", regex: /^(?:public|private|protected|abstract|final|\s)*class\s+([A-Za-z_][\w]*)/ },
      { kind: "interface", regex: /^(?:public|private|protected|\s)*interface\s+([A-Za-z_][\w]*)/ },
      { kind: "method", regex: /^(?:public|private|protected|static|final|synchronized|abstract|\s)+[\w<>[\],.?]+\s+([A-Za-z_][\w]*\s*\([^)]*\))\s*(?:throws\b.*?)?\{/ },
      { kind: "if", regex: /^if\s*\((.+)\)\s*\{/ },
      { kind: "for", regex: /^for\s*\((.+)\)\s*\{/ },
      { kind: "while", regex: /^while\s*\((.+)\)\s*\{/ },
      { kind: "switch", regex: /^switch\s*\((.+)\)\s*\{/ },
      { kind: "case", regex: /^case\s+(.+):$/ },
      { kind: "return", regex: /^return\b(.*)$/ },
    ];
  }

  if (language === "javascript" || language === "typescript" || language === "obsidian-js") {
    return [
      { kind: "class", regex: /^(?:export\s+)?class\s+([A-Za-z_$][\w$]*)/ },
      { kind: "function", regex: /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*\s*\([^)]*\))/ },
      { kind: "function", regex: /^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>)/ },
      { kind: "method", regex: /^(?:async\s+)?([A-Za-z_$][\w$]*\s*\([^)]*\))\s*\{/ },
      { kind: "if", regex: /^if\s*\((.+)\)\s*\{/ },
      { kind: "else if", regex: /^else\s+if\s*\((.+)\)\s*\{/ },
      { kind: "else", regex: /^else\b(.*)/ },
      { kind: "for", regex: /^for(?:\s+await)?\s*\((.+)\)\s*\{/ },
      { kind: "while", regex: /^while\s*\((.+)\)\s*\{/ },
      { kind: "switch", regex: /^switch\s*\((.+)\)\s*\{/ },
      { kind: "case", regex: /^case\s+(.+):$/ },
      { kind: "return", regex: /^return\b(.*)$/ },
    ];
  }

  return [
    { kind: "function", regex: /^(?:static\s+|inline\s+|extern\s+|constexpr\s+|const\s+|unsigned\s+|signed\s+|long\s+|short\s+|struct\s+|enum\s+|class\s+|template\s*<[^>]+>\s*)*[\w:*&<>,\s]+\s+([A-Za-z_~][\w:~]*\s*\([^;]*\))\s*(?:const\s*)?\{/ },
    { kind: "type", regex: /^(?:class|struct|enum|union)\s+([A-Za-z_][\w:]*)/ },
    { kind: "if", regex: /^if\s*\((.+)\)\s*\{/ },
    { kind: "else if", regex: /^else\s+if\s*\((.+)\)\s*\{/ },
    { kind: "else", regex: /^else\b(.*)/ },
    { kind: "for", regex: /^for\s*\((.+)\)\s*\{/ },
    { kind: "while", regex: /^while\s*\((.+)\)\s*\{/ },
    { kind: "switch", regex: /^switch\s*\((.+)\)\s*\{/ },
    { kind: "case", regex: /^case\s+(.+):$/ },
    { kind: "return", regex: /^return\b(.*)$/ },
  ];
}

function computeConstructDepth(language: lotusNormalizedLanguage, line: string, braceDepth: number): number {
  if (usesIndentDepth(language)) {
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const columns = Array.from(indent).reduce((total, char) => total + (char === "\t" ? 4 : 1), 0);
    return Math.floor(columns / 2);
  }

  const trimmed = removeQuotedText(line).trim();
  const closingPrefix = trimmed.match(/^[}\])]+/)?.[0].length ?? 0;
  return Math.max(0, braceDepth - closingPrefix);
}

function usesIndentDepth(language: lotusNormalizedLanguage): boolean {
  return ["python", "ruby", "shell", "haskell", "ocaml", "coq", "lean", "smtlib"].includes(language);
}

function isCommentLine(language: lotusNormalizedLanguage, line: string): boolean {
  if (["python", "ruby", "shell"].includes(language)) {
    return line.startsWith("#");
  }
  if (["haskell"].includes(language)) {
    return line.startsWith("--");
  }
  return line.startsWith("//") || line.startsWith("/*") || line.startsWith("*") || line.startsWith(";");
}

function chunkPlainSource(source: string): string[][] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 12);
  if (!lines.length) {
    return [["empty block"]];
  }

  const chunks: string[][] = [];
  for (let index = 0; index < lines.length; index += 3) {
    chunks.push(lines.slice(index, index + 3).map(shortenLabelLine));
  }
  return chunks;
}

function renderDot(name: string, nodes: GraphNode[], edges: GraphEdge[]): string {
  const graphNodes = [...nodes];
  const graphEdges: Array<{ from: string; to: string }> = [];
  edges.forEach((edge, index) => {
    if (!edge.label) {
      graphEdges.push({ from: edge.from, to: edge.to });
      return;
    }

    const labelNode = `edge_label_${index}`;
    graphNodes.push({
      id: labelNode,
      label: edge.label,
      align: "center",
      fontSize: EDGE_LABEL_FONT_SIZE,
      padding: EDGE_LABEL_PADDING,
    });
    graphEdges.push({ from: edge.from, to: labelNode });
    graphEdges.push({ from: labelNode, to: edge.to });
  });

  return [
    `digraph ${name} {`,
    "  graph [rankdir=TB,bgcolor=\"#ffffff\",pad=0.24,nodesep=0.95,ranksep=1.05,splines=polyline,outputorder=edgesfirst];",
    `  node [shape=plain,fontname="${GRAPH_FONT}",fontsize=${NODE_FONT_SIZE},margin=0];`,
    `  edge [color="#000000",fontcolor="#000000",fontname="${GRAPH_FONT}",fontsize=${EDGE_LABEL_FONT_SIZE},arrowsize=0.72,penwidth=1.05];`,
    ...graphNodes.map((node) => {
      const attrs = [
        `label=<${formatHtmlNodeLabel(node)}>`,
        node.fontSize ? `fontsize=${node.fontSize}` : "",
      ].filter(Boolean).join(",");
      return `  ${node.id} [${attrs}];`;
    }),
    ...graphEdges.map((edge) => `  ${edge.from} -> ${edge.to};`),
    "}",
  ].join("\n");
}

function formatNodeLabel(lines: string[]): string {
  return lines
    .flatMap((line) => wrapLabelLine(shortenLabelLine(line)))
    .filter(Boolean)
    .join("\\n");
}

function formatHtmlNodeLabel(node: GraphNode): string {
  const lines = node.label
    .split(/\\n|\n/g)
    .map((line) => line.trim())
    .filter(Boolean);
  const safeLines = lines.length ? lines : [""];
  const pointSize = node.fontSize ?? NODE_FONT_SIZE;
  const padding = node.padding ?? NODE_PADDING;
  const rows = safeLines.map((line, index) => {
    const align = node.align === "center" || index === 0 ? "CENTER" : "LEFT";
    return `<TR><TD ALIGN="${align}"><FONT FACE="${GRAPH_FONT}" POINT-SIZE="${pointSize}">${escapeHtmlLabel(line)}</FONT></TD></TR>`;
  });
  return `<TABLE BORDER="1" CELLBORDER="0" CELLSPACING="0" CELLPADDING="${padding}" COLOR="#000000" BGCOLOR="#ffffff">${rows.join("")}</TABLE>`;
}

function shortenLabelLine(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= MAX_LABEL_LINE_LENGTH) {
    return normalized;
  }
  return `${normalized.slice(0, MAX_LABEL_LINE_LENGTH - 3)}...`;
}

function wrapLabelLine(value: string): string[] {
  const normalized = value.trim();
  if (normalized.length <= WRAP_LABEL_LINE_LENGTH) {
    return [normalized];
  }

  const rows: string[] = [];
  let remaining = normalized;
  while (remaining.length > WRAP_LABEL_LINE_LENGTH && rows.length < 5) {
    const breakAt = findLabelBreakIndex(remaining);
    rows.push(remaining.slice(0, breakAt).trimEnd());
    remaining = `  ${remaining.slice(breakAt).trimStart()}`;
  }

  if (remaining.length) {
    rows.push(remaining);
  }
  return rows;
}

function findLabelBreakIndex(value: string): number {
  const window = value.slice(0, WRAP_LABEL_LINE_LENGTH + 1);
  const candidates = [
    window.lastIndexOf(", "),
    window.lastIndexOf(" "),
    window.lastIndexOf(") "),
    window.lastIndexOf("] "),
  ].filter((index) => index >= Math.floor(WRAP_LABEL_LINE_LENGTH * 0.45));
  const best = Math.max(...candidates);
  return best > 0 ? best + (window[best] === "," ? 1 : 0) : WRAP_LABEL_LINE_LENGTH;
}

function escapeHtmlLabel(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function countChar(value: string, char: string): number {
  let count = 0;
  for (const current of value) {
    if (current === char) {
      count += 1;
    }
  }
  return count;
}

function removeQuotedText(value: string): string {
  return value
    .replace(/"([^"\\]|\\.)*"/g, "\"\"")
    .replace(/'([^'\\]|\\.)*'/g, "''")
    .replace(/`([^`\\]|\\.)*`/g, "``");
}

function looksLikeGraphvizDot(value: string): boolean {
  return /^(?:strict\s+)?(?:di)?graph\b[\s\S]*\{[\s\S]*\}\s*$/i.test(value.trim());
}

function looksLikeSvg(value: string): boolean {
  return /^(?:<\?xml\b[^>]*>\s*)?<svg\b[\s\S]*<\/svg>\s*$/i.test(value.trim());
}
