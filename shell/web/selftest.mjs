/**
 * selftest.mjs -- the shell's proof, runnable with no browser and no kernel.
 *
 *     node shell/web/selftest.mjs
 *
 * It imports the pure parts of the web shell and drives them with a fake
 * `fetch` (an in-memory SSE stream) and no DOM at all, so the protocol
 * plumbing, the board model, the undo ring and the token-span logic are checked
 * exactly as the browser will use them.
 *
 * What that means: there is no browser here. Canvas layout, pointer gestures
 * (drag, resize, drawing a link), focus, keyboard handling and every CSS rule
 * are never exercised. One check calls `renderCard` against a stub element that
 * records structure and nothing else, purely to prove that a malformed board
 * entry produces a placeholder instead of an exception. The `note:` line at the
 * end of every run says the same thing, so a green run is never read as "the
 * browser was tested".
 *
 * Exit code is 0 only when every check passes; the summary is `ok N/N`.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";

import {
  createClient,
  isStaleRevision,
  SseParser,
  RpcError,
  staleCurrentRevision,
} from "./rpc.mjs";

import {
  CARD_KINDS,
  DEFAULT_SIZE,
  MIN_SIZE,
  ZOOM_MAX,
  ZOOM_MIN,
  cardsInsideRect,
  cardsWithin,
  clampViewport,
  createBoard,
  frameRect,
  normaliseDocument,
} from "./board.mjs";

import {
  CARD_KIND_CONTRACT,
  INDENT_UNIT,
  OutputBuffer,
  SHEET_TYPES,
  addSheetColumn,
  addSheetRow,
  applyTokenSpans,
  cardKind,
  coerceSheetValue,
  describeCard,
  dirNameOf,
  emptySheet,
  findMatches,
  formatAge,
  formatExit,
  formatListing,
  formatSize,
  indentAfterEnter,
  indentSelection,
  knownCardKinds,
  lineColumn,
  markHits,
  matchesFilter,
  nextSheetSelection,
  normaliseSheet,
  normaliseTokenKind,
  parseCommandLine,
  parseZoomArgument,
  projectRows,
  projectSummary,
  registerCardKind,
  removeSheetColumn,
  removeSheetRow,
  renderCard,
  replaceAllMatches,
  replaceMatchAt,
  SEARCH_MAX_HITS,
  SEARCH_MAX_PER_FILE,
  searchExcerpt,
  searchFiles,
  searchInText,
  segmentsText,
  setSheetCell,
  sheetCell,
  sheetSummary,
  sheetToTSV,
  unknownCardPlaceholder,
} from "./cards.mjs";

/*
 * `main.mjs` is importable under Node on purpose (it only builds the app when
 * there is a `document`), which is what lets the two DOM-free helpers behind
 * the listener-leak and save-reporting fixes be checked here for real instead
 * of through a browser.
 */
import { saveOutcomeMessage, scrollRoom, wireChoiceStrip } from "./main.mjs";

import { createHistory, describeChange } from "./history.mjs";

import {
  CLASSIC_SIDEBAR_KINDS,
  CLASSIC_TAB_H,
  CLASSIC_VIEWS,
  classicHud,
  classicLayout,
  classicRoles,
  classicTabLabel,
  classicViewName,
} from "./classic.mjs";

import {
  WATCH_GONE,
  WATCH_OK,
  WATCH_RELOAD,
  WATCH_UNKNOWN,
  WATCH_WARN,
  watchDecision,
  watchReport,
  watchTrimmed,
} from "./watch.mjs";

import {
  COMPLETION_LIMIT,
  LanguageClient,
  completionPrefix,
  completionStart,
  diagnosticAt,
  formatDiagnostic,
  insertCompletion,
  normaliseDiagnostics,
  offsetOfPosition,
  positionOf,
  rankCompletions,
  severityName,
} from "./language.mjs";

/* ------------------------------------------------------------------ */
/* the smallest useful test harness                                    */
/* ------------------------------------------------------------------ */

const failures = [];
let checks = 0;
/**
 * An async test body runs on after the line that called it, so the report at
 * the bottom of this file must wait for every one of them. It used to not: the
 * summary printed while the bodies were still suspended, which meant a failure
 * in an async test was never printed and never set the exit code. A green
 * `ok N/N` is only worth what the report behind it is worth.
 */
const pending = [];

function test(name, fn) {
  checks += 1;
  try {
    fn();
  } catch (err) {
    failures.push({ name, err });
  }
}

function testAsync(name, fn) {
  checks += 1;
  pending.push((async () => {
    try {
      await fn();
    } catch (err) {
      failures.push({ name, err });
    }
  })());
}

/* ------------------------------------------------------------------ */
/* a fake /rpc and a fake SSE stream                                   */
/* ------------------------------------------------------------------ */

/** An SSE body whose chunks can be cut anywhere we like. */
function sseStream(chunks, { holdOpen = false } = {}) {
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index];
        index += 1;
        controller.enqueue(typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk);
        return;
      }
      if (!holdOpen) {
        controller.close();
      }
    },
  });
}

/**
 * @param {object} options
 * @param {Array<object|Function>} options.replies  one per POST, in order
 * @param {string[]} [options.chunks]  raw SSE chunks
 */
/**
 * The mock host answers in JSON-RPC, because that is the only shape the real
 * host uses: the request's id comes back with either a `result` or an `error`.
 * Testing against any other shape would prove nothing about the real endpoint.
 */
function toJsonRpc(value, record) {
  const id = record && record.body && record.body.id !== undefined ? record.body.id : null;
  if (value === undefined) {
    return { jsonrpc: "2.0", id, result: {} };
  }
  if (value.ok === true) {
    return { jsonrpc: "2.0", id, result: value.result };
  }
  if (value.error !== undefined) {
    return { jsonrpc: "2.0", id, error: value.error };
  }
  return { jsonrpc: "2.0", id, result: value.result === undefined ? value : value.result };
}

function fakeFetch({ replies = [], chunks = [], holdOpen = false, onCall = null }) {
  const calls = [];
  let replyIndex = 0;
  const impl = async (url, init) => {
    const record = { url, init, body: init && init.body ? JSON.parse(init.body) : null };
    calls.push(record);
    if (onCall !== null) {
      onCall(record);
    }
    if (url.endsWith("/events")) {
      return { ok: true, status: 200, body: sseStream(chunks, { holdOpen }) };
    }
    const reply = replies[replyIndex];
    replyIndex += 1;
    const value = typeof reply === "function" ? reply(record) : reply;
    if (value instanceof Error) {
      throw value;
    }
    if (value && value.httpError === true) {
      return { ok: false, status: value.status || 500, text: async () => "" };
    }
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(toJsonRpc(value, record)),
    };
  };
  impl.calls = calls;
  return impl;
}

/** Let every already-resolved promise chain run to completion. */
const tick = (n = 6) => new Promise((resolve) => {
  let left = n;
  const step = () => {
    left -= 1;
    if (left <= 0) {
      resolve();
    } else {
      setTimeout(step, 0);
    }
  };
  setTimeout(step, 0);
});

/* ------------------------------------------------------------------ */
/* stub elements, for the checks that have to touch the DOM layer       */
/* ------------------------------------------------------------------ */

/**
 * Record structure, and nothing else.
 *
 * The suite has no browser, and the interesting half of `renderCard` is not
 * layout: it is the decision to fall back to a placeholder instead of throwing
 * on an entry that is not a card. That decision builds real elements through
 * `document.createElement`, so the smallest possible element stub is installed
 * for the duration of one check. It has no layout, no focus and no real events
 * -- which is exactly what the closing `note:` line says is not covered.
 */
function stubDom() {
  class StubElement {
    constructor(tag) {
      this.tagName = tag;
      this.children = [];
      this.attrs = {};
      this.className = "";
      this.textContent = "";
      this.classList = {
        add: (name) => {
          this.className = `${this.className} ${name}`.trim();
        },
      };
    }

    setAttribute(key, value) {
      this.attrs[key] = String(value);
    }

    append(child) {
      this.children.push(child);
      return child;
    }

    remove() {
      this.removed = true;
    }

    addEventListener() {}
  }

  const previous = Object.prototype.hasOwnProperty.call(globalThis, "document")
    ? globalThis.document
    : undefined;
  globalThis.document = {
    createElement: (tag) => new StubElement(tag),
    createTextNode: (text) => ({ textContent: String(text), children: [] }),
    createDocumentFragment: () => new StubElement("#fragment"),
  };

  return {
    /** Flatten every text node under a stub element. */
    text(el) {
      if (el === null || el === undefined) {
        return "";
      }
      const own = typeof el.textContent === "string" ? el.textContent : "";
      const kids = Array.isArray(el.children) ? el.children.map((child) => this.text(child)).join("") : "";
      return own + kids;
    },
    restore() {
      if (previous === undefined) {
        delete globalThis.document;
      } else {
        globalThis.document = previous;
      }
    },
  };
}

/** A listener-recording stand-in for a DOM element. */
function stubEventTarget() {
  const listeners = new Map();
  return {
    list(type) {
      return listeners.get(type) || [];
    },
    count(type) {
      return this.list(type).length;
    },
    addEventListener(type, fn) {
      const list = listeners.get(type) || [];
      list.push(fn);
      listeners.set(type, list);
    },
    removeEventListener(type, fn) {
      const list = listeners.get(type) || [];
      listeners.set(type, list.filter((entry) => entry !== fn));
    },
    fire(type) {
      for (const fn of [...this.list(type)]) {
        fn({ type });
      }
    },
  };
}

/* ------------------------------------------------------------------ */
/* rpc.mjs                                                             */
/* ------------------------------------------------------------------ */

await testAsync("sse: a frame split across chunk boundaries is reassembled", async () => {
  const fetchImpl = fakeFetch({
    chunks: [
      "data: {\"event\":\"log\",\"level\":\"inf",
      "o\",\"message\":\"one\"}\n",
      "\ndata: {\"event\":\"log\",\"level\":\"warn\",\"message\":\"two\"}\n\n",
    ],
  });
  const client = createClient({ origin: "http://127.0.0.1:1", fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["one", "two"]);
  assert.equal(client.connected, false, "a closed stream must report disconnected");
});

await testAsync("sse: three frames arriving in one chunk all dispatch, in order", async () => {
  const fetchImpl = fakeFetch({
    chunks: [
      "data: {\"event\":\"log\",\"message\":\"a\"}\n\n"
      + "data: {\"event\":\"log\",\"message\":\"b\"}\n\n"
      + "data: {\"event\":\"log\",\"message\":\"c\"}\n\n",
    ],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["a", "b", "c"]);
});

await testAsync("sse: UTF-8 split mid-codepoint does not corrupt a frame", async () => {
  // "→" is E2 86 92; cut it after the first byte.
  const bytes = new TextEncoder().encode("data: {\"event\":\"log\",\"message\":\"a→b\"}\n\n");
  const fetchImpl = fakeFetch({
    chunks: [bytes.slice(0, 30), bytes.slice(30)],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", (event) => seen.push(event.message));
  client.connect();
  await client.ready();
  await tick();
  assert.deepEqual(seen, ["a→b"]);
});

test("sse: SseParser keeps an incomplete frame buffered", () => {
  const parser = new SseParser();
  assert.deepEqual(parser.push("data: {\"event\":\"log\"}"), []);
  assert.deepEqual(parser.push("\n\n"), ["{\"event\":\"log\"}"]);
  assert.deepEqual(parser.push("data: {\"a\":1}\n\ndata: {\"b\":2}\n\n"), ["{\"a\":1}", "{\"b\":2}"]);
  assert.deepEqual(parser.push(": keep-alive comment\n\n"), []);
});

await testAsync("rpc: an ok:false reply becomes an RpcError carrying code/name/message/data", async () => {
  const fetchImpl = fakeFetch({
    replies: [{
      ok: false,
      error: { code: 409, name: "STALE_REVISION", message: "file moved on", data: { current_revision: 42 } },
    }],
  });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("file.write", { path: "a.bf", text: "x", base_revision: 7 });
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError, "expected an RpcError");
  assert.equal(caught.code, 409);
  assert.equal(caught.errorName, "STALE_REVISION");
  assert.equal(caught.message, "file.write: file moved on");
  assert.equal(caught.message_, "file moved on");
  assert.deepEqual(caught.data, { current_revision: 42 });
  assert.equal(caught.method, "file.write");
  assert.equal(client.state.pending, 0, "a settled call must leave nothing pending");
});

await testAsync("rpc: a success reply resolves to result and the request is well formed", async () => {
  const fetchImpl = fakeFetch({ replies: [{ ok: true, result: { protocol: "seide/2" } }] });
  const client = createClient({ origin: "http://127.0.0.1:3939", fetchImpl });
  const result = await client.call("hello", {});
  assert.deepEqual(result, { protocol: "seide/2" });
  assert.equal(fetchImpl.calls[0].url, "http://127.0.0.1:3939/rpc");
  assert.equal(fetchImpl.calls[0].init.method, "POST");
  // A request, not a notification: the id is what makes the host answer.
  assert.equal(typeof fetchImpl.calls[0].body.id, "number");
  assert.deepEqual(fetchImpl.calls[0].body, {
    jsonrpc: "2.0", id: fetchImpl.calls[0].body.id, method: "hello", params: {},
  });
  assert.equal(fetchImpl.calls[0].init.headers["Content-Type"], "application/json");
});

await testAsync("rpc: STALE_REVISION surfaces data.current_revision to the caller", async () => {
  const fetchImpl = fakeFetch({
    replies: [{
      ok: false,
      error: { code: 409, name: "STALE_REVISION", message: "nope", data: { current_revision: 8 } },
    }],
  });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("file.write", { path: "a.bf", text: "x", base_revision: 3 });
  } catch (err) {
    caught = err;
  }
  assert.ok(client.isStaleRevision(caught), "the client must recognise a stale write");
  assert.equal(staleCurrentRevision(caught), 8);
  assert.equal(caught.data.current_revision, 8);
  // The same rejection is recognised when the endpoint puts the name in `code`.
  const alt = new RpcError({ code: "STALE_REVISION", message: "nope" }, "file.write");
  assert.ok(isStaleRevision(alt));
  assert.equal(staleCurrentRevision(alt), null);
  assert.ok(!isStaleRevision(new RpcError({ code: 404, name: "NO_SUCH_FILE", message: "x" }, "file.read")));
});

await testAsync("rpc: an unreachable host rejects the call and flips the status", async () => {
  const fetchImpl = async () => {
    throw new TypeError("fetch failed");
  };
  const states = [];
  const client = createClient({ fetchImpl, onStatus: (state) => states.push(state.connected) });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError);
  assert.equal(caught.symbol, "TRANSPORT");
  assert.ok(caught.message.includes("network error"), caught.message);
  client.connect();
  await tick();
  assert.equal(client.connected, false);
  assert.ok(states.includes(false));
});

await testAsync("rpc: a non-JSON body is a BAD_REPLY, not a crash", async () => {
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => "<html>nope" });
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.equal(caught.symbol, "BAD_REPLY");
});

await testAsync("rpc: a reply carrying a different id is a BAD_REPLY, not an answer", async () => {
  // The host echoes the id; that echo is the only thing tying a reply to the
  // request it answers, so a reply for some other id must never resolve a call.
  const fetchImpl = async (url, init) => {
    const sent = JSON.parse(init.body);
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({
        jsonrpc: "2.0",
        id: sent.id + 1,
        result: { an_answer: "for somebody else" },
      }),
    };
  };
  const client = createClient({ fetchImpl });
  let caught = null;
  try {
    await client.call("hello", {});
  } catch (err) {
    caught = err;
  }
  assert.ok(caught instanceof RpcError, "a mismatched id must not resolve the call");
  assert.equal(caught.symbol, "BAD_REPLY");
  assert.match(caught.message, /hello: the host answered a different request \(id 2, expected 1\)/);
  assert.equal(client.state.pending, 0, "the rejected call leaves nothing pending");
});

