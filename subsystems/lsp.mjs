/*
 * lsp.mjs - a language server as a subsystem.
 *
 * The shell already colours text on its own (`langs/`).  This file is the
 * other half of language intelligence: it speaks the Language Server Protocol
 * to a real server over the duplex child-process channel the kernel provides,
 * and turns the answers into the small shapes a client can draw.
 *
 * Nothing here decides *which* server runs.  The descriptor's `launch` line
 * does, so pointing this at clangd instead of rust-analyzer is one line in
 * `lsp.sub` -- the wire code does not know what a Rust file is.
 *
 * What this file owns:
 *
 *   - `Content-Length` framing, byte-exact, because a chunk boundary can fall
 *     inside a header, inside a body, or in the middle of a UTF-8 character.
 *   - request/response correlation: the server answers out of order and this
 *     is the only place that knows which question each answer belongs to.
 *   - the `initialize` / `initialized` handshake, and the two requests a
 *     server sends *to* the client (`workspace/configuration`,
 *     `client/registerCapability`), which must be answered or the server waits
 *     forever.
 *   - document synchronisation: full-text `didOpen`/`didChange`, driven by the
 *     text the client sends with each request.  The client is the source of
 *     truth for a buffer; this adapter is not a second one.
 *   - `textDocument/publishDiagnostics`, which is a notification, not an
 *     answer: it is cached per URI and handed out by the `diagnose` method.
 *
 * Requests it answers.  The names are the ones a client asks *any* subsystem
 * for a capability by (`words` answers the same two), not the names LSP uses on
 * the wire -- the protocol names live only in the calls to the server below:
 *
 *   status {}                                  -> {server, capabilities, open, diagnostics}
 *   complete {path, text, offset}              -> {items, total}
 *   hover {path, text, offset}                 -> {contents, range}
 *   definition {path, text, offset}            -> {locations}
 *   diagnose {path, text, wait}                -> {diagnostics, stale, version}
 *   format {path, text, options}               -> {edits, total}
 *
 * `text` is the whole buffer, `offset` a UTF-16 index into it, and `path` is
 * relative to the workspace root the host was given (`context.root`).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

/** Server capability key -> the subsystem method it enables. */
const CAPABILITY_FOR_METHOD = {
  complete: "completionProvider",
  hover: "hoverProvider",
  definition: "definitionProvider",
  format: "documentFormattingProvider",
};

const LANGUAGE_BY_EXT = {
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".rs": "rust",
  ".py": "python",
  ".ts": "typescript",
  ".tsx": "typescriptreact",
  ".js": "javascript",
  ".mjs": "javascript",
  ".json": "json",
  ".md": "markdown",
  ".css": "css",
  ".html": "html",
  ".xml": "xml",
  ".sh": "shellscript",
};

/** LSP CompletionItemKind numbers -> the words the client shows. */
const COMPLETION_KINDS = [
  "text", "method", "function", "constructor", "field", "variable", "class",
  "interface", "module", "property", "unit", "value", "enum", "keyword",
  "snippet", "color", "file", "reference", "folder", "enum-member",
  "constant", "struct", "event", "operator", "type-parameter",
];

const SEVERITY_BY_NUMBER = { 1: "error", 2: "warning", 3: "info", 4: "hint" };

/** A `fail`-shaped error: the host reads `code` and `rpcName` off it. */
function fail(message, rpcName = "SUBSYSTEM_FAILED", code = -32012) {
  const err = new Error(message);
  err.code = code;
  err.rpcName = rpcName;
  return err;
}

function methodNotFound(method) {
  return fail(`lsp does not answer \`${method}\``, "METHOD_NOT_FOUND", -32601);
}

function unsupported(message) {
  return fail(message, "SUBSYSTEM_UNSUPPORTED", -32014);
}

/** `offset` (UTF-16 index) -> an LSP position. */
export function positionAt(text, offset) {
  const stop = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lineStart = 0;
  for (let i = 0; i < stop; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lineStart = i + 1;
    }
  }
  return { line, character: stop - lineStart };
}

/** An LSP position -> `offset`, clamped to the line it names. */
export function offsetAt(text, position) {
  const line = Math.max(0, Number(position?.line) || 0);
  let start = 0;
  for (let n = 0; n < line; n += 1) {
    const nl = text.indexOf("\n", start);
    if (nl === -1) return text.length;
    start = nl + 1;
  }
  const nl = text.indexOf("\n", start);
  const lineEnd = nl === -1 ? text.length : nl;
  return Math.min(start + Math.max(0, Number(position?.character) || 0), lineEnd);
}

