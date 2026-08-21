import assert from "node:assert/strict";
import {
  parseDynamicInputDirectives,
  resolveDynamicInputValues,
  substituteDynamicInputValues,
} from "../src/engine/dynamicInputs.ts";

const source = [
  "# @lotus-slider name=count label=\"Count\" min=1 max=10 step=1 default=4",
  "// @lotus-text name=message label='Message' default=\"hello world\"",
  "-- @lotus-checkbox name=verbose checked=true value=YES unchecked=NO",
  "; @lotus-select name=mode options=\"Fast:fast,Safe:safe\" default=safe",
  "print({{ count }}, \"{{message}}\", \"{{verbose}}\", \"{{mode}}\")",
].join("\n");
const parsed = parseDynamicInputDirectives(source);

assert.deepEqual(parsed.errors, []);
assert.equal(parsed.inputs.length, 4);
assert.equal(parsed.source.split("\n").length, source.split("\n").length);
assert.equal(parsed.source.split("\n").slice(0, 4).join(""), "");
assert.deepEqual({ ...resolveDynamicInputValues(parsed.inputs) }, {
  count: "4",
  message: "hello world",
  verbose: "YES",
  mode: "safe",
});

const values = resolveDynamicInputValues(parsed.inputs, { count: "7", message: "changed" });
assert.equal(
  substituteDynamicInputValues(parsed.source, values),
  "\n\n\n\nprint(7, \"changed\", \"YES\", \"safe\")",
);
assert.equal(substituteDynamicInputValues("{{known}} {{unknown}}", { known: "ok" }), "ok {{unknown}}");

const buttons = parseDynamicInputDirectives([
  "/* @lotus-button name=operation label=Add value=add */",
  "(* @lotus-button name=operation label=Subtract value=subtract *)",
].join("\n"));
assert.deepEqual(buttons.errors, []);
assert.equal(buttons.inputs.length, 2);
assert.equal(resolveDynamicInputValues(buttons.inputs).operation, "add");

assert.match(
  parseDynamicInputDirectives("# @lotus-slider name=x min=10 max=1").errors[0],
  /min must be less than or equal to max/,
);
assert.match(
  parseDynamicInputDirectives([
    "# @lotus-text name=x",
    "# @lotus-number name=x",
  ].join("\n")).errors[0],
  /duplicate name/,
);
assert.match(
  parseDynamicInputDirectives("# @lotus-select name=x options=\"a,b\" default=c").errors[0],
  /is not in options/,
);

console.log("dynamic input tests passed");