await testAsync("rpc: with two calls in flight a swapped reply rejects instead of misdelivering", async () => {
  // Answer each request with the *other* request's id and hold the replies back
  // until both are in flight. Before the id check this resolved both calls with
  // the wrong result, which is the bug: one caller got another's answer.
  const sent = [];
  const fetchImpl = (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(body);
    return new Promise((resolve) => {
      const answer = () => {
        if (sent.length < 2) {
          setTimeout(answer, 0);
          return;
        }
        const other = sent.find((entry) => entry.id !== body.id);
        resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            jsonrpc: "2.0",
            id: other.id,
            result: { answered: other.method },
          }),
        });
      };
      answer();
    });
  };
  const client = createClient({ fetchImpl });
  const settled = await Promise.allSettled([client.call("first", {}), client.call("second", {})]);
  assert.equal(settled[0].status, "rejected");
  assert.equal(settled[1].status, "rejected");
  assert.equal(settled[0].reason.symbol, "BAD_REPLY", "the first call takes no answer but its own");
  assert.equal(settled[1].reason.symbol, "BAD_REPLY", "the second call takes no answer but its own");
  assert.equal(client.state.pending, 0, "both rejected calls are cleaned up");
});

await testAsync("rpc: a handler that throws does not stop the other handlers", async () => {
  const fetchImpl = fakeFetch({
    chunks: ["data: {\"event\":\"log\",\"message\":\"one\"}\n\n"],
  });
  const client = createClient({ fetchImpl });
  const seen = [];
  client.on("log", () => {
    throw new Error("boom");
  });
  client.on("log", (event) => seen.push(event.message));
  // The client is supposed to report the bad handler on the console; that is the
  // behaviour under test, so silence it rather than let it look like a failure.
  const realError = console.error;
  console.error = () => {};
  try {
    client.connect();
    await client.ready();
    await tick();
  } finally {
    console.error = realError;
  }
  assert.deepEqual(seen, ["one"]);
});

/* ------------------------------------------------------------------ */
/* board.mjs                                                           */
/* ------------------------------------------------------------------ */

test("board: addCard/moveCard/linkCards/serialize round-trips", () => {
  let next = 1;
  const board = createBoard(undefined, { idFactory: () => `c${next++}` });
  const a = board.addCard("editor", 40, 60, { file: "examples/hello.bf" });
  const b = board.addCard("runner", 720, 300, { cmd: "python tools/bf.py examples/hello.bf", cwd: "." });
  const link = board.linkCards(a.id, b.id, "runs");

  assert.equal(a.id, "c1");
  assert.equal(b.id, "c2");
  assert.equal(link.id, "l1");
  assert.equal(a.z < b.z, true, "a later card is raised above an earlier one");

  board.moveCard(a.id, 100, 120);
  assert.equal(a.x, 100);
  assert.equal(a.y, 120);

  const doc = board.serialize();
  assert.equal(doc.version, 1);
  assert.deepEqual(doc.viewport, { x: 0, y: 0, zoom: 1 });
  assert.equal(doc.cards.length, 2);
  assert.deepEqual(doc.links, [{ id: "l1", from: "c1", to: "c2", label: "runs" }]);
  assert.deepEqual(doc.cards[0], {
    id: "c1", kind: "editor", x: 100, y: 120, w: 640, h: 420, z: 1, file: "examples/hello.bf",
  });
  // A second card re-loads from exactly what serialize() produced.
  const again = createBoard(doc);
  assert.deepEqual(again.serialize(), doc);
  assert.equal(CARD_KINDS.includes("files"), true);
});

test("board: serialize returns a copy, so mutating it cannot corrupt the model", () => {
  const board = createBoard(undefined, { idFactory: () => "c9" });
  board.addCard("note", 0, 0, { text: "scratch" });
  const doc = board.serialize();
  doc.cards[0].x = 9999;
  doc.cards.push({ id: "ghost", kind: "note", x: 0, y: 0, w: 1, h: 1 });
  doc.viewport.zoom = 99;
  assert.equal(board.cards.length, 1);
  assert.equal(board.cards[0].x, 0);
  assert.equal(board.viewport.zoom, 1);
});