/** A workspace-relative path -> the `file://` URI a server expects. */
export function fileUri(root, relPath) {
  const absolute = path.resolve(root ?? process.cwd(), relPath);
  let slashed = absolute.replace(/\\/g, "/");
  if (!slashed.startsWith("/")) slashed = `/${slashed}`;
  return `file://${encodeURI(slashed)}`;
}

/** The inverse of `fileUri`, so a location can be named the way clients do. */
export function pathFromUri(uri, root) {
  if (typeof uri !== "string" || !uri.startsWith("file://")) return uri ?? null;
  let decoded = decodeURI(uri.slice("file://".length));
  if (/^\/[A-Za-z]:/.test(decoded)) decoded = decoded.slice(1);
  const absolute = path.normalize(decoded);
  if (typeof root === "string" && root !== "") {
    const rel = path.relative(root, absolute);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      return rel.replace(/\\/g, "/");
    }
  }
  return absolute.replace(/\\/g, "/");
}

/**
 * Splits a stream of bytes into LSP messages.
 *
 * The only state is the leftover: a chunk can end anywhere, including between
 * the CR and the LF of a header, or in the middle of a body whose length the
 * header already promised.  `push` returns the messages that are complete.
 */
class MessageReader {
  #buffer = Buffer.alloc(0);
  #length = null;

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const messages = [];
    for (;;) {
      if (this.#length === null) {
        const end = this.#headerEnd();
        if (end === null) break;
        const header = this.#buffer.slice(0, end.index).toString("utf8");
        const match = /content-length:\s*(\d+)/i.exec(header);
        if (match === null) {
          // Unparseable header: drop up to the separator and try again, so one
          // bad frame cannot wedge the stream forever.
          this.#buffer = this.#buffer.slice(end.index + end.width);
          continue;
        }
        this.#length = Number(match[1]);
        this.#buffer = this.#buffer.slice(end.index + end.width);
      }
      if (this.#buffer.length < this.#length) break;
      const body = this.#buffer.slice(0, this.#length).toString("utf8");
      this.#buffer = this.#buffer.slice(this.#length);
      this.#length = null;
      try {
        messages.push(JSON.parse(body));
      } catch {
        // A body that is not JSON is the server's problem, not a reason to
        // stop reading: the next header starts a new message.
      }
    }
    return messages;
  }

  /** The end of the header block, and how wide `\r\n\r\n` is here. */
  #headerEnd() {
    const crlf = this.#buffer.indexOf("\r\n\r\n");
    const lf = this.#buffer.indexOf("\n\n");
    if (crlf === -1 && lf === -1) return null;
    if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, width: 4 };
    return { index: lf, width: 2 };
  }
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  return Buffer.concat([
    Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"),
    body,
  ]);
}

class LspAdapter {
  #context;
  #channel = null;
  #reader = new MessageReader();
  #nextId = 1;
  #pending = new Map();
  #open = new Map();          // uri -> {version, text}
  #diagnostics = new Map();   // uri -> {version, diagnostics, received}
  #waits = [];                // {uri, after, resolve}
  #capabilities = null;
  #serverInfo = null;
  #stderr = [];
  #exited = null;

  constructor(context) {
    this.#context = context;
  }

  /* ---------------------------------------------------------------- */
  /* lifecycle                                                        */
  /* ---------------------------------------------------------------- */

