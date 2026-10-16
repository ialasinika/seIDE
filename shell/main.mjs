#!/usr/bin/env node
/**
 * main.mjs -- the shell's entry point, and the only Node file the user runs.
 *
 * The kernel speaks newline-delimited JSON-RPC on stdio and knows nothing
 * about languages and nothing about HTTP.  This file supplies both halves of
 * that gap, in one process, with no dependencies at all:
 *
 *   seide rpc      a stdio front end.  It spawns `build/seide.exe rpc`, forwards
 *                  every frame the kernel understands, and answers `lang.list`
 *                  and `lang.tokenize` itself.  This is the "full endpoint"
 *                  that `tools/e2e.py --seide-cmd` drives, and the reason the
 *                  test can exercise the language layer without a browser.
 *
 *   seide serve    an HTTP front end: static files from `shell/web/` plus
 *                  `POST /rpc` and `GET /events` (SSE).  Then it launches the
 *                  system's Edge/Chromium in --app= mode.  No Electron, no
 *                  bundled Chromium, nothing to download.
 *
 * Both modes share one `dispatch()` so the wire behaviour cannot drift between
 * them.
 *
 * Design note: language support is loaded with a *dynamic* import inside a
 * try/catch.  `rm -rf langs/` must leave a shell that still starts and still
 * serves the board -- it just renders plain text.
 *
 * `subsystems/` is a sibling of `langs/` on the same terms: the shell owns the
 * subsystem host, and a subsystem the host cannot load is reported and skipped
 * rather than taking the shell down.
 */

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, statSync, mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath, pathToFileURL } from "node:url";

import { SubsystemError, SubsystemHost, loadSubsystems } from "../subsystems/host.mjs";

const SHELL_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(SHELL_DIR);
const WEB_DIR = path.join(SHELL_DIR, "web");
const LANGS_DIR = path.join(ROOT, "langs");
const SUBSYSTEMS_DIR = path.join(ROOT, "subsystems");

const SHELL_VERSION = "0.4.0-alpha.1";
const DEFAULT_KERNEL = process.platform === "win32"
  ? path.join(ROOT, "build", "seide.exe")
  : path.join(ROOT, "build", "seide");

/*
 * How long a single kernel call may take before this side gives up waiting.
 * It is a patience limit, not a deadline: nothing is cancelled at the other
 * end.  A view document can be large, and a fork that raises the ceiling (many
 * thousands of cards, a slow disk) should be able to say so with
 * --timeout-ms rather than by editing this file.
 */
const DEFAULT_TIMEOUT_MS = 30000;

/* ------------------------------------------------------------------ */
/* errors                                                              */
/* ------------------------------------------------------------------ */

/** A JSON-RPC error object, from the kernel or from this process. */
export class RpcError extends Error {
  constructor(error, method, transport = null) {
    const e = error && typeof error === "object" ? error : {};
    super(e.message ? String(e.message) : `rpc ${method} failed`);
    this.name = "RpcError";
    this.code = e.code ?? -32603;
    this.rpcName = e.name ?? "INTERNAL";
    this.data = e.data;
    this.method = method;
    this.transport = transport;
  }

  toJSON() {
    const error = { code: this.code, name: this.rpcName, message: this.message };
    if (this.data !== undefined) error.data = this.data;
    return error;
  }
}

/* ------------------------------------------------------------------ */
/* kernel link                                                         */
/* ------------------------------------------------------------------ */

/**
 * One child process, one id space, one promise per in-flight request.
 *
 * Ids are minted here (`h1`, `h2`, ...) rather than taken from the caller, so
 * a stdio client may reuse ids freely and still get the right answers back.
 */
export class Kernel {
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #listeners = new Set();
  #exit = null;
  #stderr = null;

  constructor({
    exe = DEFAULT_KERNEL,
    workspace = process.cwd(),
    verbose = false,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}) {
    this.exe = exe;
    this.workspace = workspace;
    this.verbose = verbose;
    this.timeoutMs = timeoutMs;
  }

  get running() {
    return this.#child !== null && this.#exit === null;
  }

  onNotification(fn) {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }

