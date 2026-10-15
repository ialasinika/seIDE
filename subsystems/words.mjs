/**
 * words.mjs -- the built-in subsystem: word completion and syntax diagnostics.
 *
 * It is the one subsystem that works on *any* file with no server, no network
 * and no configuration: everything it knows comes from the text in front of it.
 * That is the point -- a user who opens a language nothing else supports still
 * gets completion for the words in the file, and still gets told about the
 * bracket they left open.
 *
 * Nothing here is language-specific: no keyword table, no grammar, no file
 * extension is consulted.  Language *knowledge* lives in `langs/` descriptors
 * and, for real languages, behind an `lsp` subsystem.
 *
 * The tokenizer in `langs/tokenize.mjs` is imported lazily and only to make the
 * diagnostics quieter: a bracket inside a string literal is not a bracket.  If
 * `langs/` has been deleted the import fails and this file still works on raw
 * text, which is the promise `langs/README.md` makes about deletability.
 */

import { fileURLToPath } from "node:url";

const LIMIT = 200;
const DIAGNOSTIC_CODES = {
  UNCLOSED: "unclosed",
  UNMATCHED: "unmatched",
  STRAY_CLOSE: "stray-close",
  COMMENT: "unterminated-comment",
  STRING: "unterminated-string",
};

const OPENERS = { "(": ")", "[": "]", "{": "}" };
const CLOSERS = { ")": "(", "]": "[", "}": "{" };

function clampLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return LIMIT;
  return Math.min(Math.floor(n), 1000);
}

/* ------------------------------------------------------------------ */
/* completion                                                          */
/* ------------------------------------------------------------------ */

/** The identifier the caret sits in, or null when it sits in whitespace. */
export function prefixAt(text, offset) {
  const before = text.slice(0, Math.max(0, Math.min(offset, text.length)));
  const match = /-{0,2}[A-Za-z_$][A-Za-z0-9_$-]*$/.exec(before);
  return match === null ? "" : match[0];
}

/**
 * Words worth offering, in the order a reader would want them: what starts with
 * the prefix, most used first, shortest first, then alphabetical so the list is
 * stable between keystrokes.
 */
export function complete({ text = "", offset = 0, words = [], limit = LIMIT } = {}) {
  const prefix = prefixAt(text, offset);
  const counts = new Map();

  const note = (word, kind) => {
    if (typeof word !== "string" || word.length === 0 || word.length > 64) return;
    if (!/^-{0,2}[A-Za-z_$][A-Za-z0-9_$-]*$/.test(word)) return;
    const entry = counts.get(word);
    if (entry === undefined) {
      counts.set(word, { word, kind, count: 1 });
      return;
    }
    entry.count += 1;
    // A word seen in the file is a better answer than one only sent along by
    // the client, so "word" wins over "project" once both have been seen.
    if (kind === "word") entry.kind = "word";
  };

  const pattern = /-{0,2}[A-Za-z_$][A-Za-z0-9_$-]*/g;
  for (const match of String(text).matchAll(pattern)) note(match[0], "word");
  for (const word of Array.isArray(words) ? words : []) note(word, "project");

  const wanted = prefix.toLowerCase();
  const items = [];
  for (const entry of counts.values()) {
    if (prefix !== "" && entry.word === prefix) continue;      // asking for what is already typed
    if (wanted !== "" && !entry.word.toLowerCase().startsWith(wanted)) continue;
    items.push({
      label: entry.word,
      kind: entry.kind,
      count: entry.count,
      detail: entry.kind === "word" ? "in this file" : "in this project",
    });
  }

  const caseFirst = (word) => (wanted !== "" && word.startsWith(prefix) ? 0 : 1);
  items.sort((a, b) =>
    caseFirst(a.label) - caseFirst(b.label) ||
    b.count - a.count ||
    a.label.length - b.label.length ||
    a.label.localeCompare(b.label));

  const limitN = clampLimit(limit);
  return {
    prefix,
    items: items.slice(0, limitN).map(({ label, kind, detail }) => ({ label, kind, detail })),
    total: items.length,
    truncated: items.length > limitN,
  };
}

/* ------------------------------------------------------------------ */
/* diagnostics                                                         */
/* ------------------------------------------------------------------ */

/** Spans the scanner is sure are not code, so brackets inside them are text. */
function quietSpans(text, path, scanner, langId) {
  if (scanner === null) return [];
  try {
    const lang = scanner.registry.resolve({
      path: typeof path === "string" ? path : null,
      lang: typeof langId === "string" ? langId : null,
    });
    return scanner.tokenize(lang, text).filter((span) => span[2] === "string" || span[2] === "comment");
  } catch {
    return [];
  }
}

function inSpans(spans, offset) {
  return spans.some(([start, end]) => offset >= start && offset < end);
}