test("board: removeCard drops the links that pointed at it", () => {
  const ids = ["c1", "c2", "c3"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const a = board.addCard("editor", 0, 0);
  const b = board.addCard("note", 10, 10);
  const c = board.addCard("runner", 20, 20);
  board.linkCards(a.id, b.id);
  board.linkCards(b.id, c.id);
  assert.equal(board.links.length, 2);
  assert.equal(board.removeCard(b.id), true);
  assert.equal(board.links.length, 0, "a link to a dead card is not a document this format can write");
  assert.equal(board.removeCard("nope"), false);
});

test("board: an unreadable document is repaired on load", () => {
  const result = normaliseDocument({
    version: 1,
    viewport: { x: "nope", y: 5, zoom: 900 },
    cards: [
      { id: "c1", kind: "note", x: 0, y: 0, w: 0, h: -20 },
      { id: "c1", kind: "note", x: 1, y: 1, w: 10, h: 10 },
      { id: "", kind: "note", x: 1, y: 1, w: 10, h: 10 },
      "not a card",
      { id: "c2", kind: "runner", x: 2, y: 2, w: 10, h: 10 },
    ],
    links: [
      { id: "l1", from: "c1", to: "c2" },
      { id: "l2", from: "c1", to: "ghost" },
      { id: "l3", from: "ghost", to: "c2" },
    ],
  });
  assert.equal(result.document.cards.length, 2, "the duplicate and the malformed card are dropped");
  assert.equal(result.droppedCards.length, 3);
  assert.equal(result.droppedLinks, 2);
  assert.equal(result.document.cards[0].w, MIN_SIZE.w, "a zero width is repaired, not fatal");
  assert.equal(result.document.cards[0].h, MIN_SIZE.h);
  assert.equal(result.document.cards[0].z, 0, "a missing z defaults to 0, as normaliseCard does");
  assert.equal(result.document.viewport.x, 0);
  assert.equal(result.document.viewport.y, 5);
  assert.equal(result.document.viewport.zoom, ZOOM_MAX);
});

test("board: viewport zoom is clamped and non-finite input falls back", () => {
  assert.deepEqual(clampViewport({ zoom: 100 }), { x: 0, y: 0, zoom: ZOOM_MAX });
  assert.deepEqual(clampViewport({ zoom: 0 }), { x: 0, y: 0, zoom: ZOOM_MIN });
  assert.deepEqual(clampViewport({ zoom: NaN, x: Infinity }), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(clampViewport(undefined), { x: 0, y: 0, zoom: 1 });
  assert.deepEqual(clampViewport({ x: 99, y: -99, zoom: 2.5 }), { x: 99, y: -99, zoom: 2.5 });

  const board = createBoard();
  assert.equal(board.setViewport({ zoom: 500 }).zoom, ZOOM_MAX);
  assert.equal(board.setViewport({ zoom: 0.001 }).zoom, ZOOM_MIN);
  assert.equal(board.setViewport({ x: 10 }).zoom, ZOOM_MIN, "an omitted zoom keeps its value");
});

test("board: resize clamps to the minimum, raise puts a card on top", () => {
  const ids = ["c1", "c2"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const a = board.addCard("note", 0, 0);
  const b = board.addCard("note", 0, 0);
  board.resizeCard(a.id, 1, 1);
  assert.equal(a.w, MIN_SIZE.w);
  assert.equal(a.h, MIN_SIZE.h);
  board.raiseCard(a.id);
  assert.ok(a.z > b.z);
});

test("board: unknown card kinds and extra fields survive a round trip", () => {
  const board = createBoard({
    version: 1,
    cards: [{ id: "c1", kind: "timeline", x: 1, y: 2, w: 3, h: 4, marks: [1, 2, 3] }],
    links: [],
  });
  const doc = board.serialize();
  assert.equal(doc.cards[0].kind, "timeline");
  assert.deepEqual(doc.cards[0].marks, [1, 2, 3]);
});

test("board: adding a card with an id that is already in use throws", () => {
  const board = createBoard(undefined, { idFactory: () => "c1" });
  board.addCard("note", 0, 0);
  assert.throws(() => board.addCard("note", 0, 0), /already used/);
});

test("board: link ids are unique board-wide, and unlink removes exactly one", () => {
  const board = createBoard();
  const a = board.addCard("editor", 0, 0);
  const b = board.addCard("runner", 400, 0);

  const first = board.addLink(a.id, b.id, "runs", "L1");
  assert.equal(first.id, "L1");
  // Accepting the collision would let the UI build a document its own writer
  // refuses, so it is an error, not a second link.
  assert.throws(() => board.addLink(a.id, b.id, "second", "L1"), /already used/,
    "an id that is already in use must be refused");
  assert.throws(() => board.addLink(a.id, b.id, "empty", ""), /must not be empty/);
  assert.equal(board.links.length, 1, "a refused link is not in the document");
  assert.deepEqual(board.links.map((link) => link.id), ["L1"]);

  /*
   * A file can still carry the collision even though the API now refuses it.
   * The loader keeps both edges and renames the second: losing a connection the
   * user can see is the worse repair, and a document with two links named `L1`
   * is one this format cannot write back.
   */
  const doc = board.serialize();
  doc.links = [{ ...doc.links[0] }, { ...doc.links[0] }];
  const repaired = normaliseDocument(doc);
  assert.deepEqual(repaired.repairedLinkIds, ["L1"], "the renamed id is reported, not just counted");
  assert.equal(repaired.document.links.length, 2, "the duplicate edge is kept, not dropped");
  assert.equal(new Set(repaired.document.links.map((link) => link.id)).size, 2);
  board.load(repaired.document);
  assert.doesNotThrow(() => board.serialize(), "the repaired board is a document this format accepts");

  /*
   * The API cannot build a collision any more, so make one behind its back.
   * `unlink <id>` has to remove one edge: `findIndex`/`splice` where a `filter`
   * used to remove every link that shared the id.
   */
  board.document.links.push({ id: "L1", from: a.id, to: b.id });
  assert.equal(board.links.length, 3);
  assert.throws(() => board.serialize(), /repeats link id "L1"/,
    "serialize refuses a document it cannot write");
  assert.equal(board.unlink("L1"), true);
  assert.equal(board.links.length, 2, "exactly one link was removed");
  assert.equal(board.links.filter((link) => link.id === "L1").length, 1, "the other link keeps its id");
  assert.equal(board.unlink("L1"), true, "the second link with that id is still there to remove");
  assert.equal(board.unlink("L1"), false, "removing a missing link reports false");
});

test("board: serialize refuses an invalid card instead of dropping it quietly", () => {
  const board = createBoard();
  board.addCard("note", 0, 0, { text: "keep me" });
  assert.equal(board.serialize().cards.length, 1);

  /*
   * A save that trims the card out reports success while the card is missing
   * from disk -- the one outcome a board-first editor must never produce. The
   * bad entry is kept in the model and named in the error instead.
   */
  board.document.cards.push({ id: "", kind: "note", x: 0, y: 0, w: 10, h: 10, z: 1 });
  assert.throws(() => board.serialize(), /cards\[1\] is not a valid card/);
  assert.equal(board.document.cards.length, 2, "the invalid card is kept, not silently dropped");

  // A repeated card id is refused for the same reason.
  board.document.cards.pop();
  board.document.cards.push({ ...board.document.cards[0] });
  assert.throws(() => board.serialize(), /repeats card id "c1"/);
  assert.equal(board.document.cards.length, 2);
});

/* ------------------------------------------------------------------ */
/* cards.mjs -- token spans and the pure helpers                        */
/* ------------------------------------------------------------------ */

test("board: the selection is a set, and the primary is the card commands act on", () => {
  const ids = ["c1", "c2", "c3"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const a = board.addCard("note", 0, 0);
  const b = board.addCard("note", 200, 0);
  const c = board.addCard("note", 400, 0);

  /*
   * The selection is held in *document* order, not in the order a caller
   * happened to name the ids: two clicks in the other order must not reorder
   * what `delete` walks, or undo would restore cards in a different order.
   */
  board.applySelection([c.id, a.id], null);
  assert.deepEqual(board.selection, [a.id, c.id]);
  assert.equal(board.selectedId, c.id, "no primary named: the last member is it");
  assert.equal(board.selectionCount, 2);

  // Ids that name no card -- and repeats, and non-strings -- are dropped.
  board.applySelection([a.id, a.id, 42, null, "nope"], a.id);
  assert.deepEqual(board.selection, [a.id]);
  assert.equal(board.selectedId, a.id);

  // A primary that did not survive that filter falls back to a live member --
  // the last one in document order, which is the one the caller named second.
  board.applySelection([b.id, a.id], "nope");
  assert.equal(board.selectedId, b.id, "a dead primary falls back, it is not kept");

  /*
   * Ctrl-click removes a member that is already selected; when that member was
   * the primary, another one is promoted rather than leaving the HUD describing
   * a card that is no longer selected.
   */
  board.applySelection([a.id, b.id], b.id);
  assert.equal(board.toggleSelection(a.id), true);
  assert.deepEqual(board.selection, [b.id]);
  assert.equal(board.selectedId, b.id, "removing the primary promotes a member");

  assert.equal(board.toggleSelection(c.id), true);
  assert.deepEqual(board.selection, [b.id, c.id], "adding keeps the rest, in document order");
  assert.equal(board.selectedId, c.id);
  assert.equal(board.toggleSelection("nope"), false, "a toggle on no card reports false");

  assert.equal(board.selectAll(), 3);
  assert.deepEqual(board.selection, [a.id, b.id, c.id]);
  assert.equal(board.selectedId, c.id);

  // setSelection is still the one-card path every older caller uses.
  board.setSelection(b.id);
  assert.deepEqual(board.selection, [b.id]);
  assert.equal(board.isSelected(a.id), false);

  board.clearSelection();
  assert.deepEqual(board.selection, []);
  assert.equal(board.selectedId, null);
  assert.equal(board.selectionCount, 0);
});

test("board: a rubber band selects what it touches, and a dead band selects nothing", () => {
  const cards = [
    { id: "a", kind: "note", x: 0, y: 0, w: 100, h: 100, z: 1 },
    { id: "b", kind: "note", x: 200, y: 0, w: 100, h: 100, z: 2 },
    { id: "c", kind: "note", x: 0, y: 200, w: 100, h: 100, z: 3 },
  ];

  // A band that only clips a corner still picks the card up: requiring full
  // containment would make the gesture useless on a dense board.
  assert.deepEqual(cardsWithin(cards, { x: 90, y: 90, w: 10, h: 10 }), ["a"]);
  assert.deepEqual(cardsWithin(cards, { x: 0, y: 0, w: 400, h: 400 }), ["a", "b", "c"]);
  assert.deepEqual(cardsWithin(cards, { x: 150, y: 0, w: 40, h: 10 }), [],
    "a band in the gap between two cards selects neither");

  // An unmeasurable band must not quietly become "select all".
  assert.deepEqual(cardsWithin(cards, { x: Number.NaN, y: 0, w: 10, h: 10 }), []);
  assert.deepEqual(cardsWithin(cards, { x: 0, y: 0 }), []);
  assert.deepEqual(cardsWithin(cards, null), []);

  // Document order is what the caller gets, whatever order the list was in.
  assert.deepEqual(cardsWithin([cards[2], cards[0]], { x: 0, y: 0, w: 400, h: 400 }), ["c", "a"]);

  // The board applies it and hands back the resulting selection.
  const ids = ["c1", "c2"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const one = board.addCard("note", 0, 0);
  const two = board.addCard("note", 400, 400);
  assert.deepEqual(board.selectWithin({ x: 0, y: 0, w: 50, h: 50 }), [one.id]);
  assert.deepEqual(board.selection, [one.id], "the band replaces the selection, it does not add to it");
  assert.deepEqual(board.selectWithin({ x: 0, y: 0, w: Number.NaN, h: 50 }), []);
  assert.equal(board.selectionCount, 0, "a dead band clears the selection instead of keeping it");
  assert.ok(two.id);
});

test("board: a group move and a group delete are one change each", () => {
  const ids = ["c1", "c2", "c3", "c4"];
  const board = createBoard(undefined, { idFactory: () => ids.shift() });
  const a = board.addCard("note", 0, 0);
  const b = board.addCard("note", 200, 0);
  const c = board.addCard("note", 400, 0);
  const d = board.addCard("note", 600, 0);
  board.linkCards(a.id, b.id);
  board.linkCards(b.id, c.id);
  board.linkCards(c.id, d.id);

  let changes = 0;
  board.subscribe(() => { changes += 1; });

  /*
   * A drag of N cards is one edit, not N: N notifications would put N steps in
   * the undo ring and N saves on the wire for one gesture.
   */
  const beforeMove = changes;
  assert.equal(board.moveCards([
    { id: a.id, x: 10 },
    { id: b.id, x: 210 },
    { id: "nope", x: 1 },
  ]), 2);
  assert.equal(changes - beforeMove, 1, "a group move notifies once");
  assert.equal(a.x, 10);
  assert.equal(b.x, 210);
  assert.equal(a.y, 0, "a move that names no y leaves y alone");

  board.applySelection([a.id, b.id, c.id], c.id);
  const beforeDelete = changes;
  assert.deepEqual(board.removeCards([a.id, b.id]).sort(), [a.id, b.id].sort());
  assert.equal(changes - beforeDelete, 1, "a group delete notifies once");

  // A link with a missing endpoint is not a document this format can write, so
  // an edge goes with whichever of its endpoints left -- but an edge that named
  // neither card stays exactly where it was.
  assert.deepEqual(board.links.map((link) => [link.from, link.to]), [[c.id, d.id]]);
  // And the selection forgets what is gone rather than naming a dead card.
  assert.deepEqual(board.selection, [c.id]);
  assert.equal(board.selectedId, c.id);

  assert.deepEqual(board.removeCards([a.id]), [], "removing what is already gone is a no-op");
  assert.equal(changes - beforeDelete, 1, "and a no-op is not a change");
});

test("frame: a frame holds the cards standing in it, not the ones clipping it", () => {
  const cards = [
    { id: "inside", kind: "note", x: 100, y: 100, w: 100, h: 100, z: 1 },
    { id: "clipper", kind: "note", x: 250, y: 250, w: 100, h: 100, z: 2 },
    { id: "outside", kind: "note", x: 900, y: 900, w: 100, h: 100, z: 3 },
    { id: "f", kind: "frame", x: 80, y: 80, w: 200, h: 200, z: 4 },
  ];

  // The frame spans 80..280 in both axes.  `inside` has its centre at
  // (150,150); `clipper` overlaps the border but its centre is (300,300), so it
  // has not joined the group.  That one rule is what keeps the contents of a
  // frame predictable.
  assert.deepEqual(cardsInsideRect(cards, cards[3], { except: "f" }), ["inside"]);
  assert.deepEqual(cardsInsideRect(cards, { x: 0, y: 0, w: 1000, h: 1000 }, { except: "f" }),
    ["inside", "clipper", "outside"]);

  // The frame asks the question about itself, so `except` is what keeps it out
  // of its own member list -- and document order is what comes back.
  assert.deepEqual(cardsInsideRect(cards, cards[3]), ["inside", "f"]);

  // A rectangle that cannot be measured holds nothing.
  assert.deepEqual(cardsInsideRect(cards, { x: Number.NaN, y: 0, w: 10, h: 10 }), []);
  assert.deepEqual(cardsInsideRect(cards, { x: 0, y: 0 }), []);
  assert.deepEqual(cardsInsideRect(cards, null), []);
  assert.deepEqual(cardsInsideRect(null, cards[3]), []);
});

test("frame: a frame drawn round a selection wraps it with a margin", () => {
  const cards = [
    { id: "a", kind: "note", x: 0, y: 0, w: 100, h: 100, z: 1 },
    { id: "b", kind: "note", x: 300, y: 40, w: 100, h: 60, z: 2 },
    { id: "f", kind: "frame", x: -50, y: -50, w: 400, h: 300, z: 3 },
  ];

  assert.deepEqual(frameRect(cards, ["a", "b"], { pad: 10 }),
    { x: -10, y: -10, w: 420, h: 120 });
  // The default margin is the one `group` uses.
  assert.deepEqual(frameRect(cards, ["a"], {}), { x: -26, y: -26, w: 152, h: 152 });
  // Naming the frame itself wraps the frame, which is how a frame is stretched
  // to hold what it already holds.
  assert.deepEqual(frameRect(cards, ["a", "f"], { pad: 0 }), { x: -50, y: -50, w: 400, h: 300 });

  // Ids that name nothing are ignored, and no ids at all has no rectangle.
  assert.deepEqual(frameRect(cards, ["a", "nope"], { pad: 0 }), { x: 0, y: 0, w: 100, h: 100 });
  assert.equal(frameRect(cards, [], {}), null);
  assert.equal(frameRect(cards, ["nope"], {}), null);
  assert.equal(frameRect(null, ["a"], {}), null);
});

test("tokens: spans are applied in order, with the gap rendered as plain", () => {
  const text = "++ hello world";
  const tokens = [[0, 2, "command"], [10, 14, "keyword"]];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments, [
    { start: 0, end: 2, kind: "command" },
    { start: 2, end: 10, kind: "plain" },
    { start: 10, end: 14, kind: "keyword" },
  ]);
  assert.equal(segmentsText(text, tokens), text, "segments must reconstruct the text exactly");
});

test("tokens: a tiling tokenizer produces no plain filler", () => {
  const text = "++ [>+<]\n";
  const tokens = [[0, 2, "command"], [2, 3, "ws"], [3, 8, "command"], [8, 9, "ws"]];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments.map((seg) => seg.kind), ["command", "plain", "command", "plain"]);
  assert.equal(segmentsText(text, tokens), text);
});

test("tokens: ws/ident become plain, unknown kinds do not vanish", () => {
  assert.equal(normaliseTokenKind("ws"), "plain");
  assert.equal(normaliseTokenKind("ident"), "plain");
  assert.equal(normaliseTokenKind("keyword"), "keyword");
  assert.equal(normaliseTokenKind("wat"), "plain");
  assert.equal(normaliseTokenKind(undefined), "plain");
  const segments = applyTokenSpans("abcdef", [[0, 3, "keyword"], [3, 6, "wat"]]);
  assert.deepEqual(segments, [{ start: 0, end: 3, kind: "keyword" }, { start: 3, end: 6, kind: "plain" }]);
});

test("tokens: non-ASCII offsets are string indices, so colours do not drift", () => {
  // `langs/tokenize.mjs` scans a JavaScript string, so its offsets count UTF-16
  // code units -- the unit `.length` and `.slice` use. Byte offsets would put
  // every colour after a CJK character one glyph too early, which is what the
  // docs used to warn about; the implementation was measured and it does not.
  const text = "+++ \u4E2D\u6587 \u{1F600}";
  assert.equal(text.length, 9, "the fixture's unit length must differ from its byte length");
  assert.equal(Buffer.byteLength(text, "utf8"), 15);
  // Exactly what the tokenizer emits for this text: a command run, whitespace,
  // then one ident run over two CJK characters and a two-code-unit astral one.
  const tokens = [[0, 3, "command"], [3, 4, "ws"], [4, 9, "ident"]];
  assert.equal(segmentsText(text, tokens), text, "the offsets must reconstruct the text exactly");
  assert.deepEqual(
    applyTokenSpans(text, tokens).map((seg) => seg.kind),
    ["command", "plain", "plain"],
  );
  assert.deepEqual(applyTokenSpans(text, tokens).slice(-1)[0], { start: 4, end: 9, kind: "plain" });
});

test("indent: a bare caret gets one step, not a whole line", () => {
  const out = indentSelection("abc\n", 1, 1);
  assert.equal(out.text, `a${INDENT_UNIT}bc\n`);
  assert.deepEqual(
    [out.selectionStart, out.selectionEnd],
    [1 + INDENT_UNIT.length, 1 + INDENT_UNIT.length],
  );
});

test("indent: a selection indents every line it touches, not the rest", () => {
  const out = indentSelection("one\ntwo\nthree\n", 1, 5);
  assert.equal(out.text, `${INDENT_UNIT}one\n${INDENT_UNIT}two\nthree\n`);
  assert.equal(
    out.text.slice(out.selectionStart, out.selectionEnd),
    `${INDENT_UNIT}one\n${INDENT_UNIT}two`,
  );
});

test("indent: a selection ending on a newline does not drag the next line in", () => {
  const out = indentSelection("one\ntwo\n", 0, 4);
  assert.equal(out.text, `${INDENT_UNIT}one\ntwo\n`);
  assert.equal(out.selectionEnd, INDENT_UNIT.length + 3);
});

test("indent: shift+tab takes one step back and never eats real text", () => {
  const text = "\tone\n  two\nthree\n";
  const out = indentSelection(text, 0, text.length, { outdent: true });
  assert.equal(out.text, "one\ntwo\nthree\n");
  // One leading space is indentation too, and only that one character goes.
  assert.equal(indentSelection(" one\n", 0, 5, { outdent: true }).text, "one\n");
  assert.equal(indentSelection("one\n", 0, 4, { outdent: true }).text, "one\n");
});

test("indent: enter keeps the line's indentation and steps in after an opener", () => {
  assert.equal(indentAfterEnter("    foo"), "    ");
  assert.equal(indentAfterEnter("if (x) {"), INDENT_UNIT);
  assert.equal(indentAfterEnter(`    if (x) {`), INDENT_UNIT + INDENT_UNIT);
  assert.equal(indentAfterEnter(""), "");
  assert.equal(indentAfterEnter("    "), "    ");
});

test("find: matches are literal, left to right, and do not overlap", () => {
  assert.deepEqual(findMatches("aAaA", "aa"), [{ start: 0, end: 2 }, { start: 2, end: 4 }]);
  assert.deepEqual(findMatches("aaa", "aa"), [{ start: 0, end: 2 }]);
  assert.deepEqual(findMatches("HeLLo", "hello"), [{ start: 0, end: 5 }]);
  assert.deepEqual(findMatches("abc", ""), []);
  assert.deepEqual(findMatches("abc", "zz"), []);
});

test("find: a query whose case fold changes length stays case-sensitive", () => {
  // 'İ'.toLowerCase() is two code units, so a folded search could not report
  // offsets into the original text; that search falls back to exact matching.
  assert.equal("\u0130".toLowerCase().length, 2);
  assert.deepEqual(findMatches("\u0130x", "i\u0307"), []);
  assert.deepEqual(findMatches("\u0130x", "\u0130"), [{ start: 0, end: 1 }]);
});

test("replace: one match, or every match, and the rest of the text survives", () => {
  const text = "aa bb aa";
  const hits = findMatches(text, "aa");
  assert.equal(replaceMatchAt(text, hits[1], "Z"), "aa bb Z");
  assert.deepEqual(replaceAllMatches(text, "AA", "zZ"), { text: "zZ bb zZ", count: 2 });
  assert.deepEqual(replaceAllMatches(text, "nope", "zZ"), { text, count: 0 });
});

test("find: hits split coloured segments without moving a single character", () => {
  const text = "if (x) x";
  const segments = applyTokenSpans(text, [[0, 2, "keyword"]]);
  const marked = markHits(segments, findMatches(text, "x"), 1);
  assert.equal(marked.map((seg) => text.slice(seg.start, seg.end)).join(""), text);
  assert.deepEqual(marked.filter((seg) => seg.hit).map((seg) => seg.start), [4, 7]);
  assert.deepEqual(marked.filter((seg) => seg.current).map((seg) => seg.start), [7]);
  // A hit inside a coloured run keeps the run's kind on both sides of it.
  const split = markHits(applyTokenSpans("abc", [[0, 3, "keyword"]]), findMatches("abc", "b"));
  assert.deepEqual(
    split.map((seg) => [seg.start, seg.end, seg.kind, seg.hit]),
    [[0, 1, "keyword", false], [1, 2, "keyword", true], [2, 3, "keyword", false]],
  );
});

test("tokens: bad spans are dropped and overlaps are clipped", () => {
  const text = "0123456789";
  const tokens = [
    [100, 200, "keyword"],   // past the end
    [5, 5, "keyword"],       // empty
    [8, 3, "keyword"],       // inverted
    [0, 6, "comment"],
    [2, 9, "string"],        // overlaps the comment
    "nonsense",
    { start: 9, end: 10, kind: "number" },
  ];
  const segments = applyTokenSpans(text, tokens);
  assert.deepEqual(segments, [
    { start: 0, end: 6, kind: "comment" },
    { start: 6, end: 9, kind: "string" },
    { start: 9, end: 10, kind: "number" },
  ]);
  assert.equal(segmentsText(text, tokens), text);
  assert.deepEqual([...applyTokenSpans("", [])], []);
  assert.deepEqual([...applyTokenSpans("abc", null)], [{ start: 0, end: 3, kind: "plain" }]);
});

test("tokens: line/column readout matches the caret", () => {
  assert.deepEqual(lineColumn("ab\ncd", 0), { line: 1, column: 1 });
  assert.deepEqual(lineColumn("ab\ncd", 2), { line: 1, column: 3 });
  assert.deepEqual(lineColumn("ab\ncd", 3), { line: 2, column: 1 });
  assert.deepEqual(lineColumn("ab\ncd", 99), { line: 2, column: 3 });
});

test("files: formatListing sorts directories first and formats sizes", () => {
  const now = 1_000_000;
  const listing = {
    files: [
      { path: "tools/bf.py", size: 2048, mtime: now - 3600, dir: false },
      { path: "examples", size: 0, mtime: now - 10, dir: true },
      { path: "core/src/view.c", size: 500, mtime: now - 90, dir: false },
      { path: "big.bin", size: 5 * 1024 * 1024, mtime: now - 86400 * 3, dir: false },
      { path: "", size: 1, mtime: 0, dir: false },
      null,
    ],
    count: 5,
    truncated: true,
  };
  const { rows, count, truncated } = formatListing(listing, { now });
  assert.equal(count, 5);
  assert.equal(truncated, true);
  assert.deepEqual(rows.map((row) => row.path), [
    "examples", "big.bin", "core/src/view.c", "tools/bf.py",
  ]);
  assert.equal(rows[0].dir, true);
  assert.equal(rows[0].name, "examples");
  assert.equal(rows[1].sizeText, "5.0M");
  assert.equal(rows[1].ageText, "3d");
  assert.equal(rows[2].sizeText, "500B");
  assert.equal(rows[3].ageText, "1h");
  assert.deepEqual(formatListing({}).rows, []);
});

test("files: size and age formatting stay readable", () => {
  assert.equal(formatSize(0), "0B");
  assert.equal(formatSize(1023), "1023B");
  assert.equal(formatSize(1024), "1.0K");
  assert.equal(formatSize(1536), "1.5K");
  assert.equal(formatSize(10 * 1024), "10K");
  assert.equal(formatSize(-1), "");
  assert.equal(formatSize(NaN), "");
  assert.equal(formatAge(1000, 1000), "0s");
  assert.equal(formatAge(1000, 1060), "1m");
  assert.equal(formatAge(1000, 1000 + 7200), "2h");
  assert.equal(formatAge(NaN, 0), "");
});

test("files: the filter box understands globs and substrings", () => {
  assert.equal(matchesFilter("examples/hello.bf", "**/*"), true);
  assert.equal(matchesFilter("examples/hello.bf", "**/*.bf"), true);
  assert.equal(matchesFilter("examples/sub/a.bf", "**/*.bf"), true);
  assert.equal(matchesFilter("core/src/view.c", "**/*.bf"), false);
  assert.equal(matchesFilter("core/src/view.c", "view"), true);
  assert.equal(matchesFilter("core/src/view.c", "src/*.c"), false);
  assert.equal(matchesFilter("core/src/view.c", "core/src/*.c"), true);
  assert.equal(matchesFilter("anything", ""), true);
});

/* ------------------------------------------------------------------ */
/* the project view                                                    */
/* ------------------------------------------------------------------ */

/*
 * The project panel is the one surface that has to know the whole workspace at
 * once, so the interesting cases are the ones the `files` card cannot see: what
 * the board has open but the disk does not have any more, and what the kernel
 * never handed over at all.
 *
 * The fixture is what `workspace.list` really returns: the kernel skips
 * `.git`, `.seide`, `build`, `node_modules` and friends *while walking*
 * (`IGNORED_DIRS` in `core/src/wksp.c`), so no listing carries them and the
 * panel has nothing to filter. `workspace.info.ignored` names them instead.
 */
const PROJECT_LISTING = {
  files: [
    { path: "core/src/view.c", size: 500, mtime: 900_000, dir: false },
    { path: "core/src/rpc.c", size: 400, mtime: 900_000, dir: false },
    { path: "README.md", size: 100, mtime: 900_000, dir: false },
    { path: "examples/hello.bf", size: 820, mtime: 900_000, dir: false },
    { path: "core", size: 0, mtime: 900_000, dir: true },
  ],
  count: 5,
  truncated: false,
};

test("project: the project is the files of the workspace, grouped", () => {
  const view = projectRows(PROJECT_LISTING);
  // Root first, then folders alphabetically; folders are the grouping, so a
  // directory entry in the listing is counted but never becomes a row.
  assert.deepEqual(view.groups.map((group) => group.label), ["(root)", "core/src/", "examples/"]);
  assert.deepEqual(view.groups[0].rows.map((row) => row.name), ["README.md"]);
  assert.deepEqual(view.groups[1].rows.map((row) => row.name), ["rpc.c", "view.c"]);
  assert.deepEqual(view.groups[2].rows.map((row) => row.name), ["hello.bf"]);
  assert.equal(view.groups[1].rows[0].folder, "core/src");
  assert.equal(view.groups[1].rows[0].sizeText, "400B");

  assert.equal(view.counts.files, 4);
  assert.equal(view.counts.dirs, 1);
  assert.equal(view.counts.shown, 4, "every file the kernel returned is shown");
  assert.equal(view.counts.open, 0);
  assert.equal(view.counts.complete, true);
});

test("project: the panel shows what it is given, it does not re-filter it", () => {
  // The kernel decides what a workspace listing contains. If a fork's kernel
  // hands back `build/` after all, the row belongs on screen -- a second,
  // client-side ignore list could only ever disagree with the one in C, and
  // would silently drop rows the user asked to see. `workspace.info.ignored`
  // is how the panel explains an absence; it never invents one.
  const withGenerated = {
    files: [
      { path: "core/src/rpc.c", size: 400, mtime: 900_000, dir: false },
      { path: "build/seide.exe", size: 999, mtime: 900_000, dir: false },
      { path: "node_modules/dep/index.js", size: 1, mtime: 900_000, dir: false },
    ],
    truncated: false,
  };
  const view = projectRows(withGenerated);
  assert.equal(view.counts.files, 3);
  assert.deepEqual(view.groups.map((group) => group.label), [
    "build/", "core/src/", "node_modules/dep/",
  ]);
  // The folder the file sits in is never part of the name.
  const rows = view.groups.flatMap((group) => group.rows);
  assert.equal(rows.find((row) => row.path === "node_modules/dep/index.js").name, "index.js");
});

test("project: an open editor is marked, and a file that left the disk is named", () => {
  const view = projectRows(PROJECT_LISTING, {
    open: [
      { id: "c2", path: "core/src/rpc.c", dirty: true },
      { id: "c5", path: "gone/away.c", dirty: false },
      { id: "c1", path: "examples/hello.bf", dirty: false },
    ],
  });
  const byPath = new Map(view.groups.flatMap((group) => group.rows).map((row) => [row.path, row]));
  assert.equal(byPath.get("core/src/rpc.c").open, true);
  assert.equal(byPath.get("core/src/rpc.c").dirty, true);
  assert.equal(byPath.get("core/src/rpc.c").cardId, "c2");
  assert.equal(byPath.get("core/src/view.c").open, false);

  // The open list is the board's answer to "what am I editing", file order.
  assert.deepEqual(view.openRows.map((row) => row.path), [
    "core/src/rpc.c", "examples/hello.bf", "gone/away.c",
  ]);
  assert.deepEqual(view.openRows.map((row) => row.present), [true, true, false]);
  assert.deepEqual(view.missingRows.map((row) => row.path), ["gone/away.c"]);
  assert.equal(view.counts.open, 3);
  assert.equal(view.counts.dirty, 1);
  assert.equal(view.counts.missing, 1);

  // Two cards on one file: both are open (the board may carry it), but a row
  // can only point at one of them, and it says so by naming the first.
  const twice = projectRows(PROJECT_LISTING, {
    open: [{ id: "c2", path: "core/src/rpc.c" }, { id: "c9", path: "core/src/rpc.c" }],
  });
  assert.equal(twice.counts.open, 2);
  assert.equal(twice.groups.flatMap((g) => g.rows).find((r) => r.path === "core/src/rpc.c").cardId, "c2");
});

test("project: a missing file is only a fact when the listing is complete", () => {
  const truncated = { ...PROJECT_LISTING, truncated: true };
  const view = projectRows(truncated, { open: [{ id: "c5", path: "gone/away.c" }] });
  assert.equal(view.counts.truncated, true);
  assert.equal(view.counts.complete, false);
  assert.equal(view.missingRows.length, 1, "the row is still reported");
  assert.match(projectSummary(view.counts), /listing truncated/, "...but the summary says why");
});

test("project: the filter narrows the tree and never the open list", () => {
  const view = projectRows(PROJECT_LISTING, {
    filter: "**/*.c",
    open: [{ id: "c1", path: "examples/hello.bf" }],
  });
  assert.deepEqual(view.groups.map((group) => group.label), ["core/src/"]);
  assert.equal(view.counts.files, 4, "the whole project is still counted");
  assert.equal(view.counts.shown, 2);
  assert.equal(view.counts.open, 1, "an open file stays visible however the tree is filtered");

  const word = projectRows(PROJECT_LISTING, { filter: "view" });
  assert.deepEqual(word.groups.flatMap((group) => group.rows).map((row) => row.path), [
    "core/src/view.c",
  ], "a substring hits the path");
  assert.deepEqual(projectRows(PROJECT_LISTING, { filter: "nothing-matches" }).groups, []);
  assert.deepEqual(projectRows(PROJECT_LISTING, { filter: "build/**" }).groups, [],
    "a filter aimed at a directory the kernel skips matches nothing, which is why the "
    + "empty state names the skipped directories instead of pretending they are empty");
});

test("project: paths are the kernel's, whatever the host put in them", () => {
  assert.equal(dirNameOf("a/b/c.txt"), "a/b");
  assert.equal(dirNameOf("a.txt"), "", "a file at the root has no folder");
  assert.equal(dirNameOf("a/"), "a");
  assert.equal(dirNameOf(""), "");
  assert.equal(dirNameOf("a\\b\\c.txt"), "a/b", "one separator, like the kernel's paths");
});

test("project: the one-line summary counts the workspace and the board", () => {
  assert.equal(projectSummary(projectRows(PROJECT_LISTING).counts),
    "4 files · 1 folders · 0 open");
  assert.equal(projectSummary({
    files: 128, dirs: 6, open: 2, dirty: 1, missing: 1, truncated: true,
  }), "128 files · 6 folders · 2 open · 1 unsaved · 1 missing · listing truncated");
  assert.equal(projectSummary(null), "0 files · 0 open");
  assert.equal(projectSummary({}), "0 files · 0 open");
});

test("runner: the output buffer drops the head rather than growing forever", () => {
  const buffer = new OutputBuffer({ maxChars: 100, maxLines: 5 });
  buffer.append("a".repeat(80));
  assert.equal(buffer.length, 80);
  buffer.append("b".repeat(80));
  assert.equal(buffer.length, 100, "the buffer is capped");
  assert.equal(buffer.dropped, 60);
  const lines = buffer.lines();
  assert.match(lines[0], /earlier characters/);
  assert.equal(lines.length, 2, "one marker line, then the surviving text");

  const many = new OutputBuffer({ maxChars: 100000, maxLines: 3 });
  many.append("1\n2\n3\n4\n5\n");
  assert.deepEqual(many.lines(), [
    "[... 0 earlier characters, 3 earlier lines dropped ...]",
    "4",
    "5",
    "",
  ]);
  many.clear();
  assert.deepEqual(many.lines(), [""]);
});

test("runner: exit codes read as words, not numbers", () => {
  assert.equal(formatExit(0), "exit 0");
  assert.equal(formatExit(2), "exit 2");
  assert.equal(formatExit(-1), "killed (-1)");
  assert.equal(formatExit(null), "running");
  assert.equal(formatExit(undefined), "running");
});

test("command line: quoting, zoom words and card descriptions", () => {
  assert.deepEqual(parseCommandLine("open examples/hello.bf"), ["open", "examples/hello.bf"]);
  assert.deepEqual(parseCommandLine('  run  "python tools/bf.py" "a b.bf" '), ["run", "python tools/bf.py", "a b.bf"]);
  assert.deepEqual(parseCommandLine('link c1 c2 "runs the file"'), ["link", "c1", "c2", "runs the file"]);
  assert.deepEqual(parseCommandLine("note hello world"), ["note", "hello", "world"]);
  assert.deepEqual(parseCommandLine("   "), []);
  assert.deepEqual(parseCommandLine(""), []);

  assert.equal(parseZoomArgument("in", 1), 1.25);
  assert.equal(parseZoomArgument("out", 1), 0.8);
  assert.equal(parseZoomArgument("reset", 3), 1);
  assert.equal(parseZoomArgument("2"), 2);
  assert.equal(parseZoomArgument("50%"), 0.5);
  assert.equal(parseZoomArgument("banana"), null);
  assert.equal(parseZoomArgument(""), null);

  assert.equal(describeCard({ kind: "editor", file: "a.bf" }), "editor a.bf");
  assert.equal(describeCard({ kind: "runner", cmd: "ls" }), "runner ls");
  assert.equal(describeCard({ kind: "files" }), "files **/*");
  assert.equal(describeCard(null), "no card selected");
});

/* ------------------------------------------------------------------ */
/* end to end: a real HTTP server speaking the frozen contract          */
/* ------------------------------------------------------------------ */

/**
 * The whole point of this section: the fake-fetch tests above prove the logic,
 * this one proves the *wire*.  A real `node:http` server answers `/rpc` exactly
 * as `node shell/main.mjs serve` promises to and streams `/events` as chunked
 * `text/event-stream`, and the client is left to use real fetch, real sockets
 * and real chunk boundaries.
 */
await testAsync("e2e: a real HTTP host, real SSE and real chunk boundaries", async () => {
  const board = { version: 1, viewport: { x: 0, y: 0, zoom: 1 }, cards: [], links: [] };
  let boardRevision = 3;
  let fileRevision = 11;
  const seenMethods = [];
  const sockets = new Set();

  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      const send = (object) => res.write(`data: ${JSON.stringify(object)}\n\n`);
      send({ event: "log", level: "info", message: "hello from the host" });
      // Two events written into a single TCP segment, so the reader has to split
      // a chunk that contains more than one frame.
      res.write(`data: ${JSON.stringify({ event: "log", level: "warn", message: "one" })}\n\n`
        + `data: ${JSON.stringify({ event: "log", level: "info", message: "two" })}\n\n`);
      setTimeout(() => {
        send({ event: "proc.output", run_id: 1, stream: "stdout", data: "out\n" });
        send({ event: "proc.exit", run_id: 1, code: 0 });
        res.end();
      }, 20);
      return;
    }

    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      let parsed = { method: "", params: {} };
      try {
        parsed = JSON.parse(body);
      } catch {
        parsed = { method: "", params: {} };
      }
      seenMethods.push(parsed.method);
      const reply = (value) => {
        // The real host speaks JSON-RPC, so the mock does too: the same id
        // comes back with either a result or an error.  Replying in any other
        // shape would be testing a host that does not exist.
        const body = value.ok === true
          ? { jsonrpc: "2.0", id: parsed.id, result: value.result }
          : { jsonrpc: "2.0", id: parsed.id, error: value.error };
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      };
      switch (parsed.method) {
        case "hello":
          reply({ ok: true, result: { protocol: "seide/2", kernel_version: "0.0.0-mock", root: "C:/codes/seIDE", pid: 4242 } });
          return;
        case "view.load":
          // The client names the document it wants; the host answers with that
          // path, exactly as the kernel does.
          reply({ ok: true, result: { path: parsed.params.path, revision: boardRevision, document: board } });
          return;
        case "view.save":
          if (parsed.params.base_revision !== boardRevision) {
            reply({
              ok: false,
              error: {
                code: 409, name: "STALE_REVISION", message: "the view document moved on",
                data: { current_revision: boardRevision },
              },
            });
            return;
          }
          boardRevision += 1;
          reply({ ok: true, result: { path: parsed.params.path, revision: boardRevision, saved: true } });
          return;
        case "file.read":
          reply({ ok: true, result: { path: parsed.params.path, text: "++ [>+<]\n", revision: fileRevision, size: 9, eol: "lf" } });
          return;
        case "file.write":
          if (parsed.params.base_revision !== fileRevision) {
            reply({
              ok: false,
              error: {
                code: 409, name: "STALE_REVISION", message: "file moved on",
                data: { current_revision: fileRevision },
              },
            });
            return;
          }
          fileRevision += 1;
          reply({ ok: true, result: { path: parsed.params.path, revision: fileRevision, size: parsed.params.text.length, eol: "lf" } });
          return;
        case "lang.tokenize":
          reply({ ok: true, result: { lang: { id: "bf", title: "Brainfuck" }, tokens: [[0, 2, "command"], [3, 8, "command"]] } });
          return;
        default:
          reply({ ok: false, error: { code: 404, name: "NO_METHOD", message: `no method ${parsed.method}` } });
      }
    });
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;

  try {
    const client = createClient({ origin: `http://127.0.0.1:${port}` });
    const events = [];
    client.on("log", (event) => events.push(event.message));
    client.on("proc.output", (event) => events.push(event.data));
    client.on("proc.exit", (event) => events.push(`exit ${event.code}`));
    client.connect();
    await client.ready();
    assert.equal(client.connected, true);

    const hello = await client.call("hello", {});
    assert.equal(hello.protocol, "seide/2");
    assert.equal(hello.pid, 4242);

    const loaded = await client.call("view.load", { path: ".seide/board.json" });
    assert.equal(loaded.path, ".seide/board.json", "the host answers with the path that was asked for");
    assert.equal(loaded.revision, 3);
    assert.deepEqual(loaded.document.cards, []);

    const saved = await client.call("view.save", { path: ".seide/board.json", document: board, base_revision: 3 });
    assert.equal(saved.saved, true);
    assert.equal(saved.revision, 4, "the host bumps the revision");

    const stale = await client.call("view.save", { path: ".seide/board.json", document: board, base_revision: 3 }).then(
      () => null,
      (err) => err,
    );
    assert.ok(stale instanceof RpcError, "a stale save must reject");
    assert.equal(stale.code, 409);
    assert.equal(stale.errorName, "STALE_REVISION");
    assert.equal(stale.data.current_revision, 4);
    assert.equal(staleCurrentRevision(stale), 4);
    assert.ok(client.isStaleRevision(stale));

    const read = await client.call("file.read", { path: "examples/hello.bf" });
    assert.equal(read.revision, 11);
    const written = await client.call("file.write", {
      path: read.path, text: read.text, base_revision: read.revision,
    });
    assert.equal(written.revision, 12);
    const staleWrite = await client.call("file.write", {
      path: read.path, text: "x", base_revision: 11,
    }).then(() => null, (err) => err);
    assert.equal(staleCurrentRevision(staleWrite), 12, "the second writer sees the live revision");

    const tokenized = await client.call("lang.tokenize", { path: read.path, text: read.text });
    assert.equal(tokenized.lang.id, "bf");
    const segments = applyTokenSpans(read.text, tokenized.tokens);
    assert.equal(segmentsText(read.text, tokenized.tokens), read.text);
    assert.equal(segments[0].kind, "command");

    const unknown = await client.call("nope", {}).then(() => null, (err) => err);
    assert.equal(unknown.errorName, "NO_METHOD");
    assert.equal(unknown.code, 404);

    // The stream's frames were split by the real socket, not by the test.
    for (let i = 0; i < 40 && !events.includes("exit 0"); i += 1) {
      await tick(1);
    }
    assert.deepEqual(events, ["hello from the host", "one", "two", "out\n", "exit 0"]);
    assert.equal(client.connected, false, "the host ended the stream, so we report disconnected");

    assert.deepEqual(seenMethods, [
      "hello", "view.load", "view.save", "view.save",
      "file.read", "file.write", "file.write", "lang.tokenize", "nope",
    ]);
    client.close();
  } finally {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

/* ------------------------------------------------------------------ */
/* the card-kind hook                                                  */
/* ------------------------------------------------------------------ */

test("hook: the built-in kinds register in a known order", () => {
  assert.deepEqual(knownCardKinds(),
    ["editor", "runner", "note", "files", "search", "project", "sheet", "frame"]);
  for (const kind of knownCardKinds()) {
    const spec = cardKind(kind);
    assert.equal(spec.kind, kind);
    assert.equal(typeof spec.render, "function");
    assert.equal(typeof spec.describe, "function");
    assert.equal(typeof spec.create, "function");
    assert.equal(typeof spec.title, "string");
    assert.ok(Object.isFrozen(spec), `${kind} is frozen so a fork cannot half-edit it`);
    // Every kind must be placeable without a size from the caller.
    assert.ok(DEFAULT_SIZE[kind] && DEFAULT_SIZE[kind].w >= MIN_SIZE.w && DEFAULT_SIZE[kind].h >= MIN_SIZE.h,
      `${kind} needs a usable default size`);
  }
  assert.equal(cardKind("nosuchkind"), null);
  assert.deepEqual(CARD_KIND_CONTRACT.required, ["kind", "render"]);
});

test("hook: a bad registration is refused", () => {
  assert.throws(() => registerCardKind(null), /must be an object/);
  assert.throws(() => registerCardKind({}), /kind must be a non-empty string/);
  assert.throws(() => registerCardKind({ kind: "x" }), /render must be a function/);
  assert.throws(
    () => registerCardKind({ kind: "note", render: () => ({}) }),
    /already registered/,
    "overriding a built-in has to be explicit",
  );
  assert.equal(cardKind("x"), null, "a refused registration leaves nothing behind");
});

test("hook: registerCardKind is the whole extension mechanism", () => {
  const before = knownCardKinds().length;
  const spec = registerCardKind({
    kind: "probe",
    title: "Probe",
    create: () => ({ n: 7 }),
    describe: (card) => `probe n=${card.n}`,
    render: () => ({ el: null, handle: {}, destroy() {} }),
  });
  assert.equal(spec.title, "Probe");
  assert.equal(knownCardKinds().length, before + 1);
  assert.deepEqual(spec.create(), { n: 7 });
  assert.equal(describeCard({ id: "c9", kind: "probe", n: 3 }), "probe n=3");
  /* The board stores any kind, so a new one needs no board change. */
  const board = createBoard();
  const card = board.addCard("probe", 0, 0, spec.create());
  assert.equal(card.n, 7);
  assert.equal(board.serialize().cards[0].kind, "probe");
  /* Clean up so later checks see the shipped set. */
  registerCardKind({ kind: "probe", render: () => ({ el: null, handle: {}, destroy() {} }), replace: true });
});

test("describe: an unregistered or hostile kind cannot break the header", () => {
  assert.match(describeCard({ id: "c1", kind: "mystery" }), /^mystery c1$/);
  assert.equal(describeCard(null), "no card selected");
  assert.match(describeCard({ id: "c2" }), /^\? c2$/);
  registerCardKind({
    kind: "grumpy",
    replace: true,
    render: () => ({ el: null, handle: {}, destroy() {} }),
    describe: () => {
      throw new Error("nope");
    },
  });
  assert.match(describeCard({ id: "c3", kind: "grumpy" }), /^grumpy c3/);
});

/* ------------------------------------------------------------------ */
/* the sheet model -- structured, not textual state                    */
/* ------------------------------------------------------------------ */

test("sheet: emptySheet is a legal one-by-one grid", () => {
  const sheet = emptySheet();
  assert.equal(sheet.columns.length, 1);
  assert.equal(sheet.rows.length, 1);
  assert.equal(sheetSummary(sheet), "1 row x 1 column");
  assert.deepEqual(SHEET_TYPES, ["text", "number", "bool", "choice"]);
  assert.equal(sheetCell(sheet, "row1", "column1"), "");
});

test("sheet: normaliseSheet repairs anything into a usable grid", () => {
  const empty = normaliseSheet(undefined);
  assert.equal(empty.columns.length, 1, "a sheet always has at least one column");

  const repaired = normaliseSheet({
    columns: [
      { id: "a", title: "", type: "number" },
      { id: "a", type: "nosuchtype" },
      "not a column",
      { id: "c", type: "choice", options: ["x", 9, "y"] },
    ],
    rows: [
      { id: "r", cells: { a: "12.5", c: "x" } },
      { id: "r", cells: null },
      "not a row",
    ],
  });
  assert.equal(repaired.columns.length, 3, "the string is not a column");
  assert.equal(repaired.columns[0].title, "a", "a missing title falls back to the id");
  assert.deepEqual(repaired.columns[1].type, "text", "an unknown type becomes text");
  assert.notEqual(repaired.columns[1].id, "a", "a duplicate id is renamed");
  assert.deepEqual(repaired.columns[2].options, ["x", "y"], "non-string options are dropped");
  assert.equal(repaired.rows.length, 2, "the string is not a row");
  assert.equal(repaired.rows[0].cells.a, 12.5, "a number column coerces its cell");
  assert.deepEqual(Object.keys(repaired.rows[1].cells), ["a", repaired.columns[1].id, "c"],
    "a row with no cells still gets one slot per column");
  assert.notEqual(repaired.rows[1].id, "r", "a duplicate row id is renamed");
});

test("sheet: coercion is by column type, and never throws", () => {
  assert.equal(coerceSheetValue("number", "3.5"), 3.5);
  assert.equal(coerceSheetValue("number", "  -2 "), -2);
  assert.equal(coerceSheetValue("number", "banana"), 0);
  assert.equal(coerceSheetValue("number", NaN), 0);
  assert.equal(coerceSheetValue("bool", true), true);
  assert.equal(coerceSheetValue("bool", "true"), true);
  assert.equal(coerceSheetValue("bool", "false"), false);
  assert.equal(coerceSheetValue("bool", 0), false);
  assert.equal(coerceSheetValue("text", null), "");
  assert.equal(coerceSheetValue("text", 42), "42");
  assert.equal(coerceSheetValue("nosuchtype", 42), "42");
});

test("sheet: editing mutates the card's own object, not a copy", () => {
  const doc = emptySheet();
  const identity = doc;
  assert.equal(setSheetCell(doc, "row1", "column1", "hello"), true);
  assert.equal(doc, identity, "card.doc keeps its identity across an edit");
  assert.equal(sheetCell(doc, "row1", "column1"), "hello");
  assert.equal(setSheetCell(doc, "nosuchrow", "column1", "x"), false);
  assert.equal(sheetCell(doc, "nosuchrow", "column1"), "");
});

/* Loaded apart from the static imports above so that a build without the
   header's write path fails THIS check (and says which one) instead of failing
   the whole file at import time -- which is how it reads when the fix is
   reverted to look at the failure. */
const { updateSheetColumn } = await import("./cards.mjs");

await testAsync("sheet: a column edit lands on the live doc, never on a captured column object", async () => {
  assert.equal(typeof updateSheetColumn, "function",
    "the renderer needs a pure write path that resolves a column by id");

  const doc = emptySheet();
  const identity = doc;
  const painted = doc.columns[0];

  /* A header listener holds the column object its paint was handed.  One cell
     edit is all it takes to make that object stale: every write lands fresh
     columns and rows in `doc` through replaceSheet (which is what keeps
     card.doc's identity stable). */
  assert.equal(setSheetCell(doc, "row1", "column1", "typed"), true);
  assert.notEqual(doc.columns[0], painted, "a cell edit replaces the column objects");

  painted.title = "written through the captured object";
  assert.equal(doc.columns[0].title, "column1",
    "a write through the captured object is invisible to the document");
  assert.equal(sheetToTSV(doc).split("\n")[0], "column1",
    "... so the rename is gone at the next repaint");

  /* Resolving by id at event time is what makes the header edits stick. */
  const renamed = updateSheetColumn(doc, "column1", { title: "renamed" });
  assert.notEqual(renamed, null);
  assert.equal(doc, identity, "the write keeps card.doc's identity");
  assert.equal(doc.columns[0].title, "renamed");
  assert.equal(normaliseSheet(doc).columns[0].title, "renamed", "and it survives a re-normalise");
  assert.equal(renamed.rows[0].cells.column1, "typed", "the cell edit is still there");

  /* The same write path serves the type select, which re-normalises the column
     so every cell under it takes the new type. */
  const retyped = updateSheetColumn(doc, "column1", { type: "number" });
  assert.equal(doc.columns[0].type, "number");
  assert.equal(doc.columns[0].title, "renamed", "a type change does not drop the name");
  assert.equal(doc.rows[0].cells.column1, 0, "\"typed\" is not a number, so the cell is 0");
  assert.equal(retyped.columns[0].type, "number", "the write returns the sheet it stored");

  const chosen = updateSheetColumn(doc, "column1", { type: "choice" });
  assert.deepEqual(chosen.columns[0].options, ["one", "two", "three"],
    "a column that becomes a choice gets options to choose from");
  assert.equal(doc.rows[0].cells.column1, "0", "and its cells become option strings");

  assert.equal(updateSheetColumn(doc, "nosuchcolumn", { title: "x" }), null,
    "a column that is not there is not invented");
  assert.equal(doc.columns.length, 1, "... and nothing is added to the sheet");
});

test("sheet: sheetCell still repairs a document it was handed unnormalised", () => {
  /* The paint loop no longer calls this once per cell, but the exported lookup
     keeps its guarantee for external callers: hand it anything, and it
     normalises the document itself first. */
  const hostile = {
    columns: [{ id: "n", type: "number" }, { id: "n", type: "bool" }],
    rows: [{ id: "r", cells: { n: "  -2 " } }, { id: "r", cells: null }, "not a row"],
  };
  const repaired = normaliseSheet(hostile);
  assert.equal(sheetCell(hostile, "r", "n"), -2, "coerced by the column's type");
  assert.equal(sheetCell(hostile, "r", repaired.columns[1].id), false,
    "a row with no cells is still filled in, one slot per column");
  assert.equal(sheetCell(hostile, repaired.rows[1].id, "n"), 0,
    "and every cell in it is coerced for its column");
  assert.equal(sheetCell(hostile, "r", "nosuchcolumn"), "");
  assert.equal(sheetCell(hostile, "nosuchrow", "n"), "");
  assert.equal(sheetCell(undefined, "row1", "column1"), "");
});

test("sheet: rows and columns add and remove, with the edges guarded", () => {
  const doc = emptySheet();
  const column = addSheetColumn(doc, "number");
  assert.equal(doc.columns.length, 2);
  assert.equal(column.type, "number");

  const row = addSheetRow(doc);
  assert.equal(doc.rows.length, 2);
  assert.deepEqual(Object.keys(row.cells), doc.columns.map((c) => c.id),
    "a new row has a cell for every column, including ones added before it");
  assert.equal(row.cells[column.id], 0, "a number cell starts at 0, not at ''");

  assert.equal(removeSheetRow(doc, row.id), true);
  assert.equal(removeSheetRow(doc, row.id), false);
  assert.equal(doc.rows.length, 1);

  assert.equal(removeSheetColumn(doc, column.id), true);
  assert.equal(removeSheetColumn(doc, doc.columns[0].id), false, "the last column stays");
  assert.equal(removeSheetColumn(doc, "nosuchcolumn"), false);
  assert.equal(doc.columns.length, 1);

  /* An empty sheet is legal; only the columns are load-bearing. */
  assert.equal(removeSheetRow(doc, doc.rows[0].id), true);
  assert.equal(doc.rows.length, 0);
  assert.equal(sheetSummary(doc), "0 rows x 1 column");
});

test("sheet: TSV is how structured state leaves the card", () => {
  const doc = normaliseSheet({
    columns: [{ id: "name", title: "name" }, { id: "n", title: "n", type: "number" }],
    rows: [{ id: "r1", cells: { name: "a\tb\nc", n: 5 } }, { id: "r2", cells: { name: "z", n: 0 } }],
  });
  assert.equal(sheetToTSV(doc), "name\tn\na b c\t5\nz\t0\n",
    "tabs and newlines inside a cell become spaces so the grid stays rectangular");
  assert.equal(sheetToTSV(emptySheet()), "column1\n\n");
});

test("sheet: keyboard navigation clamps instead of wrapping", () => {
  const doc = normaliseSheet({
    columns: [{ id: "a" }, { id: "b" }],
    rows: [{ id: "r1" }, { id: "r2" }],
  });
  assert.deepEqual(nextSheetSelection(doc, { row: 0, column: 0 }, 1, 1), { row: 1, column: 1 });
  assert.deepEqual(nextSheetSelection(doc, { row: 1, column: 1 }, 1, 1), { row: 1, column: 1 });
  assert.deepEqual(nextSheetSelection(doc, { row: 0, column: 0 }, -1, -1), { row: 0, column: 0 });
  assert.deepEqual(nextSheetSelection(doc, null, 0, 1), { row: 0, column: 1 });
  assert.equal(nextSheetSelection({ columns: [{ id: "a" }], rows: [] }, null, 1, 0), null);
});

test("protocol: a non-text card payload survives the board verbatim", () => {
  const doc = normaliseSheet({
    columns: [{ id: "k", title: "key" }, { id: "n", title: "n", type: "number" }, { id: "f", type: "bool" }],
    rows: [{ id: "r1", cells: { k: "unicode: \u00e9\u4e2d", n: 1.5, f: true } }],
  });
  const board = createBoard();
  board.load({
    version: 1,
    cards: [{ id: "s1", kind: "sheet", x: 0, y: 0, w: 400, h: 300, z: 1, title: "t", doc }],
    links: [],
  });
  const out = board.serialize();
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].kind, "sheet", "the board does not police card kinds");
  assert.deepEqual(out.cards[0].doc, doc, "nested structured state round-trips unchanged");
  assert.notEqual(out.cards[0].doc, doc, "and it is a copy, not an alias");
  assert.equal(DEFAULT_SIZE.sheet.w, 460);
  assert.ok(CARD_KINDS.includes("sheet"));
});

test("protocol: an unknown kind is preserved, never silently dropped", () => {
  const board = createBoard();
  board.load({
    version: 1,
    cards: [{ id: "u1", kind: "holodeck", x: 1, y: 2, w: 3, h: 4, payload: { deep: [1, 2, { three: true }] } }],
    links: [],
  });
  const out = board.serialize();
  assert.equal(out.cards.length, 1);
  assert.equal(out.cards[0].kind, "holodeck");
  assert.deepEqual(out.cards[0].payload, { deep: [1, 2, { three: true }] });
});

test("protocol: the document's card check is shape, not vocabulary", () => {
  /* The schema (board.mjs) requires id/kind/x/y/w/h and nothing else, which is
     what lets a fork invent kinds without touching C -- and the kernel no
     longer has a card check of its own to disagree with. */
  const shape = normaliseDocument({
    cards: [
      { id: "c1", kind: "sheet", x: 0, y: 0, w: 10, h: 10, doc: { anything: true } },
      { kind: "sheet", x: 0, y: 0, w: 10, h: 10 },
      { id: "c2", kind: "", x: 0, y: 0, w: 10, h: 10 },
      { id: "c3", kind: "note", x: 0, y: 0 },
    ],
  });
  assert.equal(shape.document.cards.length, 1);
  assert.equal(shape.droppedCards.length, 3);
  assert.deepEqual(shape.document.cards[0].doc, { anything: true });
});

/* ------------------------------------------------------------------ */
/* main.mjs -- the two DOM-free helpers behind the browser fixes        */
/* ------------------------------------------------------------------ */

test("cards: renderCard renders a placeholder for null, undefined and unknown kinds", () => {
  const dom = stubDom();
  try {
    // board.json is user-editable, so one malformed entry must not take the
    // whole canvas down: every one of these used to throw, and a throw inside
    // the render loop left the rest of the board unpainted.
    for (const entry of [null, undefined, 42, ["not", "a", "card"], { kind: "nope", id: "c1" }, { id: "c2" }]) {
      let card = null;
      assert.doesNotThrow(() => {
        card = renderCard(entry, {});
      }, `renderCard(${JSON.stringify(entry)}) must not throw`);
      assert.ok(card !== null && card.el, "a placeholder element is produced");
      assert.equal(typeof card.destroy, "function", "a placeholder is still destroyable");
      assert.ok(card.handle && typeof card.handle.focus === "function", "a placeholder is still focusable");
    }

    const missing = renderCard(null, {});
    assert.equal(missing.el.attrs["data-card-id"], "");
    assert.match(dom.text(missing.el), /empty \(null\)/);
    assert.match(dom.text(missing.el), /Known kinds: editor/);
    assert.equal(missing.handle.kind, "(none)");

    const unknown = renderCard({ kind: "nope", id: "c1" }, {});
    assert.equal(unknown.el.attrs["data-card-id"], "c1", "the entry keeps its own id");
    assert.match(dom.text(unknown.el), /No renderer for card kind "nope"/);
    assert.equal(unknown.handle.kind, "nope");

    // The pure decision behind it is checked directly as well, so a stub that
    // silently swallowed a throw could not make the check above pass.
    assert.equal(unknownCardPlaceholder(null).label, "(missing)");
    assert.equal(unknownCardPlaceholder(undefined).kind, "(none)");
    assert.equal(unknownCardPlaceholder(42).kind, "(not a card)");
    assert.equal(unknownCardPlaceholder({ kind: "nope" }).label, "(unknown)");
  } finally {
    dom.restore();
  }
});

await testAsync("main: ask's inline choice strip removes its command-line listener on every exit", async () => {
  /*
   * `ask()` itself is four lines: build a strip, build buttons, hand them to
   * `wireChoiceStrip`.  All listener bookkeeping lives in the helper, so this is
   * the check that the leak the browser had cannot come back: the listener must
   * be gone whether the question was answered, abandoned, or died part-way.
   */
  const strip = () => ({ removed: 0, remove() { this.removed += 1; } });

  // Answered by clicking.
  let command = stubEventTarget();
  let panel = strip();
  let button = stubEventTarget();
  let answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  assert.equal(command.count("input"), 1, "the question listens while it is open");
  button.fire("click");
  assert.equal(await answer, "yes");
  assert.equal(command.count("input"), 0, "the listener is gone once the question is answered");
  assert.equal(panel.removed, 1, "the strip is detached once");

  // Abandoned by typing.
  command = stubEventTarget();
  panel = strip();
  button = stubEventTarget();
  answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  command.fire("input");
  assert.equal(await answer, null, "typing means the question is abandoned");
  assert.equal(command.count("input"), 0, "the listener is gone once the question is abandoned");
  assert.equal(panel.removed, 1);

  // A strip that cannot detach must not keep the listener or hang the answer.
  command = stubEventTarget();
  panel = { remove() { throw new Error("already detached"); } };
  button = stubEventTarget();
  answer = wireChoiceStrip({ strip: panel, buttons: [{ el: button, value: "yes" }], abandonSource: command });
  button.fire("click");
  assert.equal(await answer, "yes", "a failing detach still resolves the answer");
  assert.equal(command.count("input"), 0, "the listener is gone even when detaching fails");

  // Several buttons cannot double-settle: the first answer wins and one
  // listener is removed, not two.
  command = stubEventTarget();
  panel = strip();
  const a = stubEventTarget();
  const b = stubEventTarget();
  answer = wireChoiceStrip({
    strip: panel,
    buttons: [{ el: a, value: "first" }, { el: b, value: "second" }],
    abandonSource: command,
  });
  b.fire("click");
  a.fire("click");
  assert.equal(await answer, "second");
  assert.equal(command.count("input"), 0);
  assert.equal(panel.removed, 1);
});

test("main: every save outcome is reported, and a failure never reads as a success", () => {
  const saved = saveOutcomeMessage({ status: "saved", revision: 7 });
  assert.equal(saved.level, "info");
  assert.match(saved.text, /rev 7/);
  // An autosave that worked is the one outcome allowed to stay quiet: a timer
  // is not the user, so a line per tick would be noise.
  assert.equal(saveOutcomeMessage({ status: "saved", revision: 7, auto: true }), null);

  // A write that succeeded without the host reporting a revision is still a
  // success, but the status line has to admit the next save is unguarded.
  const unguarded = saveOutcomeMessage({
    status: "saved",
    revision: null,
    detail: "the host reported no revision, so the next save cannot be guarded against a newer file",
  });
  assert.match(unguarded.text, /rev unknown/);
  assert.match(unguarded.text, /cannot be guarded/);

  // `save` with nothing to write used to say nothing at all, which is
  // indistinguishable from a save that quietly did nothing.
  const unchanged = saveOutcomeMessage({ status: "unchanged" });
  assert.equal(unchanged.level, "info");
  assert.match(unchanged.text, /nothing to write/);

  // A save folded into one already in flight, and a forced one stays forced.
  const deferred = saveOutcomeMessage({ status: "deferred", force: true });
  assert.match(deferred.text, /forced save/);

  // A forced overwrite the host refused -- the case that used to look like a
  // success because `force` was asked for and no error was raised.
  const refused = saveOutcomeMessage({
    status: "refused",
    force: true,
    detail: "the board changed on disk (rev 9)",
  });
  assert.equal(refused.level, "warn");
  assert.match(refused.text, /forced overwrite/);
  assert.match(refused.text, /rev 9/);

  // A save that threw, and a save that could not start.
  const failed = saveOutcomeMessage({ status: "failed", detail: "boom" });
  assert.equal(failed.level, "error");
  assert.match(failed.text, /boom/);
  assert.equal(saveOutcomeMessage({ status: "offline" }).level, "error");

  // An autosave failure is still news: nobody is watching the timer.
  assert.equal(saveOutcomeMessage({ status: "failed", auto: true, detail: "boom" }).level, "error");
  assert.equal(saveOutcomeMessage({ status: "refused", auto: true, detail: "x" }).level, "warn");

  // Nothing below "saved" may be reported as an error-free success, and none of
  // them may claim the board was saved.
  for (const status of ["refused", "failed", "offline"]) {
    const line = saveOutcomeMessage({ status });
    assert.notEqual(line.level, "info", `${status} must not look like a success`);
    assert.doesNotMatch(line.text, /board saved/, `${status} must not claim a save`);
  }
  assert.equal(saveOutcomeMessage({ status: "saved-ish" }), null, "an unknown status claims nothing");
});

/* ------------------------------------------------------------------ */
/* undo and redo                                                       */
/* ------------------------------------------------------------------ */

/** A board with two cards and one link -- enough for every kind of edit. */
function historyDoc() {
  return {
    version: 1,
    viewport: { x: 0, y: 0, zoom: 1 },
    cards: [
      { id: "c1", kind: "note", x: 0, y: 0, w: 300, h: 180, z: 1, text: "hello" },
      { id: "c2", kind: "editor", x: 400, y: 0, w: 680, h: 460, z: 2, file: "examples/hello.bf" },
    ],
    links: [{ id: "l1", from: "c1", to: "c2", label: "notes" }],
  };
}

function edited(mutate) {
  const document = historyDoc();
  mutate(document);
  return document;
}

test("history: a fresh history has nothing to undo or redo", () => {
  const history = createHistory();
  history.reset(historyDoc());
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), false);
  assert.equal(history.size(), 1);
  assert.equal(history.position(), 0);
  assert.equal(history.undo(), null, "undo at the start returns nothing");
  assert.equal(history.redo(), null, "redo when there is nothing ahead returns nothing");
  assert.deepEqual(history.current(), historyDoc(), "current() is the state it was reset to");
  assert.equal(history.label(), "the board as loaded");
});

