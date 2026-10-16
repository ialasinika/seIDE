#!/usr/bin/env node
/**
 * selftest.mjs -- proves the subsystem layer works with no kernel, no shell, no
 * browser and no network.  Run it after editing the host, a descriptor or a
 * builtin subsystem.
 *
 *     node subsystems/selftest.mjs
 *
 * Exits 0 on success, 1 on the first failure.
 */

import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { spawn as spawnProcess } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CAPABILITIES,
  SUBSYSTEM_CODES,
  SubsystemError,
  SubsystemHost,
  loadSubsystems,
  parseDescriptor,
} from "./host.mjs";
import { complete, diagnose, prefixAt } from "./words.mjs";
import { fileUri, offsetAt, pathFromUri, positionAt } from "./lsp.mjs";
import { LangRegistry, loadLanguages } from "../langs/lang.mjs";
import { tokenize } from "../langs/tokenize.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

let failures = 0;
let checks = 0;

function check(name, condition, detail) {
  checks += 1;
  if (condition) {
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail === undefined ? "" : ` -- ${detail}`}`);
  }
}

function section(title) {
  console.log(`\n${title}`);
}

function throws(fn, want) {
  try {
    fn();
  } catch (err) {
    if (want === undefined) return err;
    const text = `${err && err.message}`;
    return text.includes(want) ? err : `wrong message: ${text}`;
  }
  return false;
}

async function rejects(fn, name) {
  try {
    await fn();
  } catch (err) {
    if (err.code !== undefined && err.code === SUBSYSTEM_CODES[name]) return err;
    if (err.rpcName === name) return err;
    return new Error(`wrong error: ${err.name} ${err.code} ${err.message}`);
  }
  return new Error("nothing was thrown");
}

/** A module the host can import without touching the filesystem. */
function stub(record, overrides = {}) {
  return {
    async create(context) {
      record.created += 1;
      record.context = context;
      return {
        async start(params) {
          record.starts.push(params);
          if (overrides.start) await overrides.start(params);
        },
        async stop() {
          record.stops += 1;
        },
        async request(method, params) {
          record.calls.push([method, params]);
          if (overrides.request) return overrides.request(method, params);
          return { method };
        },
      };
    },
  };
}

function record() {
  return { created: 0, starts: [], stops: 0, calls: [], context: null };
}

function descriptorText(extra = "") {
  return `id stub
title Stub
kind builtin
module stub.mjs
capabilities completion
${extra}`;
}

function hostFor(text, overrides, options = {}) {
  const rec = record();
  const descriptor = parseDescriptor(text, "stub.sub");
  const host = new SubsystemHost({
    descriptors: [descriptor],
    importModule: async () => stub(rec, overrides),
    ...options,
  });
  return { host, rec, descriptor };
}

/* ------------------------------------------------------------------ */

section("descriptor parsing");

const wordsText = readFileSync(join(HERE, "words.sub"), "utf8");
const words = parseDescriptor(wordsText, "words.sub");
check("words.sub parses", words.id === "words", JSON.stringify(words));
check("its kind is builtin", words.kind === "builtin", words.kind);
check("it declares completion and diagnostics", words.capabilities.join(",") === "completion,diagnostics", words.capabilities.join(","));
check("it autostarts", words.autostart === true, String(words.autostart));
check("its module is a bare file name", words.module === "words.mjs", words.module);
check("its title is a word, not its id", words.title === "Words", words.title);
check("every capability it declares is a known one", words.capabilities.every((c) => CAPABILITIES.includes(c)));

check("an unknown key is a hard error", throws(() => parseDescriptor(`${descriptorText()}\nwibble yes\n`), "unknown key") !== false);
check("a missing id is a hard error", throws(() => parseDescriptor("kind builtin\nmodule x.mjs\n"), "no `id`") !== false);
check("an id must be lowercase", throws(() => parseDescriptor("id Stub\nkind builtin\nmodule x.mjs\n"), "lowercase") !== false);
check("a missing kind is a hard error", throws(() => parseDescriptor("id stub\nmodule x.mjs\n"), "no `kind`") !== false);
check("an unknown kind is a hard error", throws(() => parseDescriptor("id stub\nkind daemon\nmodule x.mjs\n"), "not one of") !== false);
check("a missing module is a hard error", throws(() => parseDescriptor("id stub\nkind builtin\n"), "no `module`") !== false);
check("a module with a path is refused", throws(() => parseDescriptor("id stub\nkind builtin\nmodule sub/x.mjs\n"), "bare file name") !== false);
check("a repeated key is a hard error", throws(() => parseDescriptor("id stub\nid other\nkind builtin\nmodule x.mjs\n"), "appears twice") !== false);
check("an unknown capability is a hard error", throws(() => parseDescriptor(`${descriptorText()}\ncapabilities telepathy\n`), "unknown capability") !== false);
check("an autostart that is not yes/no is refused", throws(() => parseDescriptor(`${descriptorText()}\nautostart maybe\n`), "must be `yes` or `no`") !== false);
check("launch on a builtin is refused", throws(() => parseDescriptor(`${descriptorText()}\nlaunch foo\n`), "process-subsystem key") !== false);
check("an indented `#` is not a comment", throws(() => parseDescriptor("id stub\n  # not a comment\n"), "") !== false);
check("a first-byte `#` is a comment", parseDescriptor("# hello\nid stub\nkind builtin\nmodule x.mjs\n", "s").id === "stub");
const repeated = parseDescriptor(
  "id stub\nkind builtin\nmodule x.mjs\ncapabilities completion\ncapabilities diagnostics\n",
  "s",
);
check(
  "`capabilities` may repeat and its values are merged",
  repeated.capabilities.join(",") === "completion,diagnostics",
  repeated.capabilities.join(","),
);
check(
  "a process descriptor may carry a launch line",
  parseDescriptor("id lsp\nkind process\nmodule lsp.mjs\nlaunch rust-analyzer\nautostart no\n", "lsp.sub").launch === "rust-analyzer",
);
check(
  "a process descriptor does not autostart by default",
  parseDescriptor("id lsp\nkind process\nmodule lsp.mjs\nlaunch x\n", "lsp.sub").autostart === false,
);

section("loading a directory");

const loaded = loadSubsystems(HERE);
check("the real directory loads", loaded.length >= 1, `${loaded.length} descriptor(s)`);
check("it contains words", loaded.some((d) => d.id === "words"), loaded.map((d) => d.id).join(", "));

const temp = mkdtempSync(join(tmpdir(), "seide-subs-"));
try {
  writeFileSync(join(temp, "stub.sub"), descriptorText(), "utf8");
  writeFileSync(join(temp, "bad.sub"), "id bad\nkind builtin\nwibble yes\n", "utf8");
  writeFileSync(join(temp, "mismatch.sub"), "id other\nkind builtin\nmodule x.mjs\n", "utf8");
  const errors = [];
  const found = loadSubsystems(temp, { onError: (message) => errors.push(message) });
  check("a good descriptor loads and a broken one is reported, not thrown", found.length === 1 && found[0].id === "stub", JSON.stringify(found.map((d) => d.id)));
  check("the broken file is named in the complaint", errors.some((e) => e.startsWith("bad.sub:")), errors.join(" | "));
  check("a file whose name does not match its id is reported", errors.some((e) => e.startsWith("mismatch.sub:")), errors.join(" | "));
  check("exactly two complaints", errors.length === 2, errors.join(" | "));
} finally {
  rmSync(temp, { recursive: true, force: true });
}

check("a missing directory is a report, not a throw", loadSubsystems(join(HERE, "no-such-dir"), { onError: () => {} }).length === 0);

section("lifecycle");

{
  const { host, rec } = hostFor(descriptorText());
  check("a subsystem nobody asked for is stopped", host.state("stub") === "stopped", host.state("stub"));
  check("list() knows it anyway", host.list().length === 1 && host.list()[0].state === "stopped", JSON.stringify(host.list()));
  check("list() carries the capabilities", host.list()[0].capabilities.join(",") === "completion", JSON.stringify(host.list()[0]));

  const events = [];
  host.onEvent = (event) => events.push(event);
  const started = await host.start("stub");
  check("start() reports running", started.state === "running", JSON.stringify(started));
  check("the adapter was created once", rec.created === 1, String(rec.created));
  check("the adapter was started once", rec.starts.length === 1, String(rec.starts.length));
  check("state events were emitted in order", events.map((e) => e.state).join(",") === "starting,running", events.map((e) => e.state).join(","));
  check("start() on a running subsystem is a no-op", (await host.start("stub")).state === "running" && rec.starts.length === 1, String(rec.starts.length));

  const answer = await host.request("stub", "ask", { n: 1 });
  check("request() reaches the adapter", answer.method === "ask", JSON.stringify(answer));
  check("the adapter saw the params", JSON.stringify(rec.calls) === JSON.stringify([["ask", { n: 1 }]]), JSON.stringify(rec.calls));

  const stopped = await host.stop("stub");
  check("stop() reports stopped", stopped.state === "stopped", JSON.stringify(stopped));
  check("the adapter was stopped once", rec.stops === 1, String(rec.stops));
  check("state events now end in stopped", events[events.length - 1].state === "stopped", JSON.stringify(events[events.length - 1]));
}

{
  const { host, rec } = hostFor(descriptorText("autostart no\n"));
  const err = await rejects(() => host.request("stub", "ask"), "SUBSYSTEM_FAILED");
  check("`autostart no` makes a request wait for subsystem.start", err instanceof SubsystemError && err.message.includes("autostart no"), String(err));
  check("nothing was started", rec.created === 0, String(rec.created));
  await host.start("stub");
  check("an explicit start works for it", host.state("stub") === "running", host.state("stub"));
}

{
  const { host } = hostFor(descriptorText());
  const err = await rejects(() => host.request("nope", "ask"), "UNKNOWN_SUBSYSTEM");
  check("an unknown id is answered, not crashed", err instanceof SubsystemError, String(err));
  check("the complaint names the id", `${err.message}`.includes("nope"), `${err.message}`);
}

{
  const { host } = hostFor(descriptorText(), { start: async () => { throw new Error("no server binary"); } });
  const err = await rejects(() => host.start("stub"), "SUBSYSTEM_FAILED");
  check("a failed start leaves the subsystem failed", host.state("stub") === "failed", host.state("stub"));
  check("the failure message survives", `${err.message}`.includes("no server binary"), `${err.message}`);
  check("list() reports the failure", host.list()[0].state === "failed", JSON.stringify(host.list()));
}

{
  const { host } = hostFor(descriptorText(), { request: () => new Promise(() => {}) }, { requestTimeoutMs: 40 });
  const err = await rejects(() => host.request("stub", "hang"), "SUBSYSTEM_TIMEOUT");
  check("a subsystem that never answers times out", err instanceof SubsystemError, String(err));
  check("the timeout message names the method", `${err.message}`.includes("hang"), `${err.message}`);
}

{
  const { host } = hostFor(descriptorText());
  host.descriptors.set("stub", { ...host.descriptor("stub"), kind: "process" });
  const err = await rejects(() => host.start("stub"), "SUBSYSTEM_UNSUPPORTED");
  check("a process subsystem without a channel says so", `${err.message}`.includes("no process channel"), `${err.message}`);
}

{
  const rec = record();
  const descriptor = parseDescriptor("id stub\nkind process\nmodule stub.mjs\nlaunch x\n", "stub.sub");
  let spawned = null;
  const host = new SubsystemHost({
    descriptors: [descriptor],
    spawn: (spec) => {
      spawned = spec;
      return { write() {}, onOutput() {}, onExit() {}, kill() {} };
    },
    importModule: async () => ({
      async create(context) {
        rec.created += 1;
        return {
          async start() {
            context.spawn({ command: context.descriptor.launch, cwd: "." });
          },
          async request() {
            return { ok: true };
          },
        };
      },
    }),
  });
  await host.start("stub");
  check("a process subsystem is handed a channel factory", spawned !== null, String(spawned));
  check("the factory is told which subsystem asked", spawned.subsystem === "stub", JSON.stringify(spawned));
  check("the adapter's own command reaches the factory", spawned.command === "x", JSON.stringify(spawned));
}

{
  const { host } = hostFor(descriptorText());
  let healthy = true;
  try {
    await host.start("stub");
  } catch {
    healthy = false;
  }
  check("a healthy start throws nothing at all", healthy, "start() threw");
  const count = await host.stopAll();
  check("stopAll() reports how many it stopped", count === 1, String(count));
}

{
  const descriptor = parseDescriptor(descriptorText(), "stub.sub");
  const host = new SubsystemHost({
    descriptors: [descriptor],
    importModule: async () => ({ notCreate: true }),
  });
  const err = await rejects(() => host.start("stub"), "SUBSYSTEM_FAILED");
  check("a module without `create` is refused with a clear message", `${err.message}`.includes("does not export `create`"), `${err.message}`);
}

{
  const { host, rec } = hostFor(descriptorText());
  const [a, b] = await Promise.all([host.start("stub"), host.start("stub")]);
  check("two asks to start share one attempt", rec.starts.length === 1 && a.state === "running" && b.state === "running", String(rec.starts.length));
  await host.stopAll();
}

section("words: completion");

check("the prefix is what the caret is inside", prefixAt("const foo", 9) === "foo", prefixAt("const foo", 9));
check("a caret in whitespace has no prefix", prefixAt("const foo ", 10) === "", prefixAt("const foo ", 10));

const sample = "function render() {\n  const total = 0;\n  return total + render(1);\n}\n";
const offered = complete({ text: sample, offset: sample.length });
check("words from the file are offered, deduplicated", offered.total >= 4 && offered.items.length === offered.total, JSON.stringify(offered.items.map((i) => i.label)));
check("the most used words rank first", ["total", "render"].includes(offered.items[0].label) && offered.items[0].label !== "function", offered.items.map((i) => i.label).join(","));
check("the answer says where each word came from", offered.items.every((i) => i.detail === "in this file"), JSON.stringify(offered.items[0]));

const filtered = complete({ text: sample, offset: 4 });
check("the prefix filters the list", filtered.prefix === "func" && filtered.items.every((i) => i.label.startsWith("func")), JSON.stringify(filtered.items.map((i) => i.label)));
check("a prefix match ignores case when it has to", (() => {
  const upper = complete({ text: "const RenderValue = 1;", offset: 9 });
  return upper.items.some((i) => i.label === "RenderValue");
})(), JSON.stringify(complete({ text: "const RenderValue = 1;", offset: 9 }).items));

const project = complete({ text: "const a = 1;\n", offset: 12, words: ["alpha", "beta"] });
check("client-supplied words are labelled as project words", project.items.some((i) => i.label === "alpha" && i.kind === "project"), JSON.stringify(project.items));
check("a word already typed exactly is not offered back", complete({ text: "alpha alpha", offset: 5 }).items.every((i) => i.label !== "alpha"), JSON.stringify(complete({ text: "alpha alpha", offset: 5 }).items));
check("completion is capped and says so", (() => {
  const many = complete({ text: "aa1 aa2 aa3 aa4", offset: 4, limit: 2 });
  return many.items.length === 2 && many.truncated === true && many.total === 4;
})(), JSON.stringify(complete({ text: "aa1 aa2 aa3 aa4", offset: 4, limit: 2 })));
check("an empty document offers nothing", complete({ text: "", offset: 0 }).total === 0);

section("words: diagnostics");

function codes(result) {
  return result.diagnostics.map((d) => d.code).join(",");
}

const unclosed = diagnose({ text: "function f(\n" }, null);
check("a bracket that never closes is an error", codes(unclosed) === "unclosed", codes(unclosed));
check("the message says which bracket", unclosed.diagnostics[0].message.includes("("), unclosed.diagnostics[0].message);
check("two openers are two errors", diagnose({ text: "f({ a: 1\n" }, null).diagnostics.length === 2, codes(diagnose({ text: "f({ a: 1\n" }, null)));
const stray = diagnose({ text: "let a = 1;\n}\n" }, null);
check("a closer that closes nothing is an error", codes(stray) === "stray-close", codes(stray));
const wrong = diagnose({ text: "let a = [1, 2);\n" }, null);
check("a closer of the wrong kind is an error", codes(wrong) === "unmatched", codes(wrong));
const comment = diagnose({ text: "/* nothing yet\n" }, null);
check("an unterminated block comment is an error", codes(comment) === "unterminated-comment", codes(comment));
const quotes = diagnose({ text: "let s = 'oops;\n" }, null);
check("an odd number of quotes is a warning", codes(quotes) === "unterminated-string" && quotes.diagnostics[0].severity === "warning", JSON.stringify(quotes.diagnostics));
check("a balanced pair is quiet", diagnose({ text: "let s = 'ok';\n" }, null).diagnostics.length === 0);
check("a properly closed comment is quiet", diagnose({ text: "/* x */\nlet a = 1;\n" }, null).diagnostics.length === 0);
check("a nested bracket pair is quiet", diagnose({ text: "f({ a: [1] })\n" }, null).diagnostics.length === 0);
check("diagnostics are sorted by offset", (() => {
  const both = diagnose({ text: "}\n(\n" }, null).diagnostics.map((d) => d.start);
  return both.length === 2 && both[0] < both[1];
})(), JSON.stringify(diagnose({ text: "}\n(\n" }, null).diagnostics.map((d) => d.start)));
check("diagnostics are capped and say so", (() => {
  const many = diagnose({ text: "(((((\n", limit: 2 });
  return many.diagnostics.length === 2 && many.truncated === true && many.total === 5;
})(), JSON.stringify(diagnose({ text: "(((((\n", limit: 2 })));

const registry = new LangRegistry(loadLanguages(join(HERE, "..", "langs"), { onError: null }));
const scanner = { registry, tokenize };
const inComment = diagnose({ text: "# ( never\n", path: "notes.bf" }, scanner);
check("a bracket inside a language's comment is not a bracket", inComment.diagnostics.length === 0, JSON.stringify(inComment.diagnostics));
const inString = diagnose({ text: '<p title="(">x</p>\n', path: "page.html" }, scanner);
check("a bracket inside a string literal is not a bracket", inString.diagnostics.length === 0, JSON.stringify(inString.diagnostics));
const stillBroken = diagnose({ text: '<p title="x">(</p>\n', path: "page.html" }, scanner);
check("a bracket in bare text is still reported", stillBroken.diagnostics.some((d) => d.code === "unclosed"), JSON.stringify(stillBroken.diagnostics));
check("with no scanner the raw text is judged anyway", diagnose({ text: "# ( never\n" }, null).diagnostics.length === 1);

section("the host and the real words subsystem");

{
  const host = new SubsystemHost({ descriptors: loadSubsystems(HERE) });
  const asked = await host.request("words", "complete", { text: "const alpha = alpha;\n", offset: 8 });
  check("subsystem.request reaches words.complete", asked.prefix === "al" && asked.items.some((i) => i.label === "alpha"), JSON.stringify(asked));
  const seen = await host.request("words", "diagnose", { text: "}\n", path: "x.bf" });
  check("subsystem.request reaches words.diagnose", codes(seen) === "stray-close", codes(seen));
  check("a running words subsystem appears in list()", host.list().find((s) => s.id === "words").state === "running", JSON.stringify(host.list()));
  const bad = await rejects(() => host.request("words", "explain"), "METHOD_NOT_FOUND");
  check("an unknown words method is METHOD_NOT_FOUND", bad instanceof Error, `${bad}`);
  await host.stopAll();
  check("stopAll() leaves words stopped", host.state("words") === "stopped", host.state("words"));
}

section("the lsp adapter's framing helpers");

check("a position is a line and a character", (() => {
  const at = positionAt("ab\ncd\n", 3);
  return at.line === 1 && at.character === 0;
})(), JSON.stringify(positionAt("ab\ncd\n", 3)));
check("an offset survives the trip out and back", (() => {
  const text = "one\ntwo\n\nfour\n";
  for (let offset = 0; offset <= text.length; offset += 1) {
    if (offsetAt(text, positionAt(text, offset)) !== offset) return false;
  }
  return true;
})());
check("a workspace path becomes a file:// URI", fileUri(ROOT, "examples/hello.bf").startsWith("file:///")
  && !fileUri(ROOT, "examples/hello.bf").includes("\\")
  && fileUri(ROOT, "examples/hello.bf").endsWith("/examples/hello.bf"), fileUri(ROOT, "examples/hello.bf"));
check("a file:// URI becomes a workspace path again", pathFromUri(fileUri(ROOT, "examples/hello.bf"), ROOT) === "examples/hello.bf",
  pathFromUri(fileUri(ROOT, "examples/hello.bf"), ROOT));

section("the lsp adapter against the scripted stub");

/**
 * The channel the shell hands a process subsystem: a child whose stdout is a
 * protocol stream.  Early output is buffered, because the adapter registers
 * `onOutput` after `spawn` returns and a fast server may speak first.
 */
function processChannel(spec) {
  const child = spawnProcess(spec.command, {
    cwd: spec.cwd,
    shell: true,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  const listeners = [];
  const early = [];
  let exited = null;
  let onExit = null;
  const deliver = (data, stream) => {
    if (listeners.length === 0) {
      early.push([data, stream]);
      return;
    }
    for (const listener of listeners) listener(data, stream);
  };
  child.stdout.on("data", (chunk) => deliver(chunk.toString("utf8"), "stdout"));
  child.stderr.on("data", (chunk) => deliver(chunk.toString("utf8"), "stderr"));
  child.on("exit", (code) => {
    exited = code ?? null;
    if (onExit !== null) onExit(exited);
  });
  return {
    write(text) {
      child.stdin.write(text);
    },
    onOutput(listener) {
      listeners.push(listener);
      while (early.length > 0) listener(...early.shift());
    },
    onExit(listener) {
      onExit = listener;
      if (exited !== null) listener(exited);
    },
    kill() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

{
  const events = [];
  const host = new SubsystemHost({
    descriptors: loadSubsystems(HERE),
    spawn: processChannel,
    root: ROOT,
    onEvent: (event) => events.push(event),
    requestTimeoutMs: 8000,
  });
  const started = await host.start("lsp");
  check("the lsp subsystem starts a real server", started.state === "running", JSON.stringify(started));

  const status = await host.request("lsp", "status", {});
  check("status reports no open files before one is named", Array.isArray(status.open) && status.open.length === 0,
    JSON.stringify(status));
  check("status names the server the descriptor launched", /lsp-stub\.mjs/.test(status.server.command ?? "") && status.server.running === true,
    JSON.stringify(status.server));

  const completing = await host.request("lsp", "complete", {
    path: "examples/hello.bf",
    text: "alpha = 1;\n",
    offset: 6,
  });
  check("completion comes back through the adapter",
    Array.isArray(completing.items) && completing.items.some((item) => item.label === "alpha"),
    JSON.stringify(completing));

  const diagnosed = await host.request("lsp", "diagnose", {
    path: "examples/hello.bf",
    text: "TODO\n(x\n",
  });
  check("the stub's diagnostics arrive as this adapter's shape",
    diagnosed.stale === false
    && diagnosed.diagnostics.some((item) => item.code === "todo" && item.severity === "warning")
    && diagnosed.diagnostics.some((item) => item.code === "unbalanced" && item.severity === "error"),
    JSON.stringify(diagnosed.diagnostics));

  const hovered = await host.request("lsp", "hover", {
    path: "examples/hello.bf",
    text: "alpha = 1;\n",
    offset: 1,
  });
  check("hover describes the word under the caret",
    typeof hovered.contents === "string" && hovered.contents.includes("alpha"),
    JSON.stringify(hovered));

  const located = await host.request("lsp", "definition", {
    path: "examples/hello.bf",
    text: "alpha = 1;\nalpha\n",
    offset: 12,
  });
  check("definition points back into the workspace",
    Array.isArray(located.locations) && located.locations.length > 0
    && located.locations[0].path === "examples/hello.bf",
    JSON.stringify(located));

  const formatted = await host.request("lsp", "format", {
    path: "examples/hello.bf",
    text: "\talpha = 1;\n",
  });
  check("format returns an edit that removes the tab",
    formatted.total >= 1 && formatted.edits.every((edit) => !edit.text.includes("\t")),
    JSON.stringify(formatted));

  const unknown = await rejects(() => host.request("lsp", "explain", {}), "METHOD_NOT_FOUND");
  check("an unknown lsp method is METHOD_NOT_FOUND", !/^(wrong error|nothing was thrown)/.test(`${unknown}`), `${unknown}`);

  await host.stop("lsp");
  check("stopping the lsp subsystem leaves it stopped", host.state("lsp") === "stopped", host.state("lsp"));
}

section("independence from the kernel");

const hereFiles = readdirSync(HERE);
check("the subsystem layer is data plus JavaScript, no C", !hereFiles.some((f) => f.endsWith(".c") || f.endsWith(".h")), hereFiles.join(", "));
const importsKernel = hereFiles
  .filter((f) => f.endsWith(".mjs"))
  .filter((f) => /import\s*\(?\s*["'][^"']*core\//.test(readFileSync(join(HERE, f), "utf8")));
check("no subsystem imports the kernel", importsKernel.length === 0, importsKernel.join(", "));
check("words still diagnoses when langs/ is gone", diagnose({ text: "(\n" }, null).diagnostics.length === 1);
check("the descriptor grammar needs no code per subsystem", loadSubsystems(HERE).every((d) => typeof d.module === "string"));

/* ------------------------------------------------------------------ */

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log("subsystems: ok");
