/**
 * host.mjs -- the subsystem host: descriptors, lifecycle, request routing.
 *
 * A *subsystem* is a capability the editor needs but the kernel must not know
 * about: completion, diagnostics, formatting, debugging, a terminal, version
 * control.  The kernel's part is a duplex child-process channel
 * (`core/include/port.h`); everything a client asks a subsystem *for* is
 * answered here, outside the kernel, exactly as the language layer answers
 * `lang.tokenize`.
 *
 * This file is deliberately transport-free.  A builtin subsystem runs in this
 * process; a process subsystem is handed a *channel factory* by whoever owns
 * child processes (today: nobody -- see `docs/SUBSYSTEMS.md`, "Where the
 * process comes from").  That is the one seam the host does not decide.
 */

import { readdirSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";

/* ------------------------------------------------------------------ */
/* the vocabulary                                                      */
/* ------------------------------------------------------------------ */

export const SUBSYSTEM_KINDS = ["builtin", "process"];
export const SUBSYSTEM_STATES = ["stopped", "starting", "running", "stopping", "failed"];

/**
 * Capabilities are a closed list on purpose: a descriptor that claims a
 * capability no client can ask for is a typo, not a promise, and silently
 * accepting it is how descriptors rot.
 */
export const CAPABILITIES = [
  "completion",
  "diagnostics",
  "hover",
  "definition",
  "format",
  "rename",
  "debug",
  "terminal",
  "vcs",
];

export const DESCRIPTOR_KEYS = [
  "id",
  "title",
  "kind",
  "module",
  "capabilities",
  "autostart",
  "launch",
  "description",
];

/** Codes the shell reports for this layer.  They never reach the kernel. */
export const SUBSYSTEM_CODES = {
  UNKNOWN_SUBSYSTEM: -32011,
  SUBSYSTEM_FAILED: -32012,
  SUBSYSTEM_TIMEOUT: -32013,
  SUBSYSTEM_UNSUPPORTED: -32014,
};

export class SubsystemError extends Error {
  constructor(message, { code = -32603, name = "SUBSYSTEM_ERROR", subsystem = null } = {}) {
    super(message);
    this.name = "SubsystemError";
    this.code = code;
    this.rpcName = name;
    this.subsystem = subsystem;
  }
}

function fail(message, name, subsystem) {
  return new SubsystemError(message, { code: SUBSYSTEM_CODES[name] ?? -32603, name, subsystem });
}

/* ------------------------------------------------------------------ */
/* the descriptor grammar (frozen)                                     */
/* ------------------------------------------------------------------ */

/**
 * One `key value` per line.  A line whose *first* byte is `#` is a comment; an
 * indented `#` is not.  An unknown key is a hard error.
 */
export function parseDescriptor(text, source = "<descriptor>") {
  const where = (line) => `${source}:${line}`;
  const seen = new Map();

  text.split(/\r\n|\n|\r/).forEach((raw, index) => {
    const line = index + 1;
    if (raw === "" || raw.startsWith("#")) return;
    const match = /^([a-z_]+)(?:[ \t]+(.*))?$/.exec(raw);
    if (match === null) {
      throw new Error(`${where(line)}: expected \`key value\`, found ${JSON.stringify(raw)}`);
    }
    const key = match[1];
    const value = (match[2] ?? "").trim();
    if (!DESCRIPTOR_KEYS.includes(key)) {
      throw new Error(`${where(line)}: unknown key \`${key}\` (known: ${DESCRIPTOR_KEYS.join(", ")})`);
    }
    if (value === "") {
      throw new Error(`${where(line)}: \`${key}\` needs a value`);
    }
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push({ value, line });
  });

  const one = (key) => {
    const all = seen.get(key) ?? [];
    if (all.length === 0) return null;
    if (all.length > 1) {
      throw new Error(`${where(all[1].line)}: \`${key}\` appears twice`);
    }
    return all[0].value;
  };
  const many = (key) => (seen.get(key) ?? []).map((entry) => entry.value);

  const id = one("id");
  if (id === null) throw new Error(`${where(1)}: no \`id\``);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    throw new Error(`${where(1)}: \`id\` must be lowercase letters, digits or \`-\`, found ${JSON.stringify(id)}`);
  }

  const kind = one("kind");
  if (kind === null) throw new Error(`${where(1)}: subsystem \`${id}\` has no \`kind\``);
  if (!SUBSYSTEM_KINDS.includes(kind)) {
    throw new Error(`${where(1)}: \`kind ${kind}\` is not one of ${SUBSYSTEM_KINDS.join(", ")}`);
  }

  const module = one("module");
  if (module === null) throw new Error(`${where(1)}: subsystem \`${id}\` has no \`module\``);
  if (path.isAbsolute(module) || module.includes("/") || module.includes("\\")) {
    throw new Error(`${where(1)}: \`module ${module}\` must be a bare file name in this directory`);
  }

  const capabilities = many("capabilities");
  for (const entry of seen.get("capabilities") ?? []) {
    for (const capability of entry.value.split(/[ \t]+/)) {
      if (!CAPABILITIES.includes(capability)) {
        throw new Error(
          `${where(entry.line)}: unknown capability \`${capability}\` (known: ${CAPABILITIES.join(", ")})`,
        );
      }
    }
  }

  const autostartRaw = one("autostart");
  if (autostartRaw !== null && autostartRaw !== "yes" && autostartRaw !== "no") {
    throw new Error(`${where(1)}: \`autostart ${autostartRaw}\` must be \`yes\` or \`no\``);
  }

  const launch = one("launch");
  if (launch !== null && kind !== "process") {
    throw new Error(`${where(1)}: \`launch\` is a process-subsystem key, but \`kind\` is \`${kind}\``);
  }

  /**
   * A builtin is started when it is first needed; a process is not, because
   * spawning a server is a decision the user should be able to make.  Both can
   * be overridden with `autostart`.
   */
  const automatic = autostartRaw === null ? kind === "builtin" : autostartRaw === "yes";

  return {
    id,
    title: one("title") ?? id,
    kind,
    module,
    capabilities: [...new Set(capabilities.flatMap((value) => value.split(/[ \t]+/)))],
    autostart: automatic,
    launch,
    description: one("description"),
    source,
  };
}