  async start() {
    const descriptor = this.#context.descriptor;
    if (typeof descriptor.launch !== "string" || descriptor.launch === "") {
      throw fail("`lsp.sub` has no `launch` line, so there is no server to run");
    }
    // `{here}` is the directory this module lives in, so a descriptor can ship
    // its own script (`launch node "{here}/lsp-stub.mjs"`) and still work from
    // any workspace, while a plain server name (`launch clangd`) is passed
    // through untouched.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const command = descriptor.launch.split("{here}").join(here);
    const root = this.#context.root;

    this.#channel = this.#context.spawn({
      command,
      cwd: root ?? process.cwd(),
    });
    this.#channel.onOutput((data, stream) => this.#onData(data, stream));
    this.#channel.onExit((code) => this.#onExit(code));

    const result = await this.#send("initialize", {
      processId: process.pid,
      clientInfo: { name: "seIDE" },
      rootUri: root === null ? null : fileUri(root, "."),
      workspaceFolders: root === null ? null : [{ uri: fileUri(root, "."), name: path.basename(root) }],
      capabilities: {
        workspace: { configuration: true, workspaceFolders: true },
        textDocument: {
          synchronization: { dynamicRegistration: false },
          completion: { completionItem: { snippetSupport: false, documentationFormat: ["markdown", "plaintext"] } },
          hover: { contentFormat: ["markdown", "plaintext"] },
          definition: { linkSupport: true },
          formatting: { dynamicRegistration: false },
          publishDiagnostics: { relatedInformation: true },
        },
        window: { workDoneProgress: false },
      },
    }, 20000);

    this.#capabilities = result?.capabilities ?? {};
    this.#serverInfo = result?.serverInfo ?? null;
    const name = this.#serverInfo?.name ?? command.split(/\s+/)[0];
    this.#context.log(`lsp: ${name} ready${this.#serverInfo?.version ? ` (${this.#serverInfo.version})` : ""}`);
    this.#context.emit({ event: "subsystem.log", message: `lsp: ${name} ready` });
    await this.#notify("initialized", {});
  }

  async stop() {
    const channel = this.#channel;
    this.#channel = null;
    if (channel === null) return;
    try {
      await this.#send("shutdown", null, 1500);
      await this.#notify("exit", null);
    } catch {
      // A server that will not shut down politely is killed below.
    }
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(fail("the language server was stopped", "SUBSYSTEM_FAILED"));
    }
    this.#pending.clear();
    this.#open.clear();
    channel.kill();
  }

  /* ---------------------------------------------------------------- */
  /* requests                                                         */
  /* ---------------------------------------------------------------- */

  async request(method, params = {}) {
    switch (method) {
      case "status":
        return this.#status();
      case "complete":
        return this.#completion(params);
      case "hover":
        return this.#hover(params);
      case "definition":
        return this.#definition(params);
      case "diagnose":
        return this.#diagnosticsFor(params);
      case "format":
        return this.#format(params);
      default:
        throw methodNotFound(method);
    }
  }

  #require(method) {
    if (this.#channel === null) {
      throw fail("the language server is not running", "SUBSYSTEM_FAILED");
    }
    const key = CAPABILITY_FOR_METHOD[method];
    if (key !== undefined && this.#capabilities !== null && !this.#capabilities[key]) {
      const name = this.#serverInfo?.name ?? "this server";
      throw unsupported(`${name} does not advertise \`${key}\`, so \`${method}\` is not available`);
    }
  }

  #status() {
    const openUris = [...this.#open.keys()];
    let diagnosticCount = 0;
    for (const entry of this.#diagnostics.values()) diagnosticCount += entry.diagnostics.length;
    return {
      server: {
        command: this.#context.descriptor.launch ?? null,
        name: this.#serverInfo?.name ?? null,
        version: this.#serverInfo?.version ?? null,
        running: this.#channel !== null && this.#exited === null,
        exit: this.#exited,
      },
      capabilities: this.#capabilities === null ? null : Object.keys(CAPABILITY_FOR_METHOD)
        .filter((name) => Boolean(this.#capabilities[CAPABILITY_FOR_METHOD[name]])),
      open: openUris.map((uri) => pathFromUri(uri, this.#context.root)),
      diagnostics: diagnosticCount,
      stderr: this.#stderr.slice(-5),
    };
  }

  /**
   * Sends the buffer the client holds, then asks.  Every request carries the
   * text, so the server can never work from a stale version: this adapter
   * compares and sends only when the text actually changed.
   */
  async #withDocument(params) {
    const { path: relPath, text } = params;
    if (typeof relPath !== "string" || relPath === "") {
      throw fail("`path` must be a non-empty string", "SUBSYSTEM_FAILED");
    }
    if (typeof text !== "string") {
      throw fail("`text` must be a string", "SUBSYSTEM_FAILED");
    }
    const uri = fileUri(this.#context.root, relPath);
    const known = this.#open.get(uri);
    if (known === undefined) {
      this.#open.set(uri, { version: 1, text });
      await this.#notify("textDocument/didOpen", {
        textDocument: { uri, languageId: this.#languageOf(relPath), version: 1, text },
      });
    } else if (known.text !== text) {
      known.version += 1;
      known.text = text;
      known.dirty = true;
      await this.#notify("textDocument/didChange", {
        textDocument: { uri, version: known.version },
        contentChanges: [{ text }],
      });
    }
    return { uri, version: this.#open.get(uri).version };
  }

  #languageOf(relPath) {
    return LANGUAGE_BY_EXT[path.extname(relPath).toLowerCase()] ?? "plaintext";
  }

  async #completion(params) {
    this.#require("complete");
    const { uri } = await this.#withDocument(params);
    const result = await this.#send("textDocument/completion", {
      textDocument: { uri },
      position: positionAt(params.text, params.offset ?? params.text.length),
      context: params.trigger === undefined ? undefined : { triggerKind: 1, triggerCharacter: params.trigger },
    });
    const list = Array.isArray(result) ? result : (result?.items ?? []);
    const items = list.slice(0, Math.max(1, Math.min(params.limit ?? 100, 500))).map((item) => ({
      label: item.label,
      kind: COMPLETION_KINDS[item.kind - 1] ?? "text",
      detail: item.detail ?? (item.labelDetails?.detail ?? null),
      documentation: documentationOf(item.documentation),
      insert: item.insertText ?? item.textEdit?.newText ?? item.label,
    }));
    return { items, total: list.length, isIncomplete: Boolean(result?.isIncomplete) };
  }

  async #hover(params) {
    this.#require("hover");
    const { uri } = await this.#withDocument(params);
    const result = await this.#send("textDocument/hover", {
      textDocument: { uri },
      position: positionAt(params.text, params.offset ?? 0),
    });
    if (result === null || result === undefined) return { contents: null, range: null };
    return { contents: documentationOf(result.contents), range: rangeOf(result.range) };
  }

  async #definition(params) {
    this.#require("definition");
    const { uri } = await this.#withDocument(params);
    const result = await this.#send("textDocument/definition", {
      textDocument: { uri },
      position: positionAt(params.text, params.offset ?? 0),
    });
    return { locations: locationsOf(result, this.#context.root) };
  }

  async #format(params) {
    this.#require("format");
    const { uri } = await this.#withDocument(params);
    const options = params.options ?? { tabSize: 2, insertSpaces: true };
    const result = await this.#send("textDocument/formatting", {
      textDocument: { uri },
      options,
    });
    const edits = (Array.isArray(result) ? result : []).map((edit) => ({
      start: offsetAt(params.text, edit.range.start),
      end: offsetAt(params.text, edit.range.end),
      text: edit.newText,
    }));
    return { edits, total: edits.length };
  }

  /**
   * Diagnostics are pushed, not pulled.  The answer is therefore "whatever the
   * server has said about this buffer", with an honest `stale` flag when the
   * wait expired before the server said anything about the version we sent.
   */
  async #diagnosticsFor(params) {
    const known = typeof params.path === "string" ? this.#open.get(fileUri(this.#context.root, params.path)) : null;
    const before = known?.version ?? 0;
    let version = before;
    if (typeof params.text === "string") {
      ({ version } = await this.#withDocument(params));
    }
    const uri = fileUri(this.#context.root, params.path ?? "");
    const wait = Math.max(0, Math.min(params.wait ?? 700, 5000));
    const entry = await this.#waitForDiagnostics(uri, version, wait);
    if (entry === null) return { diagnostics: [], stale: true, version };
    return { diagnostics: entry.diagnostics, stale: entry.version < version, version };
  }

  #waitForDiagnostics(uri, version, ms) {
    const cached = this.#diagnostics.get(uri);
    if (cached !== undefined && cached.version >= version) return Promise.resolve(cached);
    if (ms <= 0) return Promise.resolve(cached ?? null);
    return new Promise((resolve) => {
      const waiter = { uri, version, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        this.#waits = this.#waits.filter((entry) => entry !== waiter);
        resolve(this.#diagnostics.get(uri) ?? null);
      }, ms);
      this.#waits.push(waiter);
    });
  }

  /* ---------------------------------------------------------------- */
  /* the wire                                                         */
  /* ---------------------------------------------------------------- */

  #onData(data, stream) {
    if (stream === "stderr") {
      // Server chatter is not protocol.  Keep the tail for `status`, because
      // "why did it die" is almost always answered on stderr.
      this.#stderr.push(data);
      if (this.#stderr.length > 20) this.#stderr.shift();
      return;
    }
    for (const message of this.#reader.push(data)) this.#onMessage(message);
  }

  #onMessage(message) {
    if (message === null || typeof message !== "object") return;

    if (message.method === "textDocument/publishDiagnostics") {
      const params = message.params ?? {};
      const entry = {
        version: this.#open.get(params.uri)?.version ?? params.version ?? 0,
        diagnostics: (params.diagnostics ?? []).map((item) => ({
          start: offsetAt(this.#open.get(params.uri)?.text ?? "", item.range?.start ?? { line: 0, character: 0 }),
          end: offsetAt(this.#open.get(params.uri)?.text ?? "", item.range?.end ?? { line: 0, character: 0 }),
          range: rangeOf(item.range),
          severity: SEVERITY_BY_NUMBER[item.severity] ?? "info",
          code: item.code ?? null,
          source: item.source ?? null,
          message: item.message ?? "",
        })),
        received: Date.now(),
      };
      this.#diagnostics.set(params.uri, entry);
      this.#context.emit({
        event: "subsystem.diagnostics",
        path: pathFromUri(params.uri, this.#context.root),
        diagnostics: entry.diagnostics,
      });
      for (const waiter of [...this.#waits]) {
        if (waiter.uri !== params.uri || entry.version < waiter.version) continue;
        clearTimeout(waiter.timer);
        this.#waits = this.#waits.filter((item) => item !== waiter);
        waiter.resolve(entry);
      }
      return;
    }

    // A request *from* the server.  `workspace/configuration` wants one entry
    // per asked-for item and the rest want a result; an unanswered request
    // blocks the server, so answer everything.
    if (message.id !== undefined && typeof message.method === "string") {
      const result = message.method === "workspace/configuration"
        ? (message.params?.items ?? []).map(() => null)
        : null;
      this.#write({ jsonrpc: "2.0", id: message.id, result });
      return;
    }

    if (message.id === undefined) return; // a notification we do not handle
    const entry = this.#pending.get(message.id);
    if (entry === undefined) return;
    this.#pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error !== undefined && message.error !== null) {
      entry.reject(fail(
        `${entry.method} failed: ${message.error.message ?? "the server refused it"}`,
        "SUBSYSTEM_FAILED",
      ));
      return;
    }
    entry.resolve(message.result ?? null);
  }

  #onExit(code) {
    this.#exited = code ?? null;
    const tail = this.#stderr.slice(-3).join("");
    const reason = tail.trim() === "" ? "" : ` (stderr: ${tail.trim().split("\n").slice(-1)[0]})`;
    for (const [, entry] of this.#pending) {
      clearTimeout(entry.timer);
      entry.reject(fail(`the language server exited (code ${code})${reason}`, "SUBSYSTEM_FAILED"));
    }
    this.#pending.clear();
    for (const waiter of [...this.#waits]) {
      clearTimeout(waiter.timer);
      waiter.resolve(null);
    }
    this.#waits = [];
    this.#channel = null;
  }

  #write(message) {
    if (this.#channel === null) {
      throw fail("the language server is not running", "SUBSYSTEM_FAILED");
    }
    this.#channel.write(frame(message));
  }

  #send(method, params, timeoutMs = 8000) {
    const id = this.#nextId;
    this.#nextId += 1;
    let timer = null;
    const promise = new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(fail(`the language server did not answer \`${method}\` within ${timeoutMs} ms`, "SUBSYSTEM_FAILED"));
      }, timeoutMs);
      this.#pending.set(id, { method, resolve, reject, timer });
    });
    try {
      this.#write({ jsonrpc: "2.0", id, method, params });
    } catch (err) {
      clearTimeout(timer);
      this.#pending.delete(id);
      return Promise.reject(err);
    }
    return promise;
  }

  #notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
    return Promise.resolve();
  }
}

