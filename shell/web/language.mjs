/**
 * language.mjs -- the editor's language questions, answered by a subsystem.
 *
 * The kernel knows nothing about a language, and that is the whole point of
 * `docs/SUBSYSTEMS.md`: a capability lives outside the kernel and is reached
 * over one wire (`subsystem.request`).  This module is the client half of that
 * wire.  It answers four questions:
 *
 *   complete    what could go here          -> a ranked list to insert
 *   diagnose    what is wrong with this     -> spans to draw
 *   hover       what is this                -> text to show
 *   definition  where is it defined         -> a path and a position
 *
 * Two subsystems can answer them and they do not agree on shape: `words`
 * speaks offsets and calls its list `items`, `lsp` speaks LSP positions and
 * calls it `items` too but names the plumbing differently.  Normalising both
 * here is what keeps the editor from knowing which one answered -- the popup
 * and the issue strip are drawn from the shapes below, whatever is behind them.
 *
 * Almost everything in this file is a pure function of its arguments, which is
 * why the suite can check the arithmetic without a browser.  The one impure
 * thing is the injected `call`.
 */

/** The capabilities this client asks for, in the order it prefers them. */
export const LANGUAGE_CAPABILITIES = ["completion", "diagnostics", "hover", "definition", "format"];

/** How many completions the popup will hold, and how many issues it will draw. */
export const COMPLETION_LIMIT = 50;
export const ISSUE_LIMIT = 100;

/**
 * How long a second try at diagnostics waits for a server that had not said
 * anything about the buffer yet.  Longer than the first: the first try is what
 * asked it to look, so the answer is already on its way.
 */
const DIAGNOSE_RETRY_WAIT = 2000;

/** A character that can be part of a word, for prefix purposes. */
const WORD_CHAR = /[A-Za-z0-9_$]/;

/**
 * The identifier fragment immediately before `offset`.
 *
 * This is what a completion replaces, so it has to be the same rule on both
 * ends of the pipe: `words.mjs` exports the same idea as `prefixAt`, and an
 * insertion that replaced a different span would corrupt the line.
 *
 * @param {string} text
 * @param {number} offset  a UTF-16 index into `text`
 * @returns {string}
 */
export function completionPrefix(text, offset) {
  if (typeof text !== "string" || text === "") return "";
  let end = Number.isInteger(offset) ? Math.max(0, Math.min(offset, text.length)) : text.length;
  let start = end;
  while (start > 0 && WORD_CHAR.test(text[start - 1])) start -= 1;
  return text.slice(start, end);
}

/**
 * Where the word being typed starts, so a caller can compute the replacement
 * span itself.  `completionPrefix` is its text.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {number}
 */
export function completionStart(text, offset) {
  const prefix = completionPrefix(text, offset);
  const end = Number.isInteger(offset) ? Math.max(0, Math.min(offset, text.length)) : text.length;
  return end - prefix.length;
}

/**
 * Rank what could come next.
 *
 * The ranking is deliberately boring and stable: a case-exact prefix first,
 * then a shorter label, then alphabetical.  Nothing here consults a language,
 * a keyword table or a grammar -- the subsystem that answered decides what is
 * on the list, and this decides only what the user sees first.
 *
 * @param {Array<{label: string, kind?: string, detail?: string}>} items
 * @param {string} prefix
 * @param {number} [limit]
 * @returns {{prefix: string, items: Array<object>, total: number, truncated: boolean}}
 */
export function rankCompletions(items, prefix, limit = COMPLETION_LIMIT) {
  const list = Array.isArray(items) ? items : [];
  const needle = typeof prefix === "string" ? prefix : "";
  const lower = needle.toLowerCase();

  const seen = new Set();
  const kept = [];
  for (const item of list) {
    if (item === null || typeof item !== "object") continue;
    const label = typeof item.label === "string" ? item.label : "";
    if (label === "" || label === needle) continue;
    if (lower !== "" && !label.toLowerCase().startsWith(lower)) continue;
    if (seen.has(label)) continue;
    seen.add(label);
    kept.push(item);
  }

  kept.sort((a, b) => {
    const exactA = a.label.startsWith(needle) ? 0 : 1;
    const exactB = b.label.startsWith(needle) ? 0 : 1;
    if (exactA !== exactB) return exactA - exactB;
    if (a.label.length !== b.label.length) return a.label.length - b.label.length;
    return a.label.localeCompare(b.label);
  });

  const cap = Number.isInteger(limit) && limit > 0 ? limit : COMPLETION_LIMIT;
  return {
    prefix: needle,
    items: kept.slice(0, cap),
    total: kept.length,
    truncated: kept.length > cap,
  };
}