test("history: an edit is one step and undo puts the document back", () => {
  const history = createHistory();
  const before = historyDoc();
  history.reset(before);
  const after = edited((doc) => {
    doc.cards[0].text = "hello there";
  });
  assert.equal(history.record(after), true, "a real edit pushes a step");
  assert.equal(history.canUndo(), true);
  assert.equal(history.label(), "edited the note card c1");
  const step = history.undo();
  assert.deepEqual(step.document, before, "undo restores the document it recorded from");
  assert.equal(step.label, "edited the note card c1");
  assert.equal(history.canUndo(), false);
  assert.equal(history.canRedo(), true);
  assert.deepEqual(history.redo().document, after, "redo walks forward to the same document");
  assert.equal(history.canRedo(), false);
});

test("history: a snapshot is a copy, so editing the board cannot rewrite the past", () => {
  const history = createHistory();
  const before = historyDoc();
  history.reset(before);
  const after = edited((doc) => {
    doc.cards[0].text = "new";
  });
  history.record(after);
  // The caller keeps mutating the very object it handed over: history must not
  // alias it, or every undo would "restore" the newest state.
  after.cards[0].text = "newer still";
  after.cards.push({ id: "c9", kind: "note", x: 0, y: 0, w: 100, h: 100, z: 3, text: "" });
  assert.deepEqual(history.undo().document, before, "the recorded document is untouched");
});

