// Listing text is public input anyone can post (second audit, S1). React
// escapes it, so it can't inject markup, but it can still mislead: bidi
// overrides that reorder what you read, zero-width characters that make two
// titles look the same, and control characters. Strip those before showing it.

// Bidi embeddings, overrides and isolates, and the directional marks.
const BIDI = /[‪-‮⁦-⁩‎‏؜]/g;
// Zero-width spaces and joiners, the word joiner, and the byte-order mark.
const ZERO_WIDTH = /[​-‍⁠﻿]/g;
// C0 and C1 controls, except tab and newline.
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

function strip(text: string): string {
  return text.replace(BIDI, "").replace(ZERO_WIDTH, "").replace(CONTROL, "");
}

/** A title for display: one line, no hidden characters, spaces collapsed. */
export function cleanTitle(text: string): string {
  return strip(text).replace(/\s+/g, " ").trim();
}

/** A question for display: line breaks kept (at most one blank line), no hidden characters. */
export function cleanDetails(text: string): string {
  return strip(text)
    .replace(/\t/g, " ")
    .replace(/[  ]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Whether `text` had characters stripped, so the page can say so. */
export function hadHiddenCharacters(text: string): boolean {
  return strip(text) !== text;
}