/**
 * Insert a completion over the prefix at the caret.
 *
 * The result is the new text and where the caret lands; the caller owns the
 * textarea.  No indentation, no snippets, no signature help: those need a
 * language server that can say what they mean, and pretending otherwise would
 * make this function a liar.
 *
 * @param {string} text
 * @param {number} offset
 * @param {string} label
 * @returns {{text: string, caret: number}}
 */
export function insertCompletion(text, offset, label) {
  const source = typeof text === "string" ? text : "";
  const at = Number.isInteger(offset) ? Math.max(0, Math.min(offset, source.length)) : source.length;
  const word = typeof label === "string" ? label : "";
  const start = completionStart(source, at);
  return { text: source.slice(0, start) + word + source.slice(at), caret: start + word.length };
}

/**
 * A UTF-16 offset as line and column, both zero-based.
 *
 * LSP speaks line/character, diagnostics speak offsets, and the textarea speaks
 * offsets.  This is the one conversion, so a wrong column has one place to be
 * wrong in.
 *
 * @param {string} text
 * @param {number} offset
 * @returns {{line: number, column: number}}
 */
export function positionOf(text, offset) {
  const source = typeof text === "string" ? text : "";
  const at = Number.isInteger(offset) ? Math.max(0, Math.min(offset, source.length)) : 0;
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < at; i += 1) {
    if (source.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, column: at - lineStart };
}

/**
 * The inverse of `positionOf`, clamped to the text.
 *
 * @param {string} text
 * @param {number} line
 * @param {number} column
 * @returns {number}
 */
export function offsetOfPosition(text, line, column) {
  const source = typeof text === "string" ? text : "";
  const wantLine = Number.isInteger(line) && line > 0 ? line : 0;
  const wantColumn = Number.isInteger(column) && column > 0 ? column : 0;
  let seen = 0;
  let index = 0;
  while (seen < wantLine && index < source.length) {
    if (source.charCodeAt(index) === 10) seen += 1;
    index += 1;
  }
  if (seen < wantLine) return source.length;
  let end = index;
  while (end < source.length && source.charCodeAt(end) !== 10) end += 1;
  return Math.min(index + wantColumn, end);
}

/**
 * LSP severities are numbers; this suite and the words diagnostics use names.
 *
 * @param {number|string} value
 * @returns {string}
 */
export function severityName(value) {
  if (typeof value === "string" && value !== "") return value;
  if (value === 1) return "error";
  if (value === 2) return "warning";
  if (value === 3) return "info";
  if (value === 4) return "hint";
  return "warning";
}

/**
 * One answer shape for both subsystems.
 *
 * A diagnostic is a half-open `[start, end)` offset span plus a severity, a
 * code and a message.  Spans that a buggy server put outside the buffer are
 * clamped rather than dropped: an issue in the wrong place is still an issue,
 * and swallowing it would make the editor look calm while the file is not.
 *
 * @param {string} text
 * @param {Array<object>} diagnostics
 * @param {number} [limit]
 * @returns {{diagnostics: Array<object>, total: number, truncated: boolean}}
 */
