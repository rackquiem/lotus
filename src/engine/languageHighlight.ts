import { findEnabledCommandLanguage } from "./languagePackages";
import { normalizeLanguage } from "./parser";
import { normalizeSyntaxLanguage } from "./syntaxLanguage";
import type { lotusCodeBlock, lotusNormalizedLanguage, lotusPluginSettings } from "./types";

export function resolveBlockHighlightLanguage(settings: lotusPluginSettings, block: lotusCodeBlock): lotusNormalizedLanguage | null {
  const language = findEnabledCommandLanguage(settings, block.language, block.languageAlias);
  return resolveHighlightLanguageReference(settings, language?.highlightLanguage);
}

export function resolveHighlightLanguageReference(
  settings: lotusPluginSettings,
  language: string | undefined,
  seen: Set<string> = new Set(),
): lotusNormalizedLanguage | null {
  const requested = normalizeSyntaxLanguage(language);
  if (!requested) {
    return null;
  }

  const normalized = normalizeLanguage(requested, settings) ?? requested;
  const commandLanguage = findEnabledCommandLanguage(settings, normalized, requested);
  if (!commandLanguage) {
    return normalized;
  }

  const commandName = normalizeSyntaxLanguage(commandLanguage.name) ?? normalized;
  if (seen.has(commandName)) {
    return normalized;
  }
  seen.add(commandName);

  return resolveHighlightLanguageReference(settings, commandLanguage.highlightLanguage, seen) ?? normalized;
}