test("history: nothing changed, and a viewport-only move, are not steps", () => {
  const history = createHistory();
  history.reset(historyDoc());
  assert.equal(history.record(historyDoc()), false, "an identical document is not an edit");
  const panned = edited((doc) => {
    doc.viewport = { x: -120, y: 40, zoom: 1.5 };
  });
  assert.equal(history.record(panned), false, "panning and zooming are navigation, not edits");
  assert.equal(describeChange(historyDoc(), panned), null);
  assert.equal(history.size(), 1);
  const raised = edited((doc) => {
    doc.cards[0].z = 7;
  });
  assert.equal(history.record(raised), false, "raising a card is not an undo step");
});

test("history: a typing burst is one step, and a pause starts the next", () => {
  let clock = 1000;
  const history = createHistory({ now: () => clock });
  history.reset(historyDoc());
  const first = edited((doc) => {
    doc.cards[0].text = "h";
  });
  assert.equal(history.record(first), true, "the first keystroke opens a step");
  clock += 120;
  const second = edited((doc) => {
    doc.cards[0].text = "he";
  });
  assert.equal(history.record(second), false, "the next keystroke folds into it");
  clock += 120;
  const third = edited((doc) => {
    doc.cards[0].text = "hel";
  });
  history.record(third);
  assert.equal(history.size(), 2, "one step so far: the loaded board, then the sentence");
  assert.deepEqual(history.undo().document, historyDoc(), "undo takes back the whole burst");
  clock += 5000;
  history.redo();
  const later = edited((doc) => {
    doc.cards[0].text = "hello again";
  });
  assert.equal(history.record(later), true, "a pause ends the burst: this is a new step");
  assert.equal(history.size(), 3);
});