/**
 * Three rules, all of them provable from the text alone:
 *
 *   - brackets that never close, close the wrong one, or close nothing;
 *   - a `/*` with no `*​/` after it;
 *   - an odd number of quotes on a line.
 *
 * Severity is `error` for the first two and `warning` for the quote count,
 * because a lone apostrophe in prose is common and a client that shouts about
 * it is a client nobody leaves on.
 */
export function diagnose({ text = "", path = null, lang = null, limit = LIMIT } = {}, scanner = null) {
  const source = String(text);
  const quiet = quietSpans(source, path, scanner, lang);
  const diagnostics = [];
  const stack = [];

  for (let at = 0; at < source.length; at += 1) {
    const char = source[at];
    if (inSpans(quiet, at)) continue;

    if (OPENERS[char] !== undefined) {
      stack.push({ char, at });
      continue;
    }
    if (CLOSERS[char] !== undefined) {
      const top = stack.pop();
      if (top === undefined) {
        diagnostics.push({
          start: at,
          end: at + 1,
          severity: "error",
          code: DIAGNOSTIC_CODES.STRAY_CLOSE,
          message: `\`${char}\` closes nothing`,
        });
      } else if (top.char !== CLOSERS[char]) {
        diagnostics.push({
          start: at,
          end: at + 1,
          severity: "error",
          code: DIAGNOSTIC_CODES.UNMATCHED,
          message: `\`${char}\` closes \`${top.char}\` (opened at line ${lineOf(source, top.at)})`,
        });
      }
    }
  }

  for (const open of stack.reverse()) {
    diagnostics.push({
      start: open.at,
      end: open.at + 1,
      severity: "error",
      code: DIAGNOSTIC_CODES.UNCLOSED,
      message: `\`${open.char}\` is never closed`,
    });
  }

  const comment = openBlockComment(source, quiet);
  if (comment !== null) {
    diagnostics.push({
      start: comment,
      end: Math.min(comment + 2, source.length),
      severity: "error",
      code: DIAGNOSTIC_CODES.COMMENT,
      message: "`/*` is never closed",
    });
  }

  for (const line of quoteProblems(source, quiet)) diagnostics.push(line);

  diagnostics.sort((a, b) => a.start - b.start || a.end - b.end);
  const limitN = clampLimit(limit);
  return {
    diagnostics: diagnostics.slice(0, limitN),
    total: diagnostics.length,
    truncated: diagnostics.length > limitN,
    path,
  };
}

/** 1-based line of an offset, for messages that have to be actionable. */
export function lineOf(text, offset) {
  let line = 1;
  for (let at = 0; at < offset && at < text.length; at += 1) {
    if (text[at] === "\n") line += 1;
  }
  return line;
}

function openBlockComment(source, quiet) {
  const start = source.lastIndexOf("/*");
  if (start === -1) return null;
  if (source.indexOf("*/", start + 2) !== -1) return null;
  // A `/*` inside a string literal or a line comment is text, not an opener.
  if (inSpans(quiet, start)) return null;
  return start;
}

function quoteProblems(source, quiet) {
  const found = [];
  const lines = source.split("\n");
  let base = 0;
  for (const line of lines) {
    for (const quote of ['"', "'"]) {
      let count = 0;
      for (let at = 0; at < line.length; at += 1) {
        if (line[at] !== quote) continue;
        if (at > 0 && line[at - 1] === "\\") continue;
        if (inSpans(quiet, base + at)) continue;   // a quote inside a string or comment is text
        count += 1;
      }
      if (count % 2 === 1) {
        found.push({
          start: base + line.length,
          end: base + line.length,
          severity: "warning",
          code: DIAGNOSTIC_CODES.STRING,
          message: `this line has an odd number of \`${quote}\``,
        });
      }
    }
    base += line.length + 1;
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* the adapter                                                         */
/* ------------------------------------------------------------------ */

export const SUBJECTS = ["complete", "diagnose"];

/**
 * The host calls this once, when the subsystem is first needed.  Everything the
 * adapter answers arrives as `request(method, params)`.
 */
export async function create(context) {
  let scanner = null;
  try {
    const lang = await import("../langs/lang.mjs");
    const tokenize = await import("../langs/tokenize.mjs");
    const dir = fileURLToPath(new URL("../langs/", import.meta.url));
    scanner = {
      registry: new lang.LangRegistry(lang.loadLanguages(dir, { onError: null })),
      tokenize: tokenize.tokenize,
    };
  } catch {
    scanner = null;   // `langs/` deleted: diagnostics run on raw text
  }

  if (context && typeof context.emit === "function") {
    context.emit({
      event: "subsystem.log",
      message: `words: ${scanner === null ? "raw text (langs/ absent)" : "langs/ available"}`,
    });
  }

  return {
    /** `complete` and `diagnose` are the whole surface; anything else is a bug. */
    async request(method, params) {
      if (method === "complete") return complete(params ?? {});
      if (method === "diagnose") return diagnose(params ?? {}, scanner);
      const error = new Error(`words does not answer \`${method}\``);
      error.code = -32601;
      error.rpcName = "METHOD_NOT_FOUND";
      throw error;
    },
  };
}
