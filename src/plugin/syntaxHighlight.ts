import { highlightLlvmElement } from "./llvmHighlight";
import { normalizeSyntaxLanguage } from "../engine/syntaxLanguage";

export { normalizeSyntaxLanguage };

interface PrismLike {
  highlightElement?: (element: Element) => void;
}

export function addSyntaxLanguageClass(element: HTMLElement, language: string | null | undefined): string | null {
  const normalized = normalizeSyntaxLanguage(language);
  if (!normalized) {
    return null;
  }

  element.addClass(`language-${normalized}`);
  return normalized;
}

export function highlightCodeElement(codeElement: HTMLElement, source: string, language: string | null | undefined): void {
  const normalized = addSyntaxLanguageClass(codeElement, language);
  const parent = codeElement.parentElement;
  if (parent instanceof HTMLElement) {
    addSyntaxLanguageClass(parent, normalized);
  }

  if (normalized === "llvm-ir") {
    highlightLlvmElement(codeElement, source);
    return;
  }

  try {
    const prism = (window as typeof window & { Prism?: PrismLike }).Prism;
    prism?.highlightElement?.(codeElement);
  } catch {
    return;
  }
}