function descriptorFile(text, name) {
  return name.endsWith(".sub");
}

/**
 * Reads `dir` and returns every conforming descriptor.  A broken descriptor is
 * reported and skipped, not thrown: one typo must not take the whole layer
 * down.  `onError(message)` receives each complaint.
 */
export function loadSubsystems(dir, { onError = null } = {}) {
  let names;
  try {
    names = readdirSync(dir);
  } catch (err) {
    if (onError) onError(`cannot read ${dir}: ${err && err.message}`);
    return [];
  }

  const descriptors = [];
  const ids = new Set();
  for (const name of names.sort()) {
    if (!descriptorFile(null, name)) continue;
    const full = path.join(dir, name);
    let descriptor;
    try {
      descriptor = parseDescriptor(readFileSync(full, "utf8"), name);
    } catch (err) {
      if (onError) onError(`${name}: ${err && err.message}`);
      continue;
    }
    descriptor.source = full;   // a module is resolved next to its descriptor
    descriptor.file = name;
    const expected = `${descriptor.id}.sub`;
    if (name !== expected) {
      if (onError) onError(`${name}: \`id ${descriptor.id}\` wants the file to be named \`${expected}\``);
      continue;
    }
    if (ids.has(descriptor.id)) {
      if (onError) onError(`${name}: two descriptors claim the id \`${descriptor.id}\``);
      continue;
    }
    ids.add(descriptor.id);
    descriptors.push(descriptor);
  }
  return descriptors;
}

/* ------------------------------------------------------------------ */
/* the host                                                            */
/* ------------------------------------------------------------------ */

