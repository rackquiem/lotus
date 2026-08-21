import type { lotusCodeBlock, lotusPluginSettings, lotusRunner } from "../types";
import { findEnabledCommandLanguage, isLanguageEnabled } from "../languagePackages";

export class lotusRunnerRegistry {
  constructor(private readonly runners: lotusRunner[]) {}

  getRunnerForBlock(block: lotusCodeBlock, settings: lotusPluginSettings): lotusRunner | null {
    if (!this.isBlockLanguageEnabled(block, settings)) {
      return null;
    }
    return this.runners.find((runner) => (!runner.languages.length || runner.languages.includes(block.language)) && runner.canRun(block, settings)) ?? null;
  }

  getSupportedLanguages(): string[] {
    return [...new Set(this.runners.flatMap((runner) => runner.languages))];
  }

  private isBlockLanguageEnabled(block: lotusCodeBlock, settings: lotusPluginSettings): boolean {
    if (isLanguageEnabled(block.language, settings)) {
      return true;
    }
    return Boolean(findEnabledCommandLanguage(settings, block.language, block.languageAlias));
  }
}