export function normaliseDiagnostics(text, diagnostics, limit = ISSUE_LIMIT) {
  const source = typeof text === "string" ? text : "";
  const list = Array.isArray(diagnostics) ? diagnostics : [];
  const out = [];

  for (const raw of list) {
    if (raw === null || typeof raw !== "object") continue;
    let start;
    let end;
    if (typeof raw.start === "number" && typeof raw.end === "number") {
      start = raw.start;
      end = raw.end;
    } else if (raw.range && raw.range.start && raw.range.end) {
      // An LSP range, either in line/character or already in offsets.
      const from = raw.range.start;
      const to = raw.range.end;
      start = typeof from.offset === "number"
        ? from.offset
        : offsetOfPosition(source, from.line, from.character);
      end = typeof to.offset === "number" ? to.offset : offsetOfPosition(source, to.line, to.character);
    } else {
      continue;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    start = Math.max(0, Math.min(Math.trunc(start), source.length));
    end = Math.max(start, Math.min(Math.trunc(end), source.length));
    const message = typeof raw.message === "string" ? raw.message : "";
    if (message === "" && typeof raw.code !== "string") continue;
    const at = positionOf(source, start);
    out.push({
      start,
      end,
      severity: severityName(raw.severity),
      code: typeof raw.code === "string" ? raw.code : null,
      message,
      line: at.line,
      column: at.column,
    });
  }

  out.sort((a, b) => (a.start !== b.start ? a.start - b.start : a.end - b.end));
  const cap = Number.isInteger(limit) && limit > 0 ? limit : ISSUE_LIMIT;
  return { diagnostics: out.slice(0, cap), total: out.length, truncated: out.length > cap };
}

/**
 * The issue that covers an offset, if any -- what a hover or a status line
 * shows when the caret is standing on a problem.
 *
 * @param {Array<object>} diagnostics  already normalised
 * @param {number} offset
 * @returns {object|null}
 */
export function diagnosticAt(diagnostics, offset) {
  if (!Array.isArray(diagnostics)) return null;
  const at = Number.isInteger(offset) ? offset : 0;
  for (const entry of diagnostics) {
    if (at >= entry.start && at <= entry.end) return entry;
  }
  return null;
}

/**
 * One line per issue, the way a strip shows them: `3:16 message`.
 *
 * @param {object} diagnostic  already normalised
 * @returns {string}
 */
export function formatDiagnostic(diagnostic) {
  if (diagnostic === null || typeof diagnostic !== "object") return "";
  const line = Number.isInteger(diagnostic.line) ? diagnostic.line + 1 : 1;
  const column = Number.isInteger(diagnostic.column) ? diagnostic.column + 1 : 1;
  return `${line}:${column} ${diagnostic.message}`;
}

/** Normalise the `words` answer, which is already in the shape we want. */
function fromWords(answer) {
  const prefix = answer !== null && typeof answer === "object" && typeof answer.prefix === "string"
    ? answer.prefix
    : "";
  const items = answer !== null && typeof answer === "object" && Array.isArray(answer.items)
    ? answer.items
    : [];
  return { prefix, items };
}

/** Normalise an `lsp` completion answer into `{prefix, items}`. */
function fromLsp(answer, prefix) {
  const items = answer !== null && typeof answer === "object" && Array.isArray(answer.items)
    ? answer.items
    : [];
  return {
    prefix: typeof prefix === "string" ? prefix : "",
    items: items.map((item) => ({
      label: typeof item.label === "string" ? item.label : "",
      kind: typeof item.kind === "string" ? item.kind : "text",
      detail: typeof item.detail === "string" ? item.detail : "",
    })),
  };
}

/**
 * The client half of `subsystem.*`.
 *
 * The host is asked what it has (`subsystem.list`), the best subsystem for a
 * question is picked, and the question is asked (`subsystem.request`).  When
 * nothing can answer, every method here resolves to `null` instead of throwing:
 * a file with no language support is not an error, it is a file.
 *
 * `call(method, params)` is the shell's own RPC call.  It is injected, so this
 * class is testable against a fake endpoint with no kernel and no browser.
 */
export class LanguageClient {
  /**
   * @param {object} options
   * @param {Function} options.call  `(method, params) => Promise<result>`
   * @param {Function} [options.log]  `(level, message) => void`
   */
  constructor({ call, log = () => {} } = {}) {
    if (typeof call !== "function") {
      throw new TypeError("LanguageClient needs a `call(method, params)` function");
    }
    this.call = call;
    this.log = typeof log === "function" ? log : () => {};
    this.catalogCache = null;
  }

  /** Forget what `subsystem.list` said, so the next question re-asks. */
  invalidate() {
    this.catalogCache = null;
  }

  /**
   * What the shell hosts, as `{subsystems: [{id, capabilities, state, ...}]}`.
   *
   * A failure is cached as an empty catalog for exactly one call: the shell may
   * be an old one that answers `METHOD_NOT_FOUND`, and asking again on every
   * keystroke would spam the log for no benefit.
   *
   * @returns {Promise<Array<object>>}
   */
  async catalog() {
    if (this.catalogCache !== null) return this.catalogCache;
    let list = [];
    try {
      const answer = await this.call("subsystem.list", {});
      list = answer !== null && typeof answer === "object" && Array.isArray(answer.subsystems)
        ? answer.subsystems
        : [];
    } catch (err) {
      this.log("warn", `no subsystem catalog: ${err && err.message ? err.message : err}`);
    }
    this.catalogCache = list;
    return list;
  }

  /**
   * Which subsystem should answer a capability.
   *
   * A running one wins, because it is already warm; then a builtin, because it
   * needs no process; then the lowest id, so the choice is stable when several
   * answer the same question.
   *
   * @param {string} capability
   * @returns {Promise<string|null>}
   */
  async preferred(capability) {
    const list = await this.catalog();
    const able = list.filter(
      (entry) => entry !== null
        && typeof entry === "object"
        && typeof entry.id === "string"
        && Array.isArray(entry.capabilities)
        && entry.capabilities.includes(capability)
        && entry.state !== "failed",
    );
    if (able.length === 0) return null;
    able.sort((a, b) => {
      const runningA = a.state === "running" ? 0 : 1;
      const runningB = b.state === "running" ? 0 : 1;
      if (runningA !== runningB) return runningA - runningB;
      const builtinA = a.kind === "builtin" ? 0 : 1;
      const builtinB = b.kind === "builtin" ? 0 : 1;
      if (builtinA !== builtinB) return builtinA - builtinB;
      return a.id.localeCompare(b.id);
    });
    return able[0].id;
  }

  /**
   * Ask one subsystem one question.
   *
   * @param {string} id
   * @param {string} method
   * @param {object} params
   * @returns {Promise<object>}
   */
  request(id, method, params) {
    return this.call("subsystem.request", { id, method, params: params === undefined ? {} : params });
  }

  /**
   * Completions at the caret, ranked.
   *
   * The preference is a language server first and `words` second: a server that
   * knows the project beats a list of identifiers, and when the server fails
   * the words list is still better than nothing.  The answer says which one it
   * came from, because a popup that silently fell back would look like the
   * server answered.
   *
   * @param {object} options
   * @param {string} options.path
   * @param {string} options.text
   * @param {number} options.offset
   * @param {string[]} [options.words]  identifiers from the other open cards
   * @param {number} [options.limit]
   * @returns {Promise<{prefix: string, items: Array<object>, total: number, truncated: boolean, source: string}|null>}
   */
  async complete({ path, text, offset, words = [], limit = COMPLETION_LIMIT } = {}) {
    const prefix = completionPrefix(text, offset);
    const wanted = ["lsp", "words"];
    const catalog = await this.catalog();
    const have = (id) => catalog.some(
      (entry) => entry !== null
        && typeof entry === "object"
        && entry.id === id
        && Array.isArray(entry.capabilities)
        && entry.capabilities.includes("completion")
        && entry.state !== "failed",
    );

    let order = wanted.filter(have);
    if (order.length === 0) {
      const only = await this.preferred("completion");
      order = only === null ? [] : [only];
    }

    let lastError = null;
    for (const id of order) {
      try {
        const answer = await this.request(id, "complete", {
          path,
          text,
          offset,
          prefix,
          words,
          limit,
        });
        const raw = id === "lsp" ? fromLsp(answer, prefix) : fromWords(answer);
        const ranked = rankCompletions(raw.items, raw.prefix !== "" ? raw.prefix : prefix, limit);
        return { ...ranked, source: id };
      } catch (err) {
        lastError = err;
        this.log("warn", `${id} could not complete: ${err && err.message ? err.message : err}`);
      }
    }
    if (lastError !== null) this.invalidate();
    return null;
  }

  /**
   * What is wrong with this text.
   *
   * Same fallback order as completions, for the same reason.  The answer is
   * always normalised: offsets in the buffer the caller passed, never LSP
   * positions, and `stale` is passed through, because a server pushes
   * diagnostics rather than pulling them: an empty answer that is `stale` means
   * "nothing said about this text *yet*", which is not the same as "nothing
   * wrong".  That answer is asked for once more, with a longer wait, before it
   * is believed.
   *
   * @param {object} options
   * @param {string} options.path
   * @param {string} options.text
   * @param {number} [options.limit]
   * @returns {Promise<{diagnostics: Array<object>, total: number, truncated: boolean, stale: boolean, source: string}|null>}
   */
  async diagnose({ path, text, limit = ISSUE_LIMIT } = {}) {
    const catalog = await this.catalog();
    const have = (id) => catalog.some(
      (entry) => entry !== null
        && typeof entry === "object"
        && entry.id === id
        && Array.isArray(entry.capabilities)
        && entry.capabilities.includes("diagnostics")
        && entry.state !== "failed",
    );

    let order = ["lsp", "words"].filter(have);
    if (order.length === 0) {
      const only = await this.preferred("diagnostics");
      order = only === null ? [] : [only];
    }

    let lastError = null;
    for (const id of order) {
      const waits = [undefined, DIAGNOSE_RETRY_WAIT];
      for (const wait of waits) {
        let answer;
        try {
          answer = await this.request(id, "diagnose", wait === undefined
            ? { path, text, limit }
            : { path, text, limit, wait });
        } catch (err) {
          lastError = err;
          this.log("warn", `${id} could not diagnose: ${err && err.message ? err.message : err}`);
          break;
        }
        const raw = answer !== null && typeof answer === "object" && Array.isArray(answer.diagnostics)
          ? answer.diagnostics
          : [];
        const stale = answer !== null && typeof answer === "object" && answer.stale === true;
        if (stale && wait === undefined) {
          continue;
        }
        return { ...normaliseDiagnostics(text, raw, limit), stale, source: id };
      }
    }
    if (lastError !== null) this.invalidate();
    return null;
  }

  /**
   * What the thing under the caret is.
   *
   * @param {object} options
   * @param {string} options.path
   * @param {string} options.text
   * @param {number} options.offset
   * @returns {Promise<{contents: string, source: string}|null>}
   */
  async hover({ path, text, offset } = {}) {
    const id = await this.preferred("hover");
    if (id === null) return null;
    try {
      const answer = await this.request(id, "hover", { path, text, offset });
      if (answer === null || typeof answer !== "object") return null;
      const contents = typeof answer.contents === "string" ? answer.contents : "";
      if (contents === "") return null;
      return { contents, source: id };
    } catch (err) {
      this.log("warn", `${id} could not hover: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  /**
   * Where the thing under the caret is defined.
   *
   * @param {object} options
   * @param {string} options.path
   * @param {string} options.text
   * @param {number} options.offset
   * @returns {Promise<{locations: Array<object>, source: string}|null>}
   */
  async definition({ path, text, offset } = {}) {
    const id = await this.preferred("definition");
    if (id === null) return null;
    try {
      const answer = await this.request(id, "definition", { path, text, offset });
      const locations = answer !== null && typeof answer === "object" && Array.isArray(answer.locations)
        ? answer.locations
        : [];
      if (locations.length === 0) return null;
      return { locations, source: id };
    } catch (err) {
      this.log("warn", `${id} could not find a definition: ${err && err.message ? err.message : err}`);
      return null;
    }
  }

  /**
   * A whole-document format, as edits.
   *
   * @param {object} options
   * @param {string} options.path
   * @param {string} options.text
   * @param {object} [options.options]
   * @returns {Promise<{edits: Array<object>, source: string}|null>}
   */
  async format({ path, text, options = {} } = {}) {
    const id = await this.preferred("format");
    if (id === null) return null;
    try {
      const answer = await this.request(id, "format", { path, text, options });
      const edits = answer !== null && typeof answer === "object" && Array.isArray(answer.edits)
        ? answer.edits
        : [];
      if (edits.length === 0) return null;
      return { edits, source: id };
    } catch (err) {
      this.log("warn", `${id} could not format: ${err && err.message ? err.message : err}`);
      return null;
    }
  }
}
