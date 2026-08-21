import assert from "node:assert/strict";
import {
  LOTUS_MANAGED_DISPLAY_LANGUAGE,
  parseManagedDisplaySource,
  renderManagedOutputMarkdown,
} from "../src/engine/managedOutput.ts";

const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\"><text>not ``` code</text></svg>";
const result = {
  runnerId: "test",
  runnerName: "Managed output test",
  startedAt: "2026-08-11T18:00:00.000Z",
  finishedAt: "2026-08-11T18:00:00.010Z",
  durationMs: 10,
  exitCode: 0,
  stdout: "rendered",
  stderr: "",
  success: true,
  timedOut: false,
  cancelled: false,
  displays: [{
    title: "SVG result",
    role: "visualization",
    data: {
      "image/svg+xml": svg,
      "text/plain": "SVG result",
    },
    metadata: { width: 320, height: 180, alt: "test diagram" },
  }],
};

const rendered = renderManagedOutputMarkdown("abc123", result);
const textFenceEnd = rendered.indexOf("```", 2);
assert.ok(textFenceEnd > 0);
assert.doesNotMatch(rendered.slice(0, textFenceEnd + 1).join("\n"), /image\/svg\+xml|<svg/);

const displayFenceStart = rendered.findIndex((line) => line.endsWith(LOTUS_MANAGED_DISPLAY_LANGUAGE));
assert.ok(displayFenceStart > textFenceEnd);
const displayFence = rendered[displayFenceStart].slice(0, -LOTUS_MANAGED_DISPLAY_LANGUAGE.length);
const displayFenceEnd = rendered.indexOf(displayFence, displayFenceStart + 1);
assert.ok(displayFence.length > 3, "the fence must grow past backticks contained in display data");
assert.ok(displayFenceEnd > displayFenceStart);

const source = rendered.slice(displayFenceStart + 1, displayFenceEnd).join("\n");
assert.deepEqual(parseManagedDisplaySource(source), result.displays);
assert.deepEqual(parseManagedDisplaySource(JSON.stringify(result.displays[0])), result.displays);
assert.throws(() => parseManagedDisplaySource("{}"), /MIME display records/);

console.log("managed output tests passed");