/**
 * Owns one instance per descriptor.  Nothing starts until someone asks for it,
 * so a subsystem that is never used costs one parsed file.
 *
 * `spawn(spec)` is the injected channel factory for `kind: "process"`:
 *
 *     spawn({ subsystem, command, cwd, env }) -> channel
 *
 * A channel is `{ write(text), onOutput(cb), onExit(cb), kill() }`.  With no
 * factory the host still loads, lists and starts builtins; a process subsystem
 * answers `SUBSYSTEM_UNSUPPORTED` and says why.
 */
export class SubsystemHost {
  constructor({
    descriptors = [],
    spawn = null,
    importModule = (url) => import(url),
    onEvent = null,
    requestTimeoutMs = 5000,
  } = {}) {
    this.descriptors = new Map(descriptors.map((descriptor) => [descriptor.id, descriptor]));
    this.spawn = typeof spawn === "function" ? spawn : null;
    this.importModule = importModule;
    this.onEvent = typeof onEvent === "function" ? onEvent : () => {};
    this.requestTimeoutMs = requestTimeoutMs;
    this.instances = new Map();
  }

  descriptor(id) {
    return this.descriptors.get(id) ?? null;
  }

  /** The wire form of `subsystem.list`: one entry per descriptor, always. */
  list() {
    return [...this.descriptors.values()]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((descriptor) => {
        const instance = this.instances.get(descriptor.id);
        return {
          id: descriptor.id,
          title: descriptor.title,
          kind: descriptor.kind,
          capabilities: descriptor.capabilities,
          state: instance ? instance.state : "stopped",
        };
      });
  }

  state(id) {
    const instance = this.instances.get(id);
    return instance ? instance.state : "stopped";
  }