  #emit(event) {
    for (const fn of this.#listeners) {
      try {
        fn(event);
      } catch (err) {
        this.#log(`notification listener threw: ${err && err.message}`);
      }
    }
  }

  #log(message) {
    this.#emit({ event: "log", level: "warn", message: String(message) });
  }

  /** Spawns the kernel and proves it is alive with a `hello` round trip. */
  async start() {
    if (!existsSync(this.exe)) {
      throw new RpcError(
        { code: -32000, name: "KERNEL_MISSING", message: `no kernel at ${this.exe} -- run: mingw32-make -f Makefile` },
        "start",
        "spawn",
      );
    }

    const child = spawn(this.exe, ["rpc", "--root", this.workspace], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on("line", (line) => this.#onLine(line));

    this.#stderr = readline.createInterface({ input: child.stderr, crlfDelay: Infinity });
    this.#stderr.on("line", (line) => {
      if (this.verbose) process.stderr.write(`[kernel] ${line}\n`);
    });

    child.on("error", (err) => {
      this.#exit = { code: null, signal: null, error: err };
      this.#failAll(new RpcError(
        { code: -32000, name: "KERNEL_GONE", message: `cannot run ${this.exe}: ${err.message}` },
        "start",
        "spawn",
      ));
    });

    child.on("exit", (code, signal) => {
      this.#exit = { code, signal };
      this.#failAll(new RpcError(
        { code: -32000, name: "KERNEL_GONE", message: `the kernel exited (code ${code}, signal ${signal})` },
        "exit",
        "transport",
      ));
    });

    await this.call("hello");
    return this;
  }

  #onLine(line) {
    const text = line.trim();
    if (text === "") return;

    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.#log(`unparsable kernel frame: ${text.slice(0, 200)}`);
      return;
    }

    if (frame === null || typeof frame !== "object") {
      this.#log("non-object kernel frame");
      return;
    }

    if (frame.event !== undefined) {
      this.#emit(frame);
      return;
    }

    const id = frame.id;
    if (id !== undefined && id !== null && this.#pending.has(id)) {
      const waiter = this.#pending.get(id);
      this.#pending.delete(id);
      clearTimeout(waiter.timer);
      if (frame.error) {
        waiter.reject(new RpcError(frame.error, waiter.method));
      } else {
        waiter.resolve(frame.result);
      }
      return;
    }

    // A parse error the kernel raised on a frame it could not read at all, so
    // it could not carry an id back.  The kernel reads frames one at a time, so
    // this belongs to the oldest call still waiting: settling it here turns a
    // silent 30-second hang into the error that actually happened.
    if (frame.error) {
      const oldest = this.#pending.keys().next();
      if (!oldest.done) {
        const waiter = this.#pending.get(oldest.value);
        this.#pending.delete(oldest.value);
        clearTimeout(waiter.timer);
        waiter.reject(new RpcError(frame.error, waiter.method));
        return;
      }
      this.#log(frame.error.message ? String(frame.error.message) : "kernel reported an error with no request id");
      return;
    }
    this.#log("kernel sent a response for an unknown id");
  }

  #failAll(error) {
    for (const [, waiter] of this.#pending) {
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
    this.#pending.clear();
  }

  call(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (!this.running) {
      return Promise.reject(new RpcError(
        { code: -32000, name: "KERNEL_GONE", message: "the kernel is not running" },
        method,
        "transport",
      ));
    }

    const id = `h${this.#nextId++}`;
    const frame = { jsonrpc: "2.0", id, method };
    if (params !== undefined) frame.params = params;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        /*
         * A timeout here is a statement about this side's patience, not about
         * the kernel's state: the request is not cancelled and the kernel may
         * still be working on it.  Saying only "did not answer" invites the
         * caller to treat the operation as failed and retry it into a kernel
         * that is still busy with the first attempt.
         */
        reject(new RpcError(
          {
            code: -32001,
            name: "TIMEOUT",
            message: `${method} did not answer within ${timeoutMs} ms. `
              + "The request was not cancelled and the kernel may still be "
              + "working on it; raise the limit with --timeout-ms.",
          },
          method,
          "timeout",
        ));
      }, timeoutMs);
      timer.unref?.();

      this.#pending.set(id, { resolve, reject, method, timer });
      this.#child.stdin.write(`${JSON.stringify(frame)}\n`, (err) => {
        if (err && this.#pending.has(id)) {
          this.#pending.delete(id);
          clearTimeout(timer);
          reject(new RpcError(
            { code: -32000, name: "WRITE_FAILED", message: err.message },
            method,
            "transport",
          ));
        }
      });
    });
  }

  close() {
    const child = this.#child;
    this.#child = null;
    if (this.#exit === null) {
      this.#exit = { code: null, signal: "SHELL_CLOSE" };
    }
    this.#failAll(new RpcError(
      { code: -32000, name: "KERNEL_GONE", message: "the shell closed the kernel" },
      "close",
      "transport",
    ));
    if (child && child.exitCode === null && !child.killed) {
      try {
        child.stdin.end();
        child.kill();
      } catch {
        /* already gone */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* language layer (optional, lives outside the kernel)                 */
/* ------------------------------------------------------------------ */

/** Fallback used when `langs/` has been deleted: everything is plain text. */
class PlainLanguages {
  available = false;

  list() {
    return { langs: [] };
  }

  /** No language layer: every path is plain text. */
  detect() {
    return null;
  }

  tokenize(text) {
    return { tokens: [[0, text.length, "plain"]], lang: null };
  }
}

class FileLanguages {
  available = true;

  constructor(registry, tokenize, tokenizePlain) {
    this.registry = registry;
    this.#tokenize = tokenize;
    this.#tokenizePlain = tokenizePlain;
  }

  #tokenize;
  #tokenizePlain;

  list() {
    return { langs: this.registry.list() };
  }

  /** The language a path is written in, or null when nothing claims it. */
  detect(filePath) {
    if (typeof filePath !== "string" || filePath === "") {
      return null;
    }
    return this.registry.detect(filePath) ?? null;
  }

  tokenize(text, { path: filePath = null, lang: id = null } = {}) {
    const lang = (id !== null ? this.registry.byId(id) : null)
      ?? (filePath !== null ? this.registry.detect(filePath) : null)
      ?? null;
    if (lang === null) {
      return { tokens: this.#tokenizePlain(text), lang: null };
    }
    return { tokens: this.#tokenize(lang, text), lang: lang.id };
  }
}

async function loadLanguages(dir, log = () => {}) {
  try {
    const [langMod, tokMod] = await Promise.all([
      import(pathToFileURL(path.join(dir, "lang.mjs")).href),
      import(pathToFileURL(path.join(dir, "tokenize.mjs")).href),
    ]);
    // A descriptor that cannot be read is skipped rather than fatal -- one bad
    // file must not cost every other language -- but skipping it silently
    // makes a typo indistinguishable from having no languages at all, so each
    // one is reported.
    const problems = [];
    const registry = langMod.LangRegistry.fromDir(dir, {
      onError: (file, err) => problems.push(`${path.basename(file)}: ${err && err.message}`),
    });
    for (const problem of problems) {
      log(`langs: skipping descriptor -- ${problem}`);
    }
    if (registry.list().length === 0) {
      log(`langs: no descriptors in ${dir}; every file opens as plain text`);
    }
    return new FileLanguages(registry, tokMod.tokenize, tokMod.tokenizePlain);
  } catch (err) {
    // Deliberately not fatal: `langs/` is optional by design, and the editor
    // degrades to plain text.  Saying so is what keeps the degradation from
    // looking like "this project has no languages".
    log(`langs: the language layer did not load (${err && err.message});`
      + " every file opens as plain text");
    return new PlainLanguages();
  }
}

/* ------------------------------------------------------------------ */
/* dispatch -- the single definition of what a frame means             */
/* ------------------------------------------------------------------ */

function response(id, result) {
  return { jsonrpc: "2.0", id, result: result === undefined ? null : result };
}

function failure(id, code, name, message, data) {
  const error = { code, name, message };
  if (data !== undefined) error.data = data;
  return { jsonrpc: "2.0", id, error };
}

/**
 * Answers one request.  Returns the response object, or null when the frame
 * was a notification (which must not be answered).
 *
 * Methods the shell owns:
 *   lang.list, lang.tokenize            served from langs/, no kernel involved
 *   subsystem.list/start/stop/request   served from subsystems/, same terms
 *   workspace.info                      the kernel's answer plus `langs`
 * Everything else is forwarded verbatim.
 */
export async function dispatch(frame, kernel, languages, subsystems = null) {
  if (frame === null || typeof frame !== "object" || Array.isArray(frame)) {
    return failure(null, -32600, "INVALID_REQUEST", "a frame must be a JSON object");
  }

  const id = frame.id;
  const notification = id === undefined;
  const method = frame.method;
  const params = frame.params ?? {};

  if (typeof method !== "string" || method === "") {
    return notification ? null : failure(id, -32600, "INVALID_REQUEST", "`method` must be a non-empty string");
  }

  const answer = (build) => (notification ? null : build());

  try {
    if (method === "lang.list") {
      return answer(() => response(id, languages.list()));
    }

    if (method === "lang.tokenize") {
      if (typeof params.text !== "string") {
        return answer(() => failure(id, -32602, "INVALID_PARAMS", "lang.tokenize needs a string `text`"));
      }
      if (!languages.available) {
        return answer(() => response(id, { tokens: [[0, params.text.length, "plain"]], lang: null }));
      }
      return answer(() => response(id, languages.tokenize(params.text, {
        path: typeof params.path === "string" ? params.path : null,
        lang: typeof params.lang === "string" ? params.lang : null,
      })));
    }

    // Subsystems are the shell's, exactly like the language layer: the kernel
    // knows about files, documents and processes, and a language server is
    // none of its business.  A shell built without a host still answers
    // `subsystem.list` -- with nothing in it -- so a client never has to
    // guess whether the method exists.
    if (method.startsWith("subsystem.")) {
      if (subsystems === null) {
        if (method === "subsystem.list") return answer(() => response(id, { subsystems: [] }));
        return answer(() => failure(id, -32601, "METHOD_NOT_FOUND", `${method} needs a shell with a subsystem host`));
      }
      if (method === "subsystem.list") {
        return answer(() => response(id, { subsystems: subsystems.list() }));
      }
      if (method === "subsystem.start" || method === "subsystem.stop") {
        if (typeof params.id !== "string" || params.id === "") {
          return answer(() => failure(id, -32602, "INVALID_PARAMS", `${method} needs a string \`id\``));
        }
        const result = method === "subsystem.start"
          ? await subsystems.start(params.id, params.params ?? {})
          : await subsystems.stop(params.id);
        return answer(() => response(id, result));
      }
      if (method === "subsystem.request") {
        if (typeof params.id !== "string" || params.id === "") {
          return answer(() => failure(id, -32602, "INVALID_PARAMS", "subsystem.request needs a string `id`"));
        }
        if (typeof params.method !== "string" || params.method === "") {
          return answer(() => failure(id, -32602, "INVALID_PARAMS", "subsystem.request needs a string `method`"));
        }
        const result = await subsystems.request(params.id, params.method, params.params ?? {});
        return answer(() => response(id, result));
      }
      return answer(() => failure(id, -32601, "METHOD_NOT_FOUND", `no such method: ${method}`));
    }

    const result = await kernel.call(method, frame.params);

    // The kernel is language-agnostic, so the language inventory is added by
    // the layer that actually owns it.  A client that only needs the kernel
    // can ignore the member entirely.
    if (method === "workspace.info" && result !== null && typeof result === "object") {
      return answer(() => response(id, { ...result, langs: languages.list().langs }));
    }

    // Same reasoning for a single file: `file.read` names the language the
    // path is written in, because the kernel cannot know and every editor card
    // would otherwise have to ask a second time.
    if (method === "file.read" && result !== null && typeof result === "object") {
      const lang = languages.detect(
        typeof result.path === "string" ? result.path : (params.path ?? null),
      );
      return answer(() => response(id, { ...result, lang: lang === null ? null : lang.id }));
    }

    return answer(() => response(id, result));
  } catch (err) {
    // Errors a subsystem raises are already protocol-shaped (code + name);
    // anything else becomes a shell error rather than leaking a stack.
    if (err instanceof RpcError) {
      return answer(() => failure(id, err.code, err.rpcName, err.message, err.data));
    }
    if (err instanceof SubsystemError || (err && typeof err.code === "number" && typeof err.rpcName === "string")) {
      return answer(() => failure(id, err.code, err.rpcName, err.message));
    }
    const rpc = new RpcError({ code: -32603, name: "SHELL_ERROR", message: err && err.message }, method);
    return answer(() => failure(id, rpc.code, rpc.rpcName, rpc.message, rpc.data));
  }
}

/* ------------------------------------------------------------------ */
/* the child-process channel                                           */
/* ------------------------------------------------------------------ */

/**
 * The seam between the subsystem host and the kernel's process layer.
 *
 * `SubsystemHost` wants a channel factory: something that turns
 * `{command, cwd}` into `{write, onOutput, onExit, kill}`.  The kernel offers
 * five methods and two notifications instead.  This class is that adapter --
 * and deliberately nothing more.  It does not decide when to start a process
 * (the host does), it does not parse what the process says (the subsystem
 * does), and it holds no opinion about what may be launched (the descriptor
 * does).  Replacing the kernel means replacing this file and nothing else.
 *
 * Output can arrive before the `proc.start` reply is read: the kernel writes
 * the reply first, but Node hands the shell whole chunks, so both lines can
 * land in the same read.  Events for a run nobody has claimed yet are parked
 * here and replayed when the channel learns its `run_id`.  The parking lot is
 * bounded, because a run nobody claims is one this shell has forgotten.
 */
class ProcChannels {
  #kernel;
  #byRun = new Map();
  #parked = [];
  #off;

  constructor(kernel) {
    this.#kernel = kernel;
    this.#off = kernel.onNotification((event) => this.#onEvent(event));
  }

  #onEvent(event) {
    const runId = event.run_id;
    if (event.event === "proc.output") {
      const channel = this.#byRun.get(runId);
      if (channel !== undefined) {
        channel.deliverOutput(event.data, event.stream);
        return;
      }
      this.#parked.push(event);
      if (this.#parked.length > 64) this.#parked.shift();
      return;
    }
    if (event.event === "proc.exit") {
      const channel = this.#byRun.get(runId);
      if (channel === undefined) return;
      this.#byRun.delete(runId);
      channel.deliverExit(event.code);
    }
  }

  /** The factory `SubsystemHost` is handed as `spawn`. */
  open(spec) {
    return new ProcChannel(this, this.#kernel, spec);
  }

  /** Called by a channel once `proc.start` has answered. */
  claim(runId, channel) {
    this.#byRun.set(runId, channel);
    const stillParked = [];
    for (const event of this.#parked) {
      if (event.run_id === runId) channel.deliverOutput(event.data, event.stream);
      else stillParked.push(event);
    }
    this.#parked = stillParked;
  }

  forget(runId) {
    if (runId !== null && runId !== undefined) this.#byRun.delete(runId);
  }

  close() {
    if (this.#off) this.#off();
    this.#off = null;
    this.#byRun.clear();
    this.#parked = [];
  }
}

/** One child process, seen from the shell as a duplex channel. */
class ProcChannel {
  #channels;
  #kernel;
  #runId = null;
  #outputs = [];
  #exits = [];
  #exited = null;
  #started;

  constructor(channels, kernel, spec) {
    this.#channels = channels;
    this.#kernel = kernel;
    const cwd = typeof spec.cwd === "string" && spec.cwd !== "" ? spec.cwd : ".";
    // `spec.env` is deliberately not passed on: the kernel starts a process,
    // it does not invent an environment for one.  A subsystem that needs a
    // variable says so in its own command line.
    this.#started = kernel.call("proc.start", { cmd: spec.command, cwd })
      .then((result) => {
        this.#runId = result.run_id;
        this.#channels.claim(this.#runId, this);
        return this.#runId;
      })
      .catch((err) => {
        this.#channels.forget(this.#runId);
        throw err;
      });
    // A caller that writes before awaiting must not take the whole shell down
    // with an unhandled rejection; whoever awaits `write` still sees it.
    this.#started.catch(() => {});
  }

  get runId() {
    return this.#runId;
  }

  /** The host's name for "output arrived". */
  deliverOutput(data, stream) {
    for (const cb of this.#outputs) {
      try {
        cb(data, stream);
      } catch {
        // One subsystem's listener must not stop the others.
      }
    }
  }

  /** The host's name for "the process ended". */
  deliverExit(code) {
    this.#exited = code;
    for (const cb of this.#exits) {
      try {
        cb(code);
      } catch {
        // as above
      }
    }
  }

  write(text) {
    return this.#started.then(() => this.#kernel.call("proc.send", {
      run_id: this.#runId,
      data: String(text),
    }));
  }

  /** Says "no more input" without killing the process. */
  closeInput() {
    return this.#started.then(() => this.#kernel.call("proc.close", { run_id: this.#runId }));
  }

  kill() {
    return this.#started
      .then(() => this.#kernel.call("proc.stop", { run_id: this.#runId }))
      .catch(() => {});
  }

  onOutput(cb) {
    if (typeof cb === "function") this.#outputs.push(cb);
  }
  onExit(cb) {
    if (typeof cb !== "function") return;
    this.#exits.push(cb);
    if (this.#exited !== null) cb(this.#exited);
  }
}

function parseFrame(text) {
  try {
    return { frame: JSON.parse(text) };
  } catch (err) {
    return { error: failure(null, -32700, "PARSE_ERROR", `offset 0: ${err && err.message}`) };
  }
}

/* ------------------------------------------------------------------ */
/* mode: rpc -- stdio front end                                        */
/* ------------------------------------------------------------------ */

function writeStdout(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function runRpc(options) {
  const kernel = new Kernel(options);
  // Diagnostics belong on stderr: stdout carries protocol frames and nothing
  // else, so a client can parse it without filtering.
  const languages = await loadLanguages(LANGS_DIR, (message) => {
    process.stderr.write(`[shell] ${message}\n`);
  });
  await kernel.start();
  const procs = new ProcChannels(kernel);
  const subsystems = new SubsystemHost({
    descriptors: loadSubsystems(SUBSYSTEMS_DIR, (message) => {
      process.stderr.write(`[shell] ${message}\n`);
    }),
    onEvent: (event) => writeStdout(event),
    spawn: (spec) => procs.open(spec),
    root: path.resolve(options.workspace),
  });
  if (options.verbose) {
    process.stderr.write(`[shell] rpc on ${kernel.exe} (workspace ${kernel.workspace})\n`);
  }

  // Anything the kernel says on its own account goes straight out.
  kernel.onNotification((event) => writeStdout(event));

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const text = line.trim();
      if (text === "") continue;   // keep-alive

      const { frame, error } = parseFrame(text);
      if (error) {
        writeStdout(error);
        continue;
      }

      // Sequential on purpose: the kernel answers one frame at a time, and a
      // client that pipelines still gets its replies in order.
      const reply = await dispatch(frame, kernel, languages, subsystems);
      if (reply !== null) writeStdout(reply);
    }
  } finally {
    // Whatever ends the loop -- EOF, an error, a signal -- the kernel child
    // goes with it, and so does anything a subsystem started.  The stop is
    // awaited so the `proc.stop` calls reach the kernel before it is closed;
    // closing the channel router first would drop their exits on the floor.
    try {
      await subsystems.stopAll();
    } catch {
      // Nothing to do about it: the kernel is about to go away regardless.
    }
    procs.close();
    kernel.close();
  }

  return 0;
}

/* ------------------------------------------------------------------ */
/* mode: serve -- HTTP + SSE + the system browser                      */
/* ------------------------------------------------------------------ */

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".woff2": "font/woff2",
};

function staticPath(urlPath) {
  const raw = urlPath.split("?")[0];
  let clean;
  try {
    clean = decodeURIComponent(raw);
  } catch {
    // Malformed percent-encoding is a bad request, not a server fault: the
    // caller turns null into a refusal instead of a 500.
    return null;
  }
  const rel = clean === "/" ? "index.html" : clean.replace(/^\/+/, "");
  const full = path.resolve(WEB_DIR, rel);
  const base = path.resolve(WEB_DIR);
  if (full !== base && !full.startsWith(base + path.sep)) {
    return null;   // traversal attempt
  }
  return full;
}

function readBody(req, limit = 64 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let settled = false;
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        // Answer instead of destroying the socket.  The rest of the body is
        // left unread, which closes the connection once the reply is out --
        // but the client gets told why, which a reset never does.
        req.pause();
        reject(Object.assign(new Error("request body is too large"), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (!settled) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
  });
}

/** The candidate browser executables, in the order a Windows box has them. */
function browserCandidates() {
  const list = [];
  if (process.env.SEIDE_BROWSER) list.push(process.env.SEIDE_BROWSER);
  const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
  const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const local = process.env["LOCALAPPDATA"] ?? "";
  list.push(
    path.join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Microsoft", "Edge", "Application", "msedge.exe"),
    path.join(pf, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
    path.join(local, "Google", "Chrome", "Application", "chrome.exe"),
  );
  return list;
}

function openWindow(url, { verbose = false } = {}) {
  const exe = browserCandidates().find((candidate) => candidate && existsSync(candidate));
  if (!exe) {
    process.stderr.write("seIDE: no Edge/Chromium found; open the URL printed above yourself\n");
    return null;
  }

  // A throwaway profile keeps app mode out of the user's real browser session,
  // and keeps `--app` from adopting an existing window.
  const profile = mkdtempSync(path.join(tmpdir(), "seide-profile-"));
  const args = [
    `--app=${url}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=Translate",
  ];
  if (verbose) process.stderr.write(`[shell] ${exe} ${args.join(" ")}\n`);
  const child = spawn(exe, args, { stdio: "ignore", detached: false, windowsHide: false });
  child.on("error", (err) => process.stderr.write(`seIDE: cannot launch ${exe}: ${err.message}\n`));
  return child;
}

async function runServe(options) {
  const kernel = new Kernel(options);
  const languages = await loadLanguages(LANGS_DIR, (message) => {
    process.stderr.write(`[shell] ${message}\n`);
  });
  await kernel.start();

  const subscribers = new Set();

  // Every notification -- from the kernel or from a subsystem -- is fanned out
  // to the SSE clients on the same channel, so a client needs one stream.
  const broadcast = (event) => {
    const line = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of subscribers) {
      try {
        res.write(line);
      } catch {
        subscribers.delete(res);
      }
    }
  };

  kernel.onNotification(broadcast);

  const procs = new ProcChannels(kernel);

  const subsystems = new SubsystemHost({
    descriptors: loadSubsystems(SUBSYSTEMS_DIR, (message) => {
      process.stderr.write(`[shell] ${message}\n`);
    }),
    onEvent: broadcast,
    spawn: (spec) => procs.open(spec),
    root: path.resolve(options.workspace),
  });

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      if (!res.headersSent) {
        res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
      }
      res.end(`shell error: ${err && err.message}\n`);
    });
  });

  async function handleRequest(req, res) {
    const url = req.url ?? "/";

    // Loopback is not a security boundary.  Any page the user happens to have
    // open can POST to this port -- a CORS "simple" request needs no
    // preflight -- and this endpoint writes files and starts processes.  A
    // browser does send `Origin` on cross-origin POSTs, so a request that
    // names a different origin is refused.  A request with no `Origin` is a
    // local tool (curl, the test suite), which is exactly who should be here.
    const origin = req.headers.origin;
    if (typeof origin === "string" && origin !== "" && origin !== `http://${req.headers.host}`) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("cross-origin requests are refused\n");
      return;
    }

    if (req.method === "GET" && url.split("?")[0] === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
        "x-accel-buffering": "no",
      });
      res.write(": seide events\n\n");
      subscribers.add(res);

      const beat = setInterval(() => {
        try {
          res.write(": keep-alive\n\n");
        } catch {
          clearInterval(beat);
        }
      }, 15000);
      beat.unref?.();

      req.on("close", () => {
        clearInterval(beat);
        subscribers.delete(res);
      });
      return;
    }

    if (req.method === "POST" && url.split("?")[0] === "/rpc") {
      let frame;
      try {
        frame = JSON.parse(await readBody(req));
      } catch (err) {
        // An oversized body gets an answer, not a destroyed socket: a reset
        // tells the client nothing at all, and the connection is still able
        // to carry a status line.
        const tooLarge = err && err.status === 413;
        res.writeHead(tooLarge ? 413 : 400, { "content-type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(tooLarge
          ? failure(null, -32600, "REQUEST_TOO_LARGE", "request body is too large")
          : failure(null, -32700, "PARSE_ERROR", `offset 0: ${err && err.message}`)));
        return;
      }

      const reply = await dispatch(frame, kernel, languages, subsystems);
      // A notification is answered with 204: HTTP always needs a status, but
      // there is no response frame to give.
      if (reply === null) {
        res.writeHead(204, { "cache-control": "no-store" });
        res.end();
        return;
      }
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      res.end(JSON.stringify(reply));
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, { allow: "GET, HEAD, POST" });
      res.end("method not allowed\n");
      return;
    }

    const full = staticPath(url);
    if (full === null) {
      res.writeHead(403);
      res.end("forbidden\n");
      return;
    }

    let info = null;
    try {
      info = statSync(full);
    } catch {
      info = null;
    }
    if (info === null || !info.isFile()) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end(`not found: ${url}\n`);
      return;
    }

    const type = MIME[path.extname(full).toLowerCase()] ?? "application/octet-stream";
    res.writeHead(200, {
      "content-type": type,
      "content-length": info.size,
      "cache-control": "no-store",
    });
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    res.end(await readFile(full));
  }

  let browser = null;
  const shutdown = () => {
    if (browser && browser.exitCode === null) {
      try {
        browser.kill();
      } catch {
        /* ignore */
      }
    }
    // A subsystem that is still starting gets one turn to stop; the shell is
    // about to end either way, so the channel router closes with it and the
    // exits still in flight are nobody's business any more.
    void subsystems.stopAll().catch(() => {});
    procs.close();
    for (const res of subscribers) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    subscribers.clear();
    server.close();
    kernel.close();
  };

  process.once("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.once("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(options.port, "127.0.0.1", resolve);
    });
  } catch (err) {
    // A port that is already taken must not leave a kernel child behind: its
    // pipes keep this process alive, so the failure would hang instead of
    // exiting with the error that explains it.
    kernel.close();
    throw err;
  }

  const address = server.address();
  const url = `http://127.0.0.1:${address.port}/`;

  process.stdout.write(`seIDE ${SHELL_VERSION}\n`);
  process.stdout.write(`  board   ${url}\n`);
  process.stdout.write(`  kernel  ${kernel.exe}\n`);
  process.stdout.write(`  root    ${kernel.workspace}\n`);
  process.stdout.write(`  langs   ${languages.available ? LANGS_DIR : "(none -- plain text)"}\n`);
  const known = subsystems.list();
  process.stdout.write(`  subsys  ${known.length === 0
    ? "(none -- no subsystems/)"
    : known.map((s) => `${s.id} (${s.state})`).join(", ")}\n`);

  if (!options.noOpen) {
    browser = openWindow(url, options);
  }

  // Closing the window ends the session: no orphaned kernel, no orphaned port.
  if (browser) {
    browser.once("exit", () => {
      shutdown();
      process.exit(0);
    });
  }
  server.once("close", () => kernel.close());

  return new Promise(() => {});
}

