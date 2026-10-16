/*
 * lsp-stub.mjs - a scripted language server.
 *
 * It speaks the real protocol -- Content-Length framing, `initialize`, document
 * synchronisation, `publishDiagnostics`, requests and responses -- and it knows
 * nothing about any actual language.  That is the point: the subsystem layer
 * and the LSP adapter are tested against *the wire*, on every machine, with no
 * server installed, and the answers are deterministic enough to assert on.
 *
 * `lsp.sub` launches this by default so that a checkout works out of the box.
 * Point `launch` at rust-analyzer, clangd or pyright for a real one; nothing
 * else has to change.
 *
 * What it does, so the tests can predict it:
 *
 *   - `initialize` answers with hover/completion/definition/formatting
 *     providers and a `serverInfo` named `lsp-stub`.
 *   - `didOpen` / `didChange` answer with diagnostics: one warning per line
 *     containing `TODO`, one error per unbalanced `(`, and one hint per line
 *     containing `NOTE`.  The push is deliberately split into two writes so a
 *     reader that assumes one message per chunk fails the tests.
 *   - `completion` returns every identifier in the buffer that starts with the
 *     word before the cursor, plus a keyword.
 *   - `hover` describes the identifier under the cursor.
 *   - `definition` points at the first place that identifier appears.
 *   - `formatting` replaces leading tabs with two spaces (one whole-file edit).
 *   - `shutdown` answers, `exit` ends the process.
 *   - One line on stderr at startup, so the stderr path is exercised too.
 */

let buffer = Buffer.alloc(0);
let pendingLength = null;
const documents = new Map(); // uri -> text

function write(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  process.stdout.write(Buffer.concat([header, body]));
}

function respond(id, result) {
  write({ jsonrpc: "2.0", id, result });
}

function notify(method, params) {
  write({ jsonrpc: "2.0", method, params });
}

/* ------------------------------------------------------------------ */
/* framing (byte-exact, and happy to be fed half a message)            */
/* ------------------------------------------------------------------ */

function feed(chunk) {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    if (pendingLength === null) {
      const crlf = buffer.indexOf("\r\n\r\n");
      const lf = buffer.indexOf("\n\n");
      if (crlf === -1 && lf === -1) return;
      const index = crlf !== -1 && (lf === -1 || crlf < lf) ? crlf : lf;
      const width = index === crlf ? 4 : 2;
      const match = /content-length:\s*(\d+)/i.exec(buffer.slice(0, index).toString("utf8"));
      if (match === null) {
        buffer = buffer.slice(index + width);
        continue;
      }
      pendingLength = Number(match[1]);
      buffer = buffer.slice(index + width);
    }
    if (buffer.length < pendingLength) return;
    const body = buffer.slice(0, pendingLength).toString("utf8");
    buffer = buffer.slice(pendingLength);
    pendingLength = null;
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      continue;
    }
    handle(message);
  }
}

/* ------------------------------------------------------------------ */
/* the scripted answers                                                */
/* ------------------------------------------------------------------ */

function diagnosticsFor(text) {
  const lines = text.split("\n");
  const found = [];
  lines.forEach((line, index) => {
    const range = (start, end) => ({
      start: { line: index, character: start },
      end: { line: index, character: end },
    });
    const todo = line.indexOf("TODO");
    if (todo !== -1) {
      found.push({ range: range(todo, todo + 4), severity: 2, code: "todo", source: "lsp-stub", message: "a TODO is still here" });
    }
    const note = line.indexOf("NOTE");
    if (note !== -1) {
      found.push({ range: range(note, note + 4), severity: 4, code: "note", source: "lsp-stub", message: "a note, not a problem" });
    }
    const open = (line.match(/\(/g) ?? []).length;
    const close = (line.match(/\)/g) ?? []).length;
    if (open > close) {
      found.push({ range: range(line.length, line.length), severity: 1, code: "unbalanced", source: "lsp-stub", message: "an open parenthesis is never closed" });
    }
  });
  return found;
}

function publish(uri) {
  const text = documents.get(uri) ?? "";
  const diagnostics = diagnosticsFor(text);
  const message = { jsonrpc: "2.0", method: "textDocument/publishDiagnostics", params: { uri, diagnostics } };
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii");
  const framed = Buffer.concat([header, body]);
  // Two writes with nothing in between: still one frame on the wire, but the
  // reader has to cope with it arriving in two pieces.  Splitting it across a
  // timer instead would let another message interleave, which is not a stream
  // this protocol allows.
  const cut = Math.max(1, Math.floor(framed.length / 2));
  process.stdout.write(framed.slice(0, cut));
  process.stdout.write(framed.slice(cut));
}