/** LSP markup (string, MarkedString, MarkupContent, or an array) -> text. */
function documentationOf(contents) {
  if (contents === null || contents === undefined) return null;
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) {
    const parts = contents.map((item) => documentationOf(item)).filter((item) => item !== null);
    return parts.length === 0 ? null : parts.join("\n\n");
  }
  if (typeof contents === "object") {
    if (typeof contents.value === "string") return contents.value;
    if (typeof contents.language === "string") return `\`\`\`${contents.language}\n${contents.value ?? ""}\n\`\`\``;
  }
  return null;
}

function rangeOf(range) {
  if (range === null || range === undefined) return null;
  return {
    start: { line: range.start?.line ?? 0, character: range.start?.character ?? 0 },
    end: { line: range.end?.line ?? 0, character: range.end?.character ?? 0 },
  };
}

/** Location | Location[] | LocationLink[] -> paths a client can open. */
function locationsOf(result, root) {
  if (result === null || result === undefined) return [];
  const list = Array.isArray(result) ? result : [result];
  const locations = [];
  for (const item of list) {
    const uri = item.uri ?? item.targetUri;
    if (typeof uri !== "string") continue;
    const range = rangeOf(item.range ?? item.targetSelectionRange ?? item.targetRange);
    locations.push({
      path: pathFromUri(uri, root),
      line: (range?.start.line ?? 0) + 1,
      column: (range?.start.character ?? 0) + 1,
      range,
    });
  }
  return locations;
}

/** The module contract: `create(context)` -> adapter. */
export async function create(context) {
  return new LspAdapter(context);
}

export { LspAdapter };