test("history: a new edit after an undo throws the redo branch away", () => {
  const history = createHistory();
  history.reset(historyDoc());
  const one = edited((doc) => {
    doc.cards[0].text = "one";
  });
  const two = edited((doc) => {
    doc.cards[0].text = "two";
  });
  history.record(one);
  history.record(two);
  assert.equal(history.undo().label, "edited the note card c1");
  assert.equal(history.canRedo(), true);
  const branch = edited((doc) => {
    doc.cards[0].text = "another branch";
  });
  history.record(branch);
  assert.equal(history.canRedo(), false, "the abandoned future is gone");
  assert.equal(history.size(), 2);
  assert.deepEqual(history.current(), branch);
});

test("history: the ring forgets the oldest steps past its limit", () => {
  const history = createHistory({ limit: 3 });
  history.reset(historyDoc());
  for (let n = 1; n <= 5; n += 1) {
    const document = edited((doc) => {
      doc.cards[0].text = `step ${n}`;
    });
    history.record(document, { label: `edit ${n}` });
  }
  assert.equal(history.size(), 3, "the limit is a ceiling, not a suggestion");
  assert.equal(history.position(), 2);
  assert.equal(history.canUndo(), true);
  assert.equal(history.undo().label, "edit 5");
  assert.equal(history.undo().label, "edit 4");
  assert.equal(history.canUndo(), false, "the steps past the limit are gone, not hidden");
  assert.equal(history.size(), 3);
});

test("history: describeChange names the edit a person just made", () => {
  const base = historyDoc();
  const adding = edited((doc) => {
    doc.cards.push({ id: "c3", kind: "note", x: 900, y: 0, w: 200, h: 120, z: 3, text: "" });
  });
  assert.equal(describeChange(base, adding), "added a card c3");
  const removing = edited((doc) => {
    doc.cards = doc.cards.filter((card) => card.id !== "c2");
    doc.links = [];
  });
  assert.equal(describeChange(base, removing), "removed a card c2 and unlinked l1");
  const moving = edited((doc) => {
    doc.cards[0].x += 40;
    doc.cards[0].y += 40;
  });
  assert.equal(describeChange(base, moving), "moved a card c1");
  const resizing = edited((doc) => {
    doc.cards[0].w = 420;
  });
  assert.equal(describeChange(base, resizing), "resized a card c1");
  const editing = edited((doc) => {
    doc.cards[1].file = "examples/page.html";
  });
  assert.equal(describeChange(base, editing), "edited the editor card c2");
  const linking = edited((doc) => {
    doc.links.push({ id: "l2", from: "c2", to: "c1", label: "back" });
  });
  assert.equal(describeChange(base, linking), "linked c2 to c1");
  const twoThings = edited((doc) => {
    doc.cards[0].x += 10;
    doc.cards[1].text = "something";
  });
  assert.equal(describeChange(base, twoThings), "edited the editor card c2 and moved a card c1");
  assert.equal(describeChange(base, base), null, "no change, no phrase");
});

test("history: clear() empties it and a record after that starts over", () => {
  const history = createHistory();
  history.reset(historyDoc());
  history.record(
    edited((doc) => {
      doc.cards[0].text = "x";
    }),
  );
  history.clear();
  assert.equal(history.size(), 0);
  assert.equal(history.position(), -1);
  assert.equal(history.canUndo(), false);
  assert.equal(history.current(), null);
  const document = edited((doc) => {
    doc.cards[0].text = "after the clear";
  });
  assert.equal(history.record(document), true, "the first record after a clear seeds the ring");
  assert.equal(history.size(), 1);
  assert.deepEqual(history.current(), document);
});

/*
 * The wheel rule the board follows: a card's own scroll region keeps the wheel
 * while it has room in that direction, and the board pans only when it does not.
 * Which ancestor is a scroll container needs a browser; this is the arithmetic
 * that decision rests on.
 */
test("wheel: a scroll region has room only where it can still move", () => {
  assert.equal(scrollRoom(0, 100, 400, 120), 300, "at the top, a downward wheel has the rest to go");
  assert.equal(scrollRoom(300, 100, 400, 120), 0, "at the bottom, a downward wheel has nowhere to go");
  assert.equal(scrollRoom(120, 100, 400, -120), 120, "a wheel up has the part already scrolled past");
  assert.equal(scrollRoom(0, 100, 400, -120), 0, "a wheel up at the top has nowhere to go");
  assert.equal(scrollRoom(0, 400, 400, 120), 0, "content that already fits does not scroll");
  assert.equal(scrollRoom(10, 100, 400, 0), 0, "a wheel that moves nothing owns nothing");
  assert.equal(scrollRoom(NaN, 100, 400, 120), 0, "a broken metric never claims room");
});

/* ------------------------------------------------------------------ */
/* searching the workspace                                             */
/* ------------------------------------------------------------------ */

/*
 * A board of cards has no tree to grep from, so the search card is where a
 * word is found across the workspace.  Everything it decides with numbers --
 * which line, which column, how much of a long line to show, when to stop --
 * is pure, and is checked here; only the reading and the rows need a browser.
 */

test("search: a hit knows its line, its column, and the line it is on", () => {
  const text = "alpha beta\nbeta gamma\nplain\n";
  const hits = searchInText(text, "beta");
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], { line: 1, column: 7, start: 6, end: 10, text: "alpha beta" });
  assert.deepEqual(hits[1], { line: 2, column: 1, start: 11, end: 15, text: "beta gamma" });
  /* The offsets are string indices into the whole file, like every other
   * offset in the shell, and they tile the text exactly. */
  assert.equal(hits[0].end, hits[1].start - 1, "the two hits are one newline apart");
  assert.deepEqual(searchInText(text, ""), [], "an empty query is not a match-everything");
  assert.deepEqual(searchInText(text, "nope"), []);
  assert.deepEqual(searchInText(null, "beta"), []);
});