  #emit(event) {
    try {
      this.onEvent(event);
    } catch {
      /* an observer that throws must not take the host down */
    }
  }

  #setState(instance, state, reason) {
    if (instance.state === state) return;
    instance.state = state;
    const event = { event: "subsystem.state", id: instance.descriptor.id, state };
    if (reason !== undefined) event.reason = reason;
    this.#emit(event);
  }

  /** Builds the adapter once, and only when it is first needed. */
  async #adapter(instance) {
    if (instance.adapter !== null) return instance.adapter;

    const descriptor = instance.descriptor;
    const url = pathToFileURL(path.join(path.dirname(descriptor.source), descriptor.module)).href;
    let module;
    try {
      module = await this.importModule(url);
    } catch (err) {
      throw fail(
        `subsystem \`${descriptor.id}\` cannot load ${descriptor.module}: ${err && err.message}`,
        "SUBSYSTEM_FAILED",
        descriptor.id,
      );
    }
    if (typeof module.create !== "function") {
      throw fail(
        `subsystem \`${descriptor.id}\` does not export \`create\``,
        "SUBSYSTEM_FAILED",
        descriptor.id,
      );
    }

    const context = {
      id: descriptor.id,
      descriptor,
      log: (message) => this.#emit({ event: "subsystem.log", id: descriptor.id, message: String(message) }),
      emit: (event) => this.#emit({ ...event, id: descriptor.id }),
      spawn: (spec) => {
        if (this.spawn === null) {
          throw fail(
            `subsystem \`${descriptor.id}\` is a process subsystem and this shell has no process channel`,
            "SUBSYSTEM_UNSUPPORTED",
            descriptor.id,
          );
        }
        return this.spawn({ ...spec, subsystem: descriptor.id });
      },
    };

    try {
      instance.adapter = await module.create(context);
    } catch (err) {
      throw err instanceof SubsystemError
        ? err
        : fail(
            `subsystem \`${descriptor.id}\` failed to load: ${err && err.message}`,
            "SUBSYSTEM_FAILED",
            descriptor.id,
          );
    }
    return instance.adapter;
  }

  #instance(id) {
    const descriptor = this.descriptors.get(id);
    if (descriptor === undefined) {
      throw fail(`no subsystem named \`${id}\``, "UNKNOWN_SUBSYSTEM", null);
    }
    if (!this.instances.has(id)) {
      this.instances.set(id, { descriptor, state: "stopped", adapter: null, starting: null });
    }
    return this.instances.get(id);
  }

  /**
   * Starts a subsystem, once.  Concurrent callers share the first attempt, so a
   * client that asks twice does not spawn two servers.
   */
  async start(id, params = {}) {
    const instance = this.#instance(id);
    if (instance.state === "running") return { id, state: "running" };
    if (instance.starting !== null) return instance.starting;

    instance.starting = (async () => {
      if (instance.descriptor.kind === "process" && this.spawn === null) {
        const message = `subsystem \`${id}\` is a process subsystem and this shell has no process channel`;
        this.#setState(instance, "failed", message);
        throw fail(message, "SUBSYSTEM_UNSUPPORTED", id);
      }
      this.#setState(instance, "starting");
      try {
        const adapter = await this.#adapter(instance);
        if (typeof adapter.start === "function") await adapter.start(params);
        this.#setState(instance, "running");
        return { id, state: "running" };
      } catch (err) {
        const message = err instanceof SubsystemError ? err.message : `${err && err.message}`;
        this.#setState(instance, "failed", message);
        throw err instanceof SubsystemError
          ? err
          : fail(`subsystem \`${id}\` failed to start: ${message}`, "SUBSYSTEM_FAILED", id);
      } finally {
        instance.starting = null;
      }
    })();

    return instance.starting;
  }

  async stop(id) {
    const instance = this.#instance(id);
    if (instance.state === "stopped") return { id, state: "stopped" };
    this.#setState(instance, "stopping");
    try {
      if (instance.adapter !== null && typeof instance.adapter.stop === "function") {
        await instance.adapter.stop();
      }
      this.#setState(instance, "stopped");
      return { id, state: "stopped" };
    } catch (err) {
      const message = err instanceof SubsystemError ? err.message : `${err && err.message}`;
      this.#setState(instance, "failed", message);
      throw fail(`subsystem \`${id}\` failed to stop: ${message}`, "SUBSYSTEM_FAILED", id);
    }
  }

  /**
   * Routes one request.  A subsystem that is not running is started first when
   * its descriptor allows it, because a client asking a question is a client
   * that wants the answer, not a state machine.
   */
  async request(id, method, params = {}) {
    if (typeof method !== "string" || method === "") {
      throw fail("`method` must be a non-empty string", "SUBSYSTEM_FAILED", id);
    }
    const instance = this.#instance(id);
    if (instance.state !== "running") {
      if (!instance.descriptor.autostart) {
        throw fail(
          `subsystem \`${id}\` is not running (\`autostart no\`); call subsystem.start first`,
          "SUBSYSTEM_FAILED",
          id,
        );
      }
      await this.start(id);
    }

    const adapter = instance.adapter;
    if (adapter === null || typeof adapter.request !== "function") {
      throw fail(`subsystem \`${id}\` does not answer requests`, "SUBSYSTEM_UNSUPPORTED", id);
    }

    const call = Promise.resolve().then(() => adapter.request(method, params));
    if (this.requestTimeoutMs <= 0) return call;

    let timer = null;
    const timeout = new Promise((_, reject) => {
      // Deliberately not unref'd: a timeout that lets the process exit before it
      // fires is a timeout that silently never happens.
      timer = setTimeout(() => {
        reject(fail(
          `subsystem \`${id}\` did not answer \`${method}\` within ${this.requestTimeoutMs} ms`,
          "SUBSYSTEM_TIMEOUT",
          id,
        ));
      }, this.requestTimeoutMs);
    });

    try {
      return await Promise.race([call, timeout]);
    } finally {
      if (timer !== null) clearTimeout(timer);
    }
  }

  /** Stops everything that is running; used on shutdown and between tests. */
  async stopAll() {
    const running = [...this.instances.values()].filter((instance) => instance.state !== "stopped");
    const results = await Promise.allSettled(running.map((instance) => this.stop(instance.descriptor.id)));
    return results.length;
  }
}