function offsetOf(text, position) {
  const lines = text.split("\n");
  let offset = 0;
  for (let i = 0; i < Math.min(position.line, lines.length); i += 1) {
    offset += lines[i].length + 1;
  }
  return Math.min(offset + position.character, text.length);
}

function wordAt(text, offset) {
  const before = /[A-Za-z_][A-Za-z0-9_]*$/.exec(text.slice(0, offset));
  const after = /^[A-Za-z0-9_]*/.exec(text.slice(offset));
  const prefix = before === null ? "" : before[0];
  const suffix = after === null ? "" : after[0];
  if (prefix === "" && suffix === "") return null;
  return { word: prefix + suffix, start: offset - prefix.length, end: offset + suffix.length };
}

function identifiers(text) {
  return [...new Set(text.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])];
}

function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    respond(id, {
      capabilities: {
        textDocumentSync: 1,
        completionProvider: { triggerCharacters: [] },
        hoverProvider: true,
        definitionProvider: true,
        documentFormattingProvider: true,
      },
      serverInfo: { name: "lsp-stub", version: "1.0.0" },
    });
    return;
  }

  if (method === "initialized" || method === "exit") {
    if (method === "exit") process.exit(0);
    return;
  }

  if (method === "shutdown") {
    respond(id, null);
    return;
  }

  if (method === "textDocument/didOpen") {
    documents.set(params.textDocument.uri, params.textDocument.text);
    publish(params.textDocument.uri);
    return;
  }

  if (method === "textDocument/didChange") {
    const uri = params.textDocument.uri;
    documents.set(uri, params.contentChanges[0]?.text ?? "");
    publish(uri);
    return;
  }

  if (method === "textDocument/didClose") {
    documents.delete(params.textDocument.uri);
    return;
  }

  if (method === "textDocument/completion") {
    const text = documents.get(params.textDocument.uri) ?? "";
    const offset = offsetOf(text, params.position);
    const word = wordAt(text, offset);
    const prefix = word === null ? "" : word.word;
    const items = identifiers(text)
      .filter((name) => name !== prefix && name.startsWith(prefix))
      .map((name) => ({ label: name, kind: 3, detail: "from this buffer" }));
    items.push({ label: "TODO", kind: 14, detail: "a keyword the stub always offers" });
    respond(id, { isIncomplete: false, items });
    return;
  }

  if (method === "textDocument/hover") {
    const text = documents.get(params.textDocument.uri) ?? "";
    const offset = offsetOf(text, params.position);
    const word = wordAt(text, offset);
    if (word === null) {
      respond(id, null);
      return;
    }
    respond(id, {
      contents: { kind: "markdown", value: `**${word.word}**\n\nstub hover from \`lsp-stub\`` },
      range: { start: { line: params.position.line, character: word.start - lineStart(text, offset) }, end: { line: params.position.line, character: word.end - lineStart(text, offset) } },
    });
    return;
  }

  if (method === "textDocument/definition") {
    const text = documents.get(params.textDocument.uri) ?? "";
    const offset = offsetOf(text, params.position);
    const word = wordAt(text, offset);
    if (word === null) {
      respond(id, null);
      return;
    }
    const at = text.indexOf(word.word);
    const before = text.slice(0, at).split("\n");
    respond(id, {
      uri: params.textDocument.uri,
      range: {
        start: { line: before.length - 1, character: before[before.length - 1].length },
        end: { line: before.length - 1, character: before[before.length - 1].length + word.word.length },
      },
    });
    return;
  }

  if (method === "textDocument/formatting") {
    const text = documents.get(params.textDocument.uri) ?? "";
    const formatted = text.replace(/^\t+/gm, (tabs) => " ".repeat(tabs.length * 2));
    if (formatted === text) {
      respond(id, []);
      return;
    }
    const lineCount = text.split("\n").length;
    respond(id, [{
      range: { start: { line: 0, character: 0 }, end: { line: lineCount, character: 0 } },
      newText: formatted,
    }]);
    return;
  }

  if (id !== undefined) {
    write({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `lsp-stub does not implement ${method}` },
    });
  }
}

function lineStart(text, offset) {
  const nl = text.lastIndexOf("\n", Math.max(0, offset - 1));
  return nl + 1;
}

process.stderr.write("lsp-stub: ready\n");
process.stdin.on("data", (chunk) => feed(chunk));
process.stdin.on("end", () => process.exit(0));