test("search: a CRLF file reports the column a person sees", () => {
  const hits = searchInText("one\r\ntwo beta\r\nthree", "beta");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 2);
  assert.equal(hits[0].column, 5, "the \\r belongs to the line before, not to this line's numbering");
  assert.equal(hits[0].text, "two beta", "the excerpt never shows a stray carriage return");
});

test("search: a long line is excerpted around the hit, not from its start", () => {
  const line = `${"x".repeat(60)}needle${"y".repeat(60)}`;
  const excerpt = searchExcerpt(line, 60, 66, { context: 40 });
  assert.equal(excerpt.hit, "needle");
  assert.equal(excerpt.leading, `…${"x".repeat(40)}`);
  assert.equal(excerpt.trailing, `${"y".repeat(40)}…`);
  const short = searchExcerpt("a needle b", 2, 8, { context: 40 });
  assert.deepEqual(short, { leading: "a ", hit: "needle", trailing: " b" },
    "a line that fits is shown whole, with no ellipsis");
});

test("search: files come back by path and then down the file", () => {
  const outcome = searchFiles([
    { path: "b/x.txt", text: "hit\nhit\n" },
    { path: "a/y.txt", text: "\nhit\n" },
    { path: "a/z.txt", text: "nothing here" },
  ], "hit");
  assert.deepEqual(outcome.hits.map((hit) => `${hit.path}:${hit.line}:${hit.column}`),
    ["a/y.txt:2:1", "b/x.txt:1:1", "b/x.txt:2:1"]);
  assert.equal(outcome.matchedFiles, 2, "a file with no hit is not a matched file");
  assert.equal(outcome.searched, 3, "but it was still read");
  assert.equal(outcome.truncated, false);
  assert.equal(outcome.perFileCapped, false);
  assert.deepEqual(searchFiles([{ path: "a", text: "x" }, null, { path: 3 }], "x").hits.length, 1,
    "a malformed entry is skipped, not fatal");
});

test("search: the hit budget stops the list and says so", () => {
  const outcome = searchFiles([{ path: "a.txt", text: "x\n".repeat(10) }], "x", { maxHits: 3 });
  assert.equal(outcome.hits.length, 3);
  assert.equal(outcome.truncated, true, "a cut list must be distinguishable from a complete one");
});

test("search: one huge file cannot crowd out the rest, and says it was capped", () => {
  const outcome = searchFiles([
    { path: "a.txt", text: "x\n".repeat(10) },
    { path: "b.txt", text: "x\n" },
  ], "x", { maxPerFile: 4, maxHits: 100 });
  assert.deepEqual(outcome.hits.map((hit) => hit.path),
    ["a.txt", "a.txt", "a.txt", "a.txt", "b.txt"]);
  assert.equal(outcome.truncated, false, "the search budget was not reached");
  assert.equal(outcome.perFileCapped, true, "but a file did hit its own cap");
});

/* ------------------------------------------------------------------ */
/* external changes --- */
/*
 * The poll in `main.mjs` cannot be tested here (no browser, no timers, no
 * kernel), but the rule it follows can: what a card holding revision N should do
 * when `file.stat` comes back. Getting this wrong is the difference between an
 * editor that follows the disk and one that silently eats a file.
 */
/* ------------------------------------------------------------------ */

const statOf = (revision, extras = {}) => ({ path: "a.txt", exists: true, dir: false, revision, ...extras });

test("watch: a clean card follows a file that moved on", () => {
  assert.equal(watchDecision({ revision: 11, dirty: false }, statOf(12)), WATCH_RELOAD);
});

test("watch: a card with unsaved edits is told, never overwritten", () => {
  assert.equal(watchDecision({ revision: 11, dirty: true }, statOf(12)), WATCH_WARN,
    "reloading over a dirty buffer would throw away typing the user cannot get back");
});

test("watch: the revision the card holds is not news", () => {
  assert.equal(watchDecision({ revision: 11, dirty: false }, statOf(11)), WATCH_OK);
  assert.equal(watchDecision({ revision: 11, dirty: true }, statOf(11)), WATCH_OK,
    "an unsaved card on the revision it read is the normal state, not a warning");
});

test("watch: a card that has not read the file yet is told nothing", () => {
  assert.equal(watchDecision({ revision: null, dirty: false }, statOf(12)), WATCH_UNKNOWN);
  assert.equal(watchDecision({}, statOf(12)), WATCH_UNKNOWN);
  assert.equal(watchDecision(null, statOf(12)), WATCH_UNKNOWN);
});

test("watch: no answer is not a change", () => {
  assert.equal(watchDecision({ revision: 11 }, null), WATCH_UNKNOWN,
    "a failed stat must not read as `changed on disk`");
  assert.equal(watchDecision({ revision: 11 }, { error: new Error("kernel gone") }), WATCH_UNKNOWN);
});

test("watch: a file that is gone is gone, not changed", () => {
  const missing = { path: "a.txt", exists: false, dir: false, size: 0, mtime: -1, revision: 0 };
  assert.equal(watchDecision({ revision: 11, dirty: false }, missing), WATCH_GONE);
  assert.equal(watchDecision({ revision: 11, dirty: true }, missing), WATCH_GONE,
    "a deleted file is worth saying even when the card has unsaved edits");
  assert.equal(watchDecision({ revision: 11 }, statOf(0, { dir: true })), WATCH_GONE,
    "a directory where the file was is not a file that changed");
});

test("watch: a revision that cannot be compared warns instead of reloading", () => {
  assert.equal(watchDecision({ revision: 11, dirty: false }, statOf(0)), WATCH_WARN,
    "0 is the kernel saying `no revision to compare` (binary or unreadable)");
  assert.equal(watchDecision({ revision: 0, dirty: false }, statOf(11)), WATCH_WARN,
    "the card side can be the one that has nothing to compare");
  assert.equal(watchDecision({ revision: 11 }, statOf(undefined)), WATCH_WARN);
});

test("watch: each piece of news is reported once", () => {
  const pairs = [{ path: "a.txt", known: { revision: 11, dirty: false }, stat: statOf(12) }];
  const first = watchReport(pairs, new Map());
  assert.deepEqual(first.actions.map((action) => `${action.path}:${action.decision}:${action.revision}`),
    ["a.txt:reload:12"]);
  const again = watchReport(pairs, first.next);
  assert.deepEqual(again.actions, [], "a poll runs every 1.5s; a warning every tick is noise");
  assert.deepEqual([...again.next.keys()], ["a.txt"]);
});

test("watch: a quiet file is not news, and a later revision is news again", () => {
  const quiet = watchReport([{ path: "a.txt", known: { revision: 11 }, stat: statOf(11) }], new Map());
  assert.deepEqual(quiet.actions, []);
  assert.deepEqual([...quiet.next.values()], ["ok:11"]);
  const moved = watchReport([{ path: "a.txt", known: { revision: 12 }, stat: statOf(13) }], quiet.next);
  assert.deepEqual(moved.actions.map((action) => action.decision), ["reload"],
    "the same decision on a new revision is still news");
});

test("watch: a kernel that does not have the method is trimmed, not broken", () => {
  assert.equal(watchTrimmed([statOf(12), { error: { code: -32601, name: "METHOD_NOT_FOUND" } }]), true,
    "a fork may cut `file.stat`; the shell stops asking instead of warning forever");
  assert.equal(watchTrimmed([statOf(12)]), false);
  assert.equal(watchTrimmed([]), false);
  assert.equal(watchTrimmed([null, { error: new Error("socket closed") }]), false,
    "a transport failure is not a trimmed kernel -- that one is worth reporting");
});

test("watch: a path that is no longer open is forgotten, not carried forever", () => {
  const one = watchReport([
    { path: "a.txt", known: { revision: 11 }, stat: statOf(12) },
    { path: "b.txt", known: { revision: 2 }, stat: statOf(2) },
  ], new Map());
  assert.equal(one.next.size, 2);
  const fewer = watchReport([{ path: "b.txt", known: { revision: 2 }, stat: statOf(2) }], one.next);
  assert.deepEqual([...fewer.next.keys()], ["b.txt"]);
});

test("watch: one poll answers for every path it was given", () => {
  const report = watchReport([
    { path: "dirty.txt", known: { revision: 1, dirty: true }, stat: statOf(2) },
    { path: "gone.txt", known: { revision: 1, dirty: false }, stat: { exists: false, revision: 0 } },
    { path: "loading.txt", known: { revision: null }, stat: statOf(9) },
  ], new Map());
  assert.deepEqual(report.actions.map((action) => `${action.path}:${action.decision}`),
    ["dirty.txt:warn", "gone.txt:gone"],
    "a card still loading produces no action, and never suppresses the others");
});

/* ------------------------------------------------------------------ */
/* the classic view --- */
/*
 * The second way to look at the same board.  What is pinned here is the two
 * promises that make it a *view* rather than a second layout engine: nothing it
 * computes is written back to a card (so `mode board` is exactly the board
 * again), and every card either has one place in the tile or is hidden -- never
 * drawn at 0,0 and never moved.
 *
 * The pixels themselves are checked as arithmetic: the tile's pieces have to
 * add up at any window size, which is the part a browser would otherwise be the
 * only witness to.
 */
/* ------------------------------------------------------------------ */

const cardOf = (id, kind, extras = {}) => ({ id, kind, x: 0, y: 0, w: 100, h: 100, z: 1, ...extras });

test("classic: the sidebar is the project panel, and the file list is second choice", () => {
  assert.deepEqual(CLASSIC_SIDEBAR_KINDS, ["project", "files"]);
  const board = [cardOf("e1", "editor"), cardOf("n", "note"), cardOf("f", "files")];
  assert.equal(classicRoles(board).sidebar, "f", "no project panel, so the file list takes the column");
  assert.equal(classicRoles([...board, cardOf("p", "project")]).sidebar, "p");
});

test("classic: the code area is the focused editor, and the first one without a focus", () => {
  const board = [cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("n", "note")];
  assert.equal(classicRoles(board, "e2").area, "e2", "the focused file is the one a command would act on");
  assert.equal(classicRoles(board, "n").area, "e1", "a focused note is not a file to edit");
  assert.equal(classicRoles(board, null).area, "e1");
  assert.equal(classicRoles([cardOf("n", "note")]).area, null);
});

test("classic: one card, at most one role -- and everything else is hidden", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor"), cardOf("e2", "editor"), cardOf("f", "frame")];
  const roles = classicRoles(board, "e1");
  assert.deepEqual([roles.sidebar, roles.area], ["p", "e1"]);
  assert.deepEqual(roles.tabs, ["e1", "e2"], "every editor is a tab, even the one in the code area");
  assert.deepEqual(roles.hidden, ["e2", "f"], "the second editor is a tab, not a second pane");
  const files = classicRoles([cardOf("f", "files")], "f");
  assert.equal(files.sidebar, "f");
  assert.equal(files.area, null, "a card cannot be the sidebar and the code area at once");
});

test("classic: the tile adds up -- no gap and no overlap at any window size", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor")];
  for (const [width, height, top] of [[1200, 800, 30], [500, 400, 0], [100, 50, 26], [0, 0, 0]]) {
    const out = classicLayout(board, { width, height }, { activeId: "e1", top });
    const where = `${width}x${height} top ${top}`;
    assert.equal(out.tabs.x, out.sidebar.x + out.sidebar.w, `the strip starts where the sidebar ends (${where})`);
    assert.equal(out.area.x, out.tabs.x, `the code area is under the strip (${where})`);
    assert.equal(out.area.y, out.tabs.y + out.tabs.h, `and begins where it ends (${where})`);
    assert.equal(out.tabs.y, top, `nothing is drawn under the HUD (${where})`);
    assert.equal(out.area.x + out.area.w, width, `the tile reaches the right edge (${where})`);
    assert.equal(out.sidebar.y + out.sidebar.h, height, `the column reaches the bottom (${where})`);
    assert.equal(out.area.y + out.area.h, height, `the code area reaches the bottom (${where})`);
  }
});

test("classic: with no sidebar card the code area gets the whole width", () => {
  const out = classicLayout([cardOf("e1", "editor")], { width: 900, height: 600 }, { activeId: "e1" });
  assert.equal(out.sidebar, null);
  assert.equal(out.sidebarWidth, 0);
  assert.equal(out.tabs.x, 0);
  assert.equal(out.area.w, 900);
  assert.equal(out.tabHeight, CLASSIC_TAB_H);
});

test("classic: a narrow window squeezes the column, and the code area never goes negative", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor")];
  const widthAt = (width) => classicLayout(board, { width, height: 600 }).sidebarWidth;
  assert.equal(widthAt(1400), 280, "the comfortable width is the cap, not 40% of a big window");
  assert.equal(widthAt(500), 200, "40% of 500 is the most it may take");
  assert.equal(widthAt(300), 160, "160 is where its listing stops being readable");
  assert.equal(widthAt(100), 100, "a window narrower than that has no room for two columns");
  assert.equal(classicLayout(board, { width: 100, height: 600 }).area.w, 0);
});

test("classic: the tile starts below the HUD, which floats over the board", () => {
  const out = classicLayout([cardOf("p", "project"), cardOf("e1", "editor")], { width: 1000, height: 500 }, { top: 30 });
  assert.equal(out.tabs.y, 30);
  assert.equal(out.area.y, 30 + CLASSIC_TAB_H);
  assert.equal(out.sidebar.h, 470);
  const squashed = classicLayout([cardOf("e1", "editor")], { width: 1000, height: 20 }, { top: 30 });
  assert.equal(squashed.tabHeight, 0, "a strip taller than what is left is not drawn hanging off the board");
  assert.equal(squashed.area.h, 0);
});

test("classic: a tab is the last segment of the path, either slash", () => {
  assert.equal(classicTabLabel("core/src/wksp.c"), "wksp.c");
  assert.equal(classicTabLabel("shell\\web\\main.mjs"), "main.mjs");
  assert.equal(classicTabLabel("notes"), "notes");
  assert.equal(classicTabLabel("a/b/"), "a/b/", "a trailing slash is not a name");
  assert.equal(classicTabLabel(""), "");
  assert.equal(classicTabLabel(null), "");
  assert.equal(classicTabLabel(undefined), "");
});

test("classic: the mode a command names is one of two, and an unknown one is refused", () => {
  assert.deepEqual(CLASSIC_VIEWS, ["board", "classic"]);
  assert.equal(classicViewName("classic"), "classic");
  assert.equal(classicViewName("  Board "), "board", "the command line is not case-sensitive");
  assert.equal(classicViewName("tabs"), null, "an unknown word must warn, not fall back silently");
  assert.equal(classicViewName(""), null);
  assert.equal(classicViewName(undefined), null);
  assert.equal(classicViewName(3), null);
});

test("classic: the HUD names the view, and quotes no zoom it cannot honour", () => {
  assert.deepEqual(classicHud("classic"), { button: "board view", zoom: "no zoom" });
  assert.deepEqual(classicHud("board"), { button: "classic view", zoom: null });
  assert.deepEqual(classicHud("sideways"), classicHud("board"), "anything else is the board");
});

test("classic: a card with no place in the tile is hidden, not placed at 0,0", () => {
  const board = [cardOf("p", "project"), cardOf("e1", "editor", { x: 700, y: 400 }), cardOf("n", "note")];
  const out = classicLayout(board, { width: 1200, height: 800 }, { activeId: "e1" });
  assert.equal(out.boxes.size, 2, "only the sidebar and the code area are drawn");
  assert.equal(out.boxes.has("n"), false, "the note has no home here: hiding it is the answer");
  assert.deepEqual(out.roles.hidden, ["n"]);
});

test("classic: the layout is a projection -- it never writes to a card", () => {
  const board = [cardOf("p", "project", { x: 40, y: 60 }), cardOf("e1", "editor", { x: 700, y: 400, w: 500, h: 400 })];
  const before = JSON.parse(JSON.stringify(board));
  const out = classicLayout(board, { width: 1200, height: 800 }, { activeId: "e1", top: 30 });
  assert.notEqual(out.boxes.get("e1").x, 700, "the code area is somewhere else on screen");
  assert.deepEqual(board, before, "but the document is untouched -- `mode board` must be the board again");
});

/* ------------------------------------------------------------------ */
/* the language layer: what a subsystem is asked, and what comes back   */
/* ------------------------------------------------------------------ */

