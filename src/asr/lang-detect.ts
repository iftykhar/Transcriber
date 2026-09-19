import type { Lang } from "../types/transcript";

// Bengali/English routing for a finished transcript segment.
//
// Whisper *can* report the detected language, but it is unreliable on the
// short, noisy utterances this pipeline produces, and it is not always
// surfaced by transformers.js. So the primary signal is the Unicode script
// of the decoded text (Bengali block U+0980-U+09FF vs. Latin letters), with
// Whisper's guess used only as a tie-breaker / fallback.
//
// Kept free of runtime imports on purpose: pure logic, directly testable
// via Node's type stripping.

export interface LangResult {
  lang: Lang;
  /** 0..1. How much to trust `lang`. */
  confidence: number;
}

/** Bengali script block (U+0980-U+09FF). */
const BENGALI = /[\u0980-\u09FF]/;
/** Latin letters, including the accented range. */
const LATIN = /[A-Za-z\u00C0-\u024F]/;

function countMatches(text: string, re: RegExp): number {
  const global = new RegExp(re.source, "g");
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = global.exec(text)) !== null) {
    n++;
    // Zero-width guards are not used, but be defensive anyway.
    if (m.index === global.lastIndex) global.lastIndex++;
  }
  return n;
}

/** Normalise Whisper's language field ("bengali", "bn", "english", ...) to our `Lang`. */
export function normaliseWhisperLang(value: string | null | undefined): Lang {
  if (!value) return "unknown";
  const v = value.trim().toLowerCase();
  if (v === "bn" || v === "ben" || v.startsWith("bengali")) return "bn";
  if (v === "en" || v === "eng" || v.startsWith("english")) return "en";
  return "unknown";
}

export function detectLang(text: string, whisperLang?: string | null): LangResult {
  const hint = normaliseWhisperLang(whisperLang);
  const trimmed = text.trim();

  if (trimmed.length === 0) {
    // Nothing decoded; only the model's own opinion is available.
    return hint === "unknown" ? { lang: "unknown", confidence: 0 } : { lang: hint, confidence: 0.3 };
  }

  const bnChars = countMatches(trimmed, BENGALI);
  const enChars = countMatches(trimmed, LATIN);

  // Also test for the leading char so a single-script sentence is obvious
  // even if it is mostly digits/punctuation.
  const hasBn = bnChars > 0 || BENGALI.test(trimmed);
  const hasEn = enChars > 0 || LATIN.test(trimmed);

  if (!hasBn && !hasEn) {
    // Digits / punctuation only.
    return hint === "unknown" ? { lang: "unknown", confidence: 0.2 } : { lang: hint, confidence: 0.4 };
  }

  let scriptLang: Lang;
  let scriptConfidence: number;

  if (hasBn && !hasEn) {
    scriptLang = "bn";
    scriptConfidence = 1;
  } else if (hasEn && !hasBn) {
    scriptLang = "en";
    scriptConfidence = 1;
  } else {
    // Mixed script — very common in Bangladeshi technical speech
    // ("the API কল দিও"). Whichever dominates wins, at reduced confidence.
    const dominant = bnChars >= enChars ? "bn" : "en";
    const total = bnChars + enChars;
    scriptLang = dominant;
    // 0.5 (dead heat) .. ~1 (heavily dominant).
    scriptConfidence = total === 0 ? 0.5 : 0.4 + 0.6 * (Math.max(bnChars, enChars) / total);
  }

  if (hint === "unknown") {
    return { lang: scriptLang, confidence: scriptConfidence };
  }

  if (hint === scriptLang) {
    // Two independent signals agree.
    return { lang: scriptLang, confidence: Math.min(1, scriptConfidence + 0.15) };
  }

  // They disagree. The script is verifiable from the actual characters, so
  // keep it, but record the disagreement by dropping confidence.
  return { lang: scriptLang, confidence: scriptConfidence * 0.6 };
}