/* ------------------------------------------------------------------ */
/* command line                                                        */
/* ------------------------------------------------------------------ */

const USAGE = `seIDE shell ${SHELL_VERSION}

usage: node shell/main.mjs <command> [options]

  rpc     [--workspace DIR] [--kernel PATH] [--timeout-ms N] [--verbose]
          Speak newline-delimited JSON-RPC on stdin/stdout.  Forwards to the
          kernel; answers lang.list and lang.tokenize from langs/; answers
          subsystem.list/start/stop/request from subsystems/; adds the
          \`langs\` member to workspace.info.

  serve   [--workspace DIR] [--kernel PATH] [--port N] [--no-open]
          [--timeout-ms N] [--verbose]
          Serve shell/web/ over HTTP with POST /rpc and GET /events, then
          launch the system browser in --app= mode.  --port 0 (default) picks
          a free port; --no-open skips the browser.  Kernel and subsystem
          notifications share the one event stream.

  help    This text.

--timeout-ms N is how long this side waits for one kernel call before giving
up (default ${DEFAULT_TIMEOUT_MS}).  Giving up does not cancel the call.

The window is the system's Edge/Chromium in app mode.  There is no Electron
and no bundled browser: a fork that wants a real native shell replaces this
file, not the kernel.
`;

function parseArgs(argv) {
  const options = {
    command: null,
    workspace: process.cwd(),
    kernel: null,
    port: 0,
    noOpen: false,
    verbose: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    help: false,
  };

  const takesValue = new Set(["--workspace", "--kernel", "--port", "--timeout-ms"]);
  const rest = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--no-open") {
      options.noOpen = true;
    } else if (arg.startsWith("--") && arg.includes("=")) {
      const [name, value] = [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)];
      if (!takesValue.has(name)) throw new Error(`unknown option: ${name}`);
      applyOption(options, name, value);
    } else if (takesValue.has(arg)) {
      // A flag is not a value: `--workspace --no-open` used to make the
      // workspace literally "--no-open" and then fail later with something
      // unrecognisable.
      const value = argv[++i];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${arg} needs a value`);
      }
      applyOption(options, arg, value);
    } else if (arg.startsWith("--")) {
      throw new Error(`unknown option: ${arg}`);
    } else {
      rest.push(arg);
    }
  }

  options.command = rest[0] ?? (options.help ? "help" : null);
  if (rest.length > 1) {
    throw new Error(`unexpected argument: ${rest[1]}`);
  }
  options.exe = path.resolve(options.kernel ?? DEFAULT_KERNEL);
  options.workspace = path.resolve(options.workspace);
  return options;
}

function applyOption(options, name, value) {
  // `--workspace=` and `--workspace ""` both mean "I forgot the value"; taking
  // them literally would resolve to the current directory and look like it
  // worked.
  if (value === "") throw new Error(`${name} needs a value`);
  if (name === "--workspace") options.workspace = value;
  else if (name === "--kernel") options.kernel = value;
  else if (name === "--port") {
    const port = Number(value);
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`--port needs a number between 0 and 65535, got ${value}`);
    }
    options.port = port;
  } else if (name === "--timeout-ms") {
    const timeoutMs = Number(value);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100) {
      throw new Error(`--timeout-ms needs a whole number of milliseconds >= 100, got ${value}`);
    }
    options.timeoutMs = timeoutMs;
  }
}

export async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`seIDE: ${err.message}\n\n${USAGE}`);
    return 2;
  }

  if (options.help || options.command === "help" || options.command === null) {
    process.stdout.write(USAGE);
    return options.command === null && !options.help ? 2 : 0;
  }

  try {
    if (options.command === "rpc") return await runRpc(options);
    if (options.command === "serve") return await runServe(options);
  } catch (err) {
    process.stderr.write(`seIDE: ${err && err.message ? err.message : err}\n`);
    return 1;
  }

  process.stderr.write(`seIDE: unknown command: ${options.command}\n\n${USAGE}`);
  return 2;
}

// Only run when executed, so the module can also be imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => {
    if (code !== 0) process.exitCode = code;
  });
}