test("language: the completion prefix is the word being typed", () => {
  assert.equal(completionPrefix("const alpha = 1", 8), "al");
  assert.equal(completionPrefix("const alpha = 1", 5), "const");
  assert.equal(completionPrefix("a b", 2), "", "a space ends the word");
  assert.equal(completionPrefix("x", 99), "x", "an offset past the end is clamped");
  assert.equal(completionPrefix("", 0), "");
  assert.equal(completionPrefix(undefined, 3), "", "no text, no prefix");
  assert.equal(completionStart("const alpha = 1", 8), 6);
  assert.equal(completionStart("a b", 2), 2);
});

test("language: ranking prefers an exact-case prefix, then the shorter word", () => {
  const items = [
    { label: "alphabet", kind: "word", detail: "" },
    { label: "beta", kind: "word", detail: "" },
    { label: "Alpha", kind: "word", detail: "" },
    { label: "alpha", kind: "word", detail: "" },
    { label: "alpha", kind: "word", detail: "a duplicate of the same word" },
    null,
    "not an item",
    { label: "" },
  ];
  const ranked = rankCompletions(items, "al");
  assert.deepEqual(ranked.items.map((item) => item.label), ["alpha", "alphabet", "Alpha"]);
  assert.equal(ranked.total, 3, "the duplicate, the junk and the empty label are not candidates");
  assert.equal(ranked.truncated, false);
  assert.equal(ranked.prefix, "al");
});

test("language: a completion equal to what is typed is not offered back", () => {
  const ranked = rankCompletions([{ label: "al" }, { label: "alpha" }], "al");
  assert.deepEqual(ranked.items.map((item) => item.label), ["alpha"]);
});

test("language: the popup is capped, and says that it was", () => {
  const items = [{ label: "aaa" }, { label: "aab" }, { label: "aac" }];
  const ranked = rankCompletions(items, "a", 2);
  assert.equal(ranked.items.length, 2);
  assert.equal(ranked.total, 3);
  assert.equal(ranked.truncated, true, "a truncated popup must be able to say so");
  assert.equal(rankCompletions(null, "a").total, 0, "no list is an empty list, not an error");
  assert.equal(COMPLETION_LIMIT > 0, true);
});

test("language: inserting a completion replaces exactly the prefix", () => {
  const first = insertCompletion("const al", 8, "alpha");
  assert.equal(first.text, "const alpha");
  assert.equal(first.caret, 11);
  const over = insertCompletion("alpha", 5, "beta");
  assert.equal(over.text, "beta", "the whole typed word goes, not just its tail");
  assert.equal(over.caret, 4);
  const appended = insertCompletion("a ", 2, "x");
  assert.equal(appended.text, "a x", "with no prefix it is an insertion, not a replacement");
});

test("language: offsets and line/column agree, in both directions", () => {
  assert.deepEqual(positionOf("ab\ncd", 4), { line: 1, column: 1 });
  assert.deepEqual(positionOf("ab\ncd", 0), { line: 0, column: 0 });
  assert.deepEqual(positionOf("ab\ncd", 99), { line: 1, column: 2 }, "a past-the-end offset is the end");
  assert.equal(offsetOfPosition("ab\ncd", 1, 1), 4);
  assert.equal(offsetOfPosition("ab\ncd", 0, 1), 1);
  assert.equal(offsetOfPosition("ab\ncd", 9, 0), 5, "a missing line is the end of the text");
  assert.equal(offsetOfPosition("ab\ncd", 1, 99), 5, "a column past the line stops at the newline");
  const text = "one\ntwo\nthree";
  for (const offset of [0, 3, 4, 7, 13]) {
    const at = positionOf(text, offset);
    assert.equal(offsetOfPosition(text, at.line, at.column), offset, `round trip at ${offset}`);
  }
});

test("language: diagnostics from either subsystem come out one shape", () => {
  const fromWords = normaliseDiagnostics("abc", [{ start: 1, end: 2, severity: "error", code: "unclosed", message: "never closed" }]);
  assert.deepEqual(fromWords.diagnostics, [
    { start: 1, end: 2, severity: "error", code: "unclosed", message: "never closed", line: 0, column: 1 },
  ]);
  const fromLsp = normaliseDiagnostics("ab\ncd", [
    { range: { start: { line: 1, character: 1 }, end: { line: 1, character: 2 } }, severity: 2, message: "careful" },
  ]);
  assert.equal(fromLsp.diagnostics[0].start, 4, "an LSP range is converted to an offset");
  assert.equal(fromLsp.diagnostics[0].end, 5);
  assert.equal(fromLsp.diagnostics[0].severity, "warning");
  assert.deepEqual([fromLsp.diagnostics[0].line, fromLsp.diagnostics[0].column], [1, 1]);
});

test("language: a span outside the buffer is clamped, not swallowed", () => {
  const out = normaliseDiagnostics("abc", [
    { start: -5, end: 99, severity: 1, message: "everywhere" },
    { start: 5, end: 1, severity: 1, message: "backwards" },
  ]);
  assert.deepEqual(out.diagnostics.map((d) => [d.start, d.end]), [[0, 3], [3, 3]], "and sorted by start");
  const dropped = normaliseDiagnostics("abc", [null, 7, {}, { start: 0, end: 1 }]);
  assert.equal(dropped.total, 0, "an entry with no message and no code says nothing");
  const coded = normaliseDiagnostics("abc", [{ start: 0, end: 1, code: "E1" }]);
  assert.equal(coded.total, 1, "a code with no message is still worth reporting");
  const capped = normaliseDiagnostics("abcabc", [0, 1, 2].map((i) => ({ start: i, end: i + 1, message: `m${i}` })), 2);
  assert.equal(capped.diagnostics.length, 2);
  assert.equal(capped.total, 3);
  assert.equal(capped.truncated, true);
});

test("language: the issue under the caret, and how a strip shows one", () => {
  const out = normaliseDiagnostics("abc", [{ start: 0, end: 2, severity: 1, message: "bad" }]).diagnostics;
  assert.equal(diagnosticAt(out, 0).message, "bad", "the span includes its start");
  assert.equal(diagnosticAt(out, 2).message, "bad", "and its end, so the caret at the edge still sees it");
  assert.equal(diagnosticAt(out, 3), null);
  assert.equal(diagnosticAt(null, 0), null);
  assert.equal(formatDiagnostic({ line: 2, column: 15, message: "bad" }), "3:16 bad", "shown one-based");
  assert.equal(formatDiagnostic(null), "");
});

test("language: severities are names, whatever the server sent", () => {
  assert.equal(severityName(1), "error");
  assert.equal(severityName(2), "warning");
  assert.equal(severityName(3), "info");
  assert.equal(severityName(4), "hint");
  assert.equal(severityName("diagnostic"), "diagnostic", "a name it did not send is kept");
  assert.equal(severityName(99), "warning");
  assert.equal(severityName(undefined), "warning");
});

/** A fake shell: `subsystem.list` answers, and `subsystem.request` is scripted. */
function fakeShell(catalog, handlers = {}) {
  const calls = [];
  const log = [];
  const call = async (method, params) => {
    calls.push({ method, params });
    if (method === "subsystem.list") return { subsystems: catalog };
    if (method === "subsystem.request") {
      const key = `${params.id}.${params.method}`;
      if (typeof handlers[key] === "function") return handlers[key](params);
      if (key in handlers) {
        const value = handlers[key];
        if (value instanceof Error) throw value;
        return value;
      }
      throw new Error(`no handler for ${key}`);
    }
    throw new Error(`unexpected method ${method}`);
  };
  return { calls, log, client: new LanguageClient({ call, log: (level, message) => log.push(`${level}: ${message}`) }) };
}

const FAKE_CATALOG = [
  { id: "words", title: "Words", kind: "builtin", capabilities: ["completion", "diagnostics"], state: "stopped" },
  { id: "lsp", title: "LSP", kind: "process", capabilities: ["completion", "diagnostics", "hover", "definition", "format"], state: "running" },
];

testAsync("language: a running server is preferred over a builtin", async () => {
  const shell = fakeShell(FAKE_CATALOG);
  assert.equal(await shell.client.preferred("hover"), "lsp");
  assert.equal(await shell.client.preferred("diagnostics"), "lsp", "a warm server comes first");
  assert.equal(await shell.client.preferred("vcs"), null, "nothing answers a capability nobody has");

  const quiet = fakeShell([{ id: "words", kind: "builtin", capabilities: ["completion"], state: "stopped" }]);
  assert.equal(await quiet.client.preferred("completion"), "words");
  const two = fakeShell([
    { id: "zebra", kind: "builtin", capabilities: ["completion"], state: "stopped" },
    { id: "apple", kind: "builtin", capabilities: ["completion"], state: "stopped" },
  ]);
  assert.equal(await two.client.preferred("completion"), "apple", "ties break on the id, so the answer is stable");
});

testAsync("language: completions come from the server, and fall back to words", async () => {
  const lspAnswer = { items: [{ label: "alpha", kind: 3, detail: "fn alpha()" }], isIncomplete: false };
  const shell = fakeShell(FAKE_CATALOG, { "lsp.complete": lspAnswer });
  const fromServer = await shell.client.complete({ path: "a.bf", text: "al", offset: 2 });
  assert.equal(fromServer.source, "lsp");
  assert.deepEqual(fromServer.items.map((item) => item.label), ["alpha"]);
  assert.equal(fromServer.items[0].detail, "fn alpha()");
  assert.equal(shell.calls.find((c) => c.method === "subsystem.request").params.params.path, "a.bf");

  const fallback = fakeShell(FAKE_CATALOG, {
    "lsp.complete": new Error("the server is not ready"),
    "words.complete": { prefix: "al", items: [{ label: "alpha", kind: "word", detail: "in this file" }], total: 1 },
  });
  const fromWords = await fallback.client.complete({ path: "a.bf", text: "al", offset: 2 });
  assert.equal(fromWords.source, "words", "a server that failed is not allowed to hide the fallback");
  assert.equal(fallback.log.some((line) => line.includes("lsp could not complete")), true);

  const none = fakeShell([{ id: "words", kind: "builtin", capabilities: [], state: "stopped" }]);
  assert.equal(await none.client.complete({ path: "a.bf", text: "al", offset: 2 }), null, "no answer is not an error");
});

testAsync("language: diagnostics are normalised whoever answered", async () => {
  const shell = fakeShell(FAKE_CATALOG, {
    "lsp.diagnose": {
      diagnostics: [{ range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, severity: 1, message: "boom" }],
    },
  });
  const out = await shell.client.diagnose({ path: "a.bf", text: "abc" });
  assert.equal(out.source, "lsp");
  assert.deepEqual([out.diagnostics[0].start, out.diagnostics[0].end, out.diagnostics[0].severity], [1, 2, "error"]);

  const fallback = fakeShell(FAKE_CATALOG, {
    "lsp.diagnose": new Error("gone"),
    "words.diagnose": { diagnostics: [{ start: 0, end: 1, severity: "warning", message: "odd quotes" }] },
  });
  const words = await fallback.client.diagnose({ path: "a.bf", text: "abc" });
  assert.equal(words.source, "words");
  assert.equal(words.diagnostics[0].message, "odd quotes");

  // Diagnostics are pushed, so an empty answer that is `stale` means the server
  // has not spoken about this text yet.  That is asked for again, once.
  const asked = [];
  const pushing = fakeShell(FAKE_CATALOG, {
    "lsp.diagnose": (params) => {
      asked.push(params);
      return asked.length === 1
        ? { diagnostics: [], stale: true, version: 1 }
        : {
          diagnostics: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, severity: 2, message: "still here" }],
          stale: false,
          version: 2,
        };
    },
  });
  const later = await pushing.client.diagnose({ path: "a.bf", text: "abc" });
  assert.equal(asked.length, 2, "a stale answer is asked for again");
  assert.equal(asked[1].params.wait > 0, true, "and the second ask waits for the push");
  assert.equal(later.stale, false);
  assert.equal(later.diagnostics[0].message, "still here");

  // One retry, not a loop: a server that stays quiet is believed.
  const stubborn = fakeShell(FAKE_CATALOG, { "lsp.diagnose": () => ({ diagnostics: [], stale: true, version: 1 }) });
  const empty = await stubborn.client.diagnose({ path: "a.bf", text: "abc" });
  assert.equal(stubborn.calls.filter((entry) => entry.method === "subsystem.request").length, 2);
  assert.equal(empty.stale, true, "the caller is told the answer is stale");
  assert.equal(empty.diagnostics.length, 0);
});

testAsync("language: hover, definition and format are server-only, and quiet when absent", async () => {
  const answers = {
    "lsp.hover": { contents: "alpha: the first letter", range: null },
    "lsp.definition": { locations: [{ path: "b.bf", line: 3, column: 0 }] },
    "lsp.format": { edits: [{ start: 0, end: 1, text: "A" }], total: 1 },
  };
  const shell = fakeShell(FAKE_CATALOG, answers);
  const hover = await shell.client.hover({ path: "a.bf", text: "alpha", offset: 1 });
  assert.deepEqual(hover, { contents: "alpha: the first letter", source: "lsp" });
  const definition = await shell.client.definition({ path: "a.bf", text: "alpha", offset: 1 });
  assert.equal(definition.locations[0].path, "b.bf");
  const formatted = await shell.client.format({ path: "a.bf", text: "abc" });
  assert.equal(formatted.edits.length, 1);

  const wordsOnly = fakeShell([{ id: "words", kind: "builtin", capabilities: ["completion"], state: "stopped" }]);
  assert.equal(await wordsOnly.client.hover({ path: "a.bf", text: "a", offset: 0 }), null);
  assert.equal(await wordsOnly.client.definition({ path: "a.bf", text: "a", offset: 0 }), null);
  assert.equal(await wordsOnly.client.format({ path: "a.bf", text: "a" }), null);
  assert.equal(await wordsOnly.client.complete({ path: "a.bf", text: "a", offset: 1 }), null);

  const empty = fakeShell(FAKE_CATALOG, { "lsp.hover": { contents: "" }, "lsp.definition": { locations: [] } });
  assert.equal(await empty.client.hover({ path: "a.bf", text: "a", offset: 0 }), null, "nothing to show is nothing to show");
  assert.equal(await empty.client.definition({ path: "a.bf", text: "a", offset: 0 }), null);
});

testAsync("language: a shell without subsystems is asked once, then left alone", async () => {
  const calls = [];
  const log = [];
  const client = new LanguageClient({
    call: async (method) => {
      calls.push(method);
      throw new Error("METHOD_NOT_FOUND: no such method");
    },
    log: (level, message) => log.push(`${level}: ${message}`),
  });
  assert.equal(await client.complete({ path: "a.bf", text: "a", offset: 1 }), null);
  assert.equal(await client.diagnose({ path: "a.bf", text: "a" }), null);
  assert.equal(await client.hover({ path: "a.bf", text: "a", offset: 0 }), null);
  assert.equal(calls.filter((method) => method === "subsystem.list").length, 1, "one question, cached answer");
  assert.equal(log.length, 1, "and one warning, not one per keystroke");
  client.invalidate();
  assert.equal(await client.diagnose({ path: "a.bf", text: "a" }), null);
  assert.equal(calls.filter((method) => method === "subsystem.list").length, 2, "until something changes");
  assert.throws(() => new LanguageClient({}), TypeError);
});

/* ------------------------------------------------------------------ */

await Promise.all(pending);

const passed = checks - failures.length;
/*
 * Said on every run, pass or fail, because a green `ok N/N` is easy to read as
 * "the UI works". It does not: this suite has no browser in it.
 */
const note = `note: ${checks} checks, no DOM -- canvas layout, focus, pointer, keyboard and wheel events are not covered`;
if (failures.length > 0) {
  for (const { name, err } of failures) {
    console.error(`FAIL ${name}\n     ${err && err.message ? err.message : err}`);
    if (err && err.stack && !/^AssertionError/.test(err.name || "")) {
      console.error(String(err.stack).split("\n").slice(1, 4).map((line) => `     ${line.trim()}`).join("\n"));
    }
  }
  console.error(`ok ${passed}/${checks}`);
  console.error(note);
  process.exitCode = 1;
} else {
  console.log(`ok ${passed}/${checks}`);
  console.log(note);
}
