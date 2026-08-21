import tsparser from "@typescript-eslint/parser";
import { defineConfig } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";
import { PlainTextParser } from "eslint-plugin-obsidianmd/dist/lib/plainTextParser.js";
import globals from "globals";

const existingTypeScriptDebtRules = {
  "@typescript-eslint/no-base-to-string": "off",
  "@typescript-eslint/no-deprecated": "off",
  "@typescript-eslint/no-explicit-any": "off",
  "@typescript-eslint/no-misused-promises": "off",
  "@typescript-eslint/no-this-alias": "off",
  "@typescript-eslint/no-unsafe-argument": "off",
  "@typescript-eslint/no-unsafe-assignment": "off",
  "@typescript-eslint/no-unsafe-call": "off",
  "@typescript-eslint/no-unsafe-member-access": "off",
  "@typescript-eslint/prefer-promise-reject-errors": "off",
  "@typescript-eslint/restrict-template-expressions": "off",
};

const nonBlockingObsidianGuidelineRules = {
  "obsidianmd/commands/no-plugin-name-in-command-name": "warn",
  "obsidianmd/hardcoded-config-path": "warn",
  "obsidianmd/no-static-styles-assignment": "warn",
  "obsidianmd/prefer-window-timers": "warn",
  "obsidianmd/ui/sentence-case": "warn",
};

export default defineConfig([
  {
    ignores: [
      ".lotus/**",
      ".obsidian/**",
      "dist/**",
      "main.js",
      "node_modules/**",
    ],
  },
  ...obsidianmd.configs.recommended,
  {
    rules: {
      ...existingTypeScriptDebtRules,
      ...nonBlockingObsidianGuidelineRules,
      "no-control-regex": "off",
      "no-useless-escape": "off",
    },
  },
  {
    files: ["src/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      parser: tsparser,
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ["src/engine/**/*.ts"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "obsidian", message: "src/engine must not depend on Obsidian; pass a host interface from src/plugin instead." },
          { name: "electron", message: "src/engine must not depend on Electron." },
        ],
        patterns: [
          { group: ["@codemirror/*"], message: "src/engine must not depend on CodeMirror; editor integration lives in src/plugin." },
          { group: ["../plugin/*", "../../plugin/*", "../../../plugin/*"], message: "src/engine must not import from src/plugin." },
        ],
      }],
    },
  },
  {
    files: ["scripts/**/*.ts", "scripts/**/*.mjs", "esbuild.config.mjs"],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      "import/no-extraneous-dependencies": "off",
      "no-console": "off",
      "no-restricted-imports": "off",
      "no-unused-vars": "off",
      "obsidianmd/hardcoded-config-path": "off",
      "obsidianmd/rule-custom-message": "off",
    },
  },
  {
    files: ["**/*.js", "**/*.mjs", "**/*.cjs"],
    rules: {
      "@typescript-eslint/no-deprecated": "off",
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/prefer-instanceof": "off",
    },
  },
  {
    files: ["manifest.json"],
    languageOptions: {
      parser: tsparser,
    },
    rules: {
      "@typescript-eslint/no-deprecated": "off",
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/prefer-instanceof": "off",
      "obsidianmd/validate-manifest": "error",
    },
  },
  {
    files: ["LICENSE"],
    languageOptions: {
      parser: PlainTextParser,
    },
    rules: {
      "@typescript-eslint/no-deprecated": "off",
      "obsidianmd/no-plugin-as-component": "off",
      "obsidianmd/no-unsupported-api": "off",
      "obsidianmd/no-view-references-in-plugin": "off",
      "obsidianmd/prefer-file-manager-trash-file": "off",
      "obsidianmd/prefer-instanceof": "off",
      "obsidianmd/validate-license": "error",
    },
  },
  {
    rules: {
      "obsidianmd/ui/sentence-case": [
        "warn",
        {
          brands: ["Lotus", "Obsidian", "CodeMirror", "OpenSSH", "SSH", "RSA-PSS", "PDF", "Z3", "OCaml", "LLVM", "eBPF", "QEMU", "WSL", "Docker", "Podman"],
          acronyms: ["API", "DOM", "HTML", "IR", "JSON", "JS", "PDF", "RSA", "SSH", "UI", "WSL", "Z3"],
          enforceCamelCaseLower: true,
        },
      ],
    },
  },
]);
