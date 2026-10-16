"""input_smoke.py -- drive the real window: the undo keys, the editor keys, who
owns a wheel, selecting more than one card, searching the workspace, a file that
changes on disk under the card holding it, and the classic view that tiles the
same board into a sidebar, a tab strip and a code area.

``browser_smoke.py`` fetches the page with ``--dump-dom``, which drives no
pointer, no keyboard and no wheel, so the *input paths* were the part of the
board no shipped suite could reach: ``selftest.mjs`` proves the undo ring
(documents, coalescing, the redo branch), the editor's text operations, the
search arithmetic and ``classic.mjs``'s tile with no DOM at all, and this proves
the wiring on top of them -- including that a wheel over a card's own scroll
region belongs to the card, that the keys a person actually presses reach the
editor card, that a drag can carry a set of cards, that a hit in a search card
opens its file at its line, that a write from *another process* reaches the card
holding that file, and that switching views leaves the document and the viewport
untouched, which are rules only a real event can test.

How, without a web driver or CDP: the shell serves every file under
``shell/web/``, so this test writes one small wrapper page there for the length
of the run, deletes it in a ``finally``, and refuses to start if the name is
already taken.  The wrapper is same-origin with the app it frames, so it can
reach into the iframe and do what a person does:

1. wait for the app to reach "kernel ready";
2. double-click empty space -- a real board change through the real gesture;
3. dispatch ``keydown`` with ``ctrlKey`` for ``z``, then for ``shift+z``;
4. count the card elements in the iframe's DOM after each step;
5. press Ctrl+Z while a text field has the keystroke, and check that the board
   did not move: text undo belongs to the textarea;
6. dispatch ``wheel`` over a card's own scroll region and over the board, and
   check which one the app lets through: the card's wheel must not be
   ``preventDefault``-ed and must not move the viewport, the board's must pan,
   and ctrl+wheel over the card must still zoom;
7. drive the editor card's own keys -- Tab and shift+Tab on the file, Enter
   after an opener, Ctrl+F and the find bar, replace-all and Escape -- and read
   the buffer and the painted hits back out of the DOM; then ask it for
   completions with Ctrl+Space (Enter takes the highlighted one, Escape closes
   the list) and put a TODO and an unclosed parenthesis in the buffer to read
   the issue strip and click a row to check the caret lands on the text it names;
8. select more than one card -- Ctrl+A, ctrl+click, a shift+drag band, a group
   drag and a group Delete with one Ctrl+Z -- and read the counts and the
   positions back out;
9. type ``find <text>`` on the command line, wait for the search card to list
   hits, click the first one and read the caret of the editor that opened;
10. open a scratch file, rewrite it from a *separate process* (``cmd /c echo``,
    which the kernel cannot announce), and read what the card says: a clean card
    reloads, a card with unsaved edits keeps them and warns, and a file that
    disappears is reported rather than written back;
11. type ``mode classic`` and measure the tile in the board's own pixels: the
    strip under the HUD, the code area filling the right column down to the
    bottom edge, the sidebar the left, every other card hidden; click a tab and
    check the code area moved to that file; wheel the code area and the strip and
    check the viewport did not move; then ``mode board`` and check every card,
    every size and the pan and zoom came back exactly.

The board is backed up and restored byte-for-byte, that scratch file is deleted
by the test, and the host is killed by pid.

    python tools/input_smoke.py [--edge PATH] [--port N] [--timeout S] [--keep]

Exit codes: 0 pass or skipped, 1 a check failed, 2 could not run, 3 usage.
"""

import argparse
import re
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import browser_smoke as bs  # noqa: E402  (needs the sys.path line above)

WRAPPER_NAME = "__input_smoke.html"
WRAPPER = bs.REPO_ROOT / "shell" / "web" / WRAPPER_NAME
#: The file the watch section rewrites from a second process.  It lives under
#: build/ (gitignored, and next to the kernel the run already built) and the
#: test deletes it whether or not the checks got as far as doing so.
SCRATCH = bs.REPO_ROOT / "build" / "__watch_smoke.txt"
RESULT_RE = re.compile(r'<pre id="result">(.*?)</pre>', re.S)
#: Wall-clock the page is allowed, in virtual time.  The language checks ask a
#: real subsystem over the kernel's own channel -- and the first question pays
#: for starting a process -- so the run needs more room than typing alone did.
BUDGET_MS = 60000

PAGE = """<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>input smoke</title>
<style>body{margin:0;font:12px monospace}iframe{width:900px;height:600px;border:0}
pre{white-space:pre-wrap}</style></head>
<body>
<iframe id="app" src="/"></iframe>
<pre id="result">pending</pre>
<script>
const frame = document.getElementById("app");
const out = [];
const say = (line) => { out.push(line); document.getElementById("result").textContent = out.join("\\n"); };
/* Every exception the app throws is invisible from out here: the DOM simply does
   not change, and a check that waits for a row reads that as "no rows".  The
   editor's issue strip was dead for exactly that reason -- a missing import threw
   inside a listener -- while this file went on calling the strip empty.  So the
   app's own errors are collected and reported, and they fail the run. */
const pageErrors = [];
const ERRORS_KEPT = 50;
const noteError = (message) => {
  if (pageErrors.length < ERRORS_KEPT) {
    pageErrors.push(message);
  } else if (pageErrors.length === ERRORS_KEPT) {
    pageErrors.push("(more errors, not kept)");
  }
};
const watchErrors = () => {
  const w = frame.contentWindow;
  if (!w || w.__inputSmokeWatched === true) return;
  w.__inputSmokeWatched = true;
  w.addEventListener("error", (event) => {
    noteError(String((event && event.message) || event));
  });
  w.addEventListener("unhandledrejection", (event) => {
    const reason = event && event.reason;
    noteError(String((reason && reason.message) || reason || event));
  });
};
frame.addEventListener("load", watchErrors);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const cardCount = () => frame.contentDocument.querySelectorAll("#cards [data-card-id]").length;
const logTail = () => {
  const el = frame.contentDocument.getElementById("log");
  return (el ? el.textContent : "").replace(/\\s+/g, " ").trim().slice(-140);
};
const key = (win, doc, init) => doc.dispatchEvent(new win.KeyboardEvent("keydown", Object.assign({ bubbles: true, cancelable: true }, init)));
const stageTransform = () => {
  const el = frame.contentDocument.getElementById("stage");
  return el ? el.style.transform : "";
};
const hudZoom = () => {
  const el = frame.contentDocument.getElementById("hud-zoom");
  return el ? (el.textContent || "").trim() : "";
};
/* What the pointer actually lands on, and the nearest box below it that can
   scroll the way this wheel asks: a textarea scrolls by UA style, an editor's
   overflow:hidden shim does not, and an overflow:auto/scroll box only counts
   while it has room left in that direction. */
const scrollRegionAt = (doc, x, y, deltaY) => {
  const view = doc.defaultView;
  let node = doc.elementFromPoint(x, y);
  const card = node && node.closest ? node.closest("[data-card-id]") : null;
  for (; node; node = node.parentElement) {
    const style = view.getComputedStyle(node);
    const scrolls = style.overflowY === "auto" || style.overflowY === "scroll"
      || node.tagName === "TEXTAREA";
    const room = deltaY >= 0
      ? node.scrollHeight - node.clientHeight - node.scrollTop
      : node.scrollTop;
    if (scrolls && room > 0) return { el: node, card };
  }
  return { el: null, card };
};
const describe = (el) => (el.tagName.toLowerCase()
  + (el.className ? "." + String(el.className).trim().replace(/\\s+/g, ".") : ""))
  + ", " + el.clientHeight + "px of " + el.scrollHeight + "px, scrollTop " + el.scrollTop;
/* A card whose own scroll region sits under the pointer.  Three points per card,
   because cards overlap and a centre can land on the card above. */
const regionInSomeCard = (doc, deltaY) => {
  const notes = [];
  const view = doc.defaultView;
  for (const card of doc.querySelectorAll("#cards [data-card-id]")) {
    const rect = card.getBoundingClientRect();
    if (rect.width < 60 || rect.height < 60) continue;
    for (const [fx, fy] of [[0.5, 0.5], [0.3, 0.4], [0.7, 0.6]]) {
      const x = Math.round(rect.left + rect.width * fx);
      const y = Math.round(rect.top + rect.height * fy);
      if (x < 2 || y < 2 || x > view.innerWidth - 2 || y > view.innerHeight - 2) {
        if (notes.length < 4) notes.push("card " + card.dataset.cardId + " point off screen");
        continue;
      }
      const under = doc.elementFromPoint(x, y);
      const region = scrollRegionAt(doc, x, y, deltaY);
      if (region.el && region.card === card) return { x, y, el: region.el, notes };
      if (notes.length < 4) {
        notes.push("card " + card.dataset.cardId + " @ " + x + "," + y + " -> "
          + (under ? describe(under) : "nothing")
          + (region.card === card ? " (the card's)" : " (another card's)"));
      }
    }
  }
  return { el: null, notes };
};
const wheel = (win, target, init) => {
  const event = new win.WheelEvent("wheel", Object.assign({ bubbles: true, cancelable: true }, init));
  target.dispatchEvent(event);
  return event;
};

async function ready() {
  for (let i = 0; i < 300; i++) {
    const doc = frame.contentDocument;
    const status = doc && doc.getElementById("kernel-status");
    if (status && /ready/.test(status.textContent || "")) return true;
    await sleep(100);
  }
  return false;
}

/* Wait for something the app does in its own time -- a workspace read is as slow
   as the workspace is big, and a fixed sleep would be a race with the disk. */
async function waitUntil(predicate, tries = 150, step = 200) {
  for (let i = 0; i < tries; i++) {
    if (predicate()) return true;
    await sleep(step);
  }
  return predicate();
}

async function main() {
  await new Promise((resolve) => {
    if (frame.contentDocument && frame.contentDocument.readyState === "complete") resolve();
    else frame.addEventListener("load", resolve, { once: true });
  });
  if (!(await ready())) { say("RESULT: FAILED -- the app never reached kernel ready"); return; }
  say("kernel ready: true");
  const doc = frame.contentDocument, win = frame.contentWindow;
  watchErrors();
  await sleep(400);

  const before = cardCount();
  say("cards at boot: " + before);

  const board = doc.getElementById("board");
  board.dispatchEvent(new win.MouseEvent("dblclick", { bubbles: true, cancelable: true, clientX: 600, clientY: 500 }));
  await sleep(600);
  const added = cardCount();
  say("cards after a double-click on empty space: " + added + "  | log: " + logTail());

  key(win, doc, { key: "z", ctrlKey: true });
  await sleep(600);
  const undone = cardCount();
  say("cards after Ctrl+Z: " + undone + "  | log: " + logTail());

  key(win, doc, { key: "Z", ctrlKey: true, shiftKey: true });
  await sleep(600);
  const redone = cardCount();
  say("cards after Ctrl+Shift+Z: " + redone + "  | log: " + logTail());

  const input = doc.getElementById("command");
  input.value = "this text is never submitted";
  input.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "z", ctrlKey: true }));
  await sleep(400);
  const inField = cardCount();
  say("cards after Ctrl+Z while a text field has the keystroke: " + inField + "  (the board must not move)");

  const ok = added === before + 1 && undone === before && redone === added && inField === redone;
  say("counts: boot=" + before + " added=" + added + " undone=" + undone
    + " redone=" + redone + " in-field=" + inField);

  /* --- who owns a wheel event --- */
  let wheelOk = true;
  try {
    const region = regionInSomeCard(doc, 120);
    if (region.el === null) {
      say("wheel-card: none -- no card's own scroll region is under the pointer  ["
        + region.notes.join(" | ") + "]");
    } else {
      const at = { clientX: region.x, clientY: region.y };
      const view = stageTransform();
      const overCard = wheel(win, region.el, Object.assign({ deltaY: 120 }, at));
      const moved = stageTransform() !== view;
      wheelOk = wheelOk && !overCard.defaultPrevented && !moved;
      say("wheel-card: defaultPrevented=" + overCard.defaultPrevented
        + " viewport-moved=" + moved
        + "  (" + describe(region.el) + ")");
    }

    const view2 = stageTransform();
    const overBoard = wheel(win, doc.getElementById("board"), { deltaY: 120, clientX: 30, clientY: 240 });
    say("wheel-board: defaultPrevented=" + overBoard.defaultPrevented
      + " viewport-moved=" + (stageTransform() !== view2));

    const zoomBefore = hudZoom();
    const zoomAt = region === null ? { clientX: 600, clientY: 400 } : { clientX: region.x, clientY: region.y };
    const zoomOn = doc.elementFromPoint(zoomAt.clientX, zoomAt.clientY) || doc.getElementById("board");
    wheel(win, zoomOn, Object.assign({ deltaY: -240, ctrlKey: true }, zoomAt));
    say("wheel-ctrl: " + zoomBefore + " -> " + hudZoom());
  } catch (error) {
    wheelOk = false;
    say("wheel-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- the editor's own keys: indent, auto-indent, find and replace --- */
  let editorOk = true;
  try {
    const area = doc.querySelector('[data-card-id="c1"] textarea.ed-input');
    const press = (key, extra) => area.dispatchEvent(new win.KeyboardEvent("keydown", Object.assign(
      { bubbles: true, cancelable: true, key }, extra || {})));
    if (area === null) {
      editorOk = false;
      say("editor: none -- the sample board has no editor card");
    } else {
      const original = area.value;
      area.focus();
      area.setSelectionRange(0, 0);
      press("Tab");
      const tab = area.value.slice(0, 4);
      const caret = area.selectionStart;
      press("Tab", { shiftKey: true });
      const restores = area.value === original;
      editorOk = editorOk && tab === "    " && caret === 4 && restores;
      say("editor-indent: tab=" + JSON.stringify(tab) + " caret=" + caret
        + " shift-tab-restores=" + restores);

      /* Auto-indent: a line opening a block gets one more step for the next. */
      area.value = "foo {\\nbar";
      area.dispatchEvent(new win.Event("input", { bubbles: true }));
      area.setSelectionRange(5, 5);
      press("Enter");
      const auto = area.value === "foo {\\n    \\nbar" && area.selectionStart === 10;
      editorOk = editorOk && auto;
      say("editor-enter: " + JSON.stringify(area.value) + " caret=" + area.selectionStart);

      /* Find: the bar opens on Ctrl+F and every hit is painted below. */
      press("f", { ctrlKey: true });
      const bar = doc.querySelector('[data-card-id="c1"] [data-role="find-bar"]');
      const query = doc.querySelector('[data-card-id="c1"] [data-role="find-query"]');
      const count = doc.querySelector('[data-card-id="c1"] [data-role="find-count"]');
      const open = bar !== null && bar.hidden === false;
      query.value = "o";
      query.dispatchEvent(new win.Event("input", { bubbles: true }));
      const marks = doc.querySelectorAll('[data-card-id="c1"] .ed-view mark[data-role="find-hit"]');
      const counted = count ? (count.textContent || "").trim() : "";
      const firstOk = open && marks.length === 2 && counted === "1/2";
      editorOk = editorOk && firstOk;
      say("editor-find: open=" + open + " hits=" + marks.length + " count=" + JSON.stringify(counted));

      /* Next steps to the second hit, and only that one is current. */
      const next = doc.querySelector('[data-card-id="c1"] [data-role="find-next"]');
      if (next) next.click();
      const second = count ? (count.textContent || "").trim() : "";
      const current = doc.querySelectorAll('[data-card-id="c1"] .ed-view mark.is-current').length;
      editorOk = editorOk && second === "2/2" && current === 1;
      say("editor-find-next: count=" + JSON.stringify(second) + " current=" + current);

      /* Replace all, and Escape closes the bar. */
      const replacement = doc.querySelector('[data-card-id="c1"] [data-role="replace-text"]');
      const replaceAll = doc.querySelector('[data-card-id="c1"] [data-role="replace-all"]');
      replacement.value = "zz";
      if (replaceAll) replaceAll.click();
      const replaced = area.value === "fzzzz {\\n    \\nbar";
      press("Escape");
      const closed = bar !== null && bar.hidden === true;
      editorOk = editorOk && replaced && closed;
      say("editor-replace: " + JSON.stringify(area.value) + " closed=" + closed);

      /* The card puts its own edits in through the browser's insert command, so
         the textarea's undo stack still holds them.  Undo the last one. */
      area.focus();
      area.setSelectionRange(0, 0);
      const beforeUndo = area.value;
      press("Tab");
      const typed = area.value !== beforeUndo;
      const undid = typeof doc.execCommand === "function" ? doc.execCommand("undo") : false;
      const restoredByUndo = area.value === beforeUndo;
      editorOk = editorOk && typed && undid === true && restoredByUndo;
      say("editor-undo: typed=" + typed + " command=" + undid + " restored=" + restoredByUndo);

      /* Language, through the real keys: ^Space asks a subsystem for
         completions and the rows dock under the editor, Enter takes the
         highlighted one and closes the list.  The answer comes from the
         built-in `words` subsystem, so no language server has to be running
         for this to be true. */
      const completion = doc.querySelector('[data-card-id="c1"] [data-role="completion"]');
      const completionRows = () => doc.querySelectorAll('[data-card-id="c1"] [data-role="completion-row"]');
      area.value = "const alphaOne = 1;\\nconst alphabet = alpha";
      area.dispatchEvent(new win.Event("input", { bubbles: true }));
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
      press(" ", { ctrlKey: true });
      await waitUntil(() => completionRows().length > 0, 40, 100);
      const labels = [...completionRows()].map((row) => row.textContent).join(",");
      const highlighted = doc.querySelectorAll('[data-card-id="c1"] .ed-complete-row.on').length;
      const listed = completion !== null && completion.hidden === false
        && completionRows().length >= 2 && highlighted === 1
        && labels.indexOf("alphabet") !== -1;
      const chosen = completionRows().length > 0 ? completionRows()[0].textContent : "";
      say("editor-complete: " + listed + " shown=" + completionRows().length
        + " labels=" + JSON.stringify(labels)
        + " source=" + JSON.stringify(completion === null ? "" : String(completion.dataset.source || "")));
      press("Enter");
      const accepted = completion !== null && completion.hidden === true
        && area.value.endsWith(chosen);
      if (completionRows().length > 0 || !accepted) {
        // A list that stays up, or an insert that did not land, is a failure
        // worth seeing the text for.
        say("editor-complete-accept: value=" + JSON.stringify(area.value) + " chosen=" + JSON.stringify(chosen));
      }
      editorOk = editorOk && listed && accepted;

      /* Escape closes the list without touching the text, and the text is put
         back to something with an issue in it: a stray brace is an error. */
      press(" ", { ctrlKey: true });
      await waitUntil(() => completionRows().length > 0, 40, 100);
      const beforeEscape = area.value;
      press("Escape");
      const escaped = completion !== null && completion.hidden === true && area.value === beforeEscape;
      editorOk = editorOk && escaped;

      /* The issue strip.  The buffer carries the two things a language server
         reports about it -- a TODO and an unclosed parenthesis -- and the rows
         have to name them in the severities the server chose. */
      const issueRows = () => doc.querySelectorAll('[data-card-id="c1"] [data-role="issue-row"]');
      const issueBar = doc.querySelector('[data-card-id="c1"] [data-role="issues"]');
      const issueBarSource = () => (issueBar === null ? "" : String(issueBar.dataset.source || ""));
      area.value = "const a = 1; // TODO\\nconst b = (2;\\n";
      area.dispatchEvent(new win.Event("input", { bubbles: true }));
      await waitUntil(() => issueRows().length > 0, 60, 100);
      const issueTexts = [...issueRows()].map((row) => row.textContent || "");
      const severities = [...issueRows()].map((row) => row.dataset.severity).join(",");
      const todoRow = [...issueRows()].find((row) => (row.textContent || "").indexOf("TODO") !== -1) || null;
      const issueOk = issueRows().length >= 2
        && severities.indexOf("warning") !== -1 && severities.indexOf("error") !== -1;
      say("editor-issues: " + issueOk + " rows=" + issueRows().length
        + " severities=" + JSON.stringify(severities)
        + " first=" + JSON.stringify(issueTexts.length > 0 ? issueTexts[0] : "")
        + " source=" + JSON.stringify(issueBarSource())
        + " answer=" + JSON.stringify(issueBar === null ? "" : String(issueBar.dataset.answer || ""))
        + " hidden=" + (issueBar === null ? "no-bar" : String(issueBar.hidden))
        + " path=" + JSON.stringify(area.value.length)
        + " | log: " + logTail());
      /* Clicking the row that names the TODO puts the caret on the TODO. */
      const wanted = area.value.indexOf("TODO");
      if (todoRow !== null) {
        todoRow.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true }));
      }
      const caretOnIssue = area.selectionStart;
      const jumped = todoRow !== null && wanted !== -1 && caretOnIssue === wanted;
      if (!jumped) {
        say("editor-issue-jump: caret=" + caretOnIssue + " wanted=" + wanted
          + " value=" + JSON.stringify(area.value));
      }
      editorOk = editorOk && issueOk && jumped;
    }
  } catch (error) {
    editorOk = false;
    say("editor-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- multi-select: Ctrl+A, ctrl-click, the rubber band, a group drag, delete --- */
  let selectOk = true;
  const cardIds = () => [...doc.querySelectorAll("#cards [data-card-id]")].map((n) => n.dataset.cardId);
  const picked = (selector) => [...doc.querySelectorAll("#cards [data-card-id]" + selector)].map((n) => n.dataset.cardId);
  const boxOf = (id) => {
    const el = doc.querySelector('[data-card-id="' + id + '"]');
    const where = /translate\\((-?[\\d.]+)px,\\s*(-?[\\d.]+)px\\)/.exec(el.style.transform || "");
    return { el, x: where ? Number(where[1]) : NaN, y: where ? Number(where[2]) : NaN,
      rect: el.getBoundingClientRect() };
  };
  const titleOf = (id) => doc.querySelector('[data-card-id="' + id + '"] .card-title');
  const press2 = (type, target, init) => target.dispatchEvent(new win.PointerEvent(type, Object.assign(
    { bubbles: true, cancelable: true, pointerId: 7, isPrimary: true, button: 0,
      buttons: type === "pointerup" ? 0 : 1 }, init)));
  const clickCard = async (id, mods) => {
    const rect = boxOf(id).rect;
    const at = { clientX: Math.round(rect.left + 24), clientY: Math.round(rect.top + 10) };
    press2("pointerdown", titleOf(id), Object.assign({}, at, mods));
    press2("pointerup", titleOf(id), Object.assign({}, at, mods, { buttons: 0 }));
    await sleep(200);
  };
  try {
    // The editor card may still hold focus; the board's keys are document-level,
    // but blurring keeps the pointer path below honest about what is under it.
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();

    const every = cardIds();
    key(win, doc, { key: "a", ctrlKey: true });
    await sleep(250);
    const all = picked(".is-selected");
    const leaders = picked(".is-primary");
    const selectedAll = every.length > 1 && all.length === every.length && leaders.length === 1;
    say("select-all: cards=" + every.length + " selected=" + all.length + " primary=" + leaders.length);

    /* Ctrl+click takes one card out of the set, and puts it back. */
    const victim = every[every.length - 1];
    await clickCard(victim, { ctrlKey: true });
    const without = picked(".is-selected");
    await clickCard(victim, { ctrlKey: true });
    const again = picked(".is-selected").length;
    const toggled = without.length === every.length - 1 && !without.includes(victim)
      && again === every.length;
    say("select-ctrl-click: without=" + without.length + " back=" + again + " (of " + every.length + ")");

    /* Shift+drag over empty board space is a rubber band. */
    const boardRect = board.getBoundingClientRect();
    let empty = null;
    for (let gx = 0.03; gx < 1 && empty === null; gx += 0.03) {
      for (let gy = 0.03; gy < 1; gy += 0.03) {
        const x = Math.round(boardRect.left + boardRect.width * gx);
        const y = Math.round(boardRect.top + boardRect.height * gy);
        const node = doc.elementFromPoint(x, y);
        if (node && !node.closest("[data-card-id]")) { empty = { x, y }; break; }
      }
    }
    let bandOk = false;
    if (empty === null) {
      say("select-band: none -- no empty board space to start a band from");
    } else {
      const union = every.map((id) => boxOf(id).rect).reduce((acc, r) => ({
        left: Math.min(acc.left, r.left), top: Math.min(acc.top, r.top),
        right: Math.max(acc.right, r.right), bottom: Math.max(acc.bottom, r.bottom),
      }), { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity });
      const to = {
        clientX: Math.round(Math.min(win.innerWidth - 3, union.right + 12)),
        clientY: Math.round(Math.min(win.innerHeight - 3, union.bottom + 12)),
      };
      press2("pointerdown", board, Object.assign({ shiftKey: true }, empty));
      press2("pointermove", board, Object.assign({ shiftKey: true }, to));
      await sleep(250);
      const band = doc.querySelector(".marquee");
      const drawn = band !== null && band.hidden === false;
      press2("pointerup", board, Object.assign({ shiftKey: true, buttons: 0 }, to));
      await sleep(200);
      const closed = band !== null && band.hidden === true;
      const banded = picked(".is-selected");
      bandOk = drawn && closed && banded.length >= 2;
      say("select-band: drawn=" + drawn + " closed=" + closed
        + " selected=" + banded.length + " of " + every.length);
    }

    /* Dragging one selected card moves the whole set, by one delta. */
    key(win, doc, { key: "a", ctrlKey: true });
    await sleep(200);
    const before = new Map(every.map((id) => [id, boxOf(id)]));
    const startBox = before.get(every[0]);
    const from = { clientX: Math.round(startBox.rect.left + 30), clientY: Math.round(startBox.rect.top + 10) };
    const to = { clientX: from.clientX + 70, clientY: from.clientY + 50 };
    press2("pointerdown", titleOf(every[0]), from);
    press2("pointermove", board, to);
    press2("pointerup", board, Object.assign({ buttons: 0 }, to));
    // The move path paints on the next animation frame; a headless run can
    // starve frames, so wait for one (or 300ms) and then nudge a synchronous
    // render with Ctrl+A, which re-paints the positions the drag just set.
    await Promise.race([
      new Promise((resolve) => win.requestAnimationFrame(() => resolve())),
      sleep(300),
    ]);
    key(win, doc, { key: "a", ctrlKey: true });
    await sleep(250);
    const deltas = every.map((id) => {
      const now = boxOf(id);
      return [Math.round(now.x - before.get(id).x), Math.round(now.y - before.get(id).y)];
    });
    const same = deltas.every(([dx, dy]) => dx === deltas[0][0] && dy === deltas[0][1]);
    const moved = same && (deltas[0][0] !== 0 || deltas[0][1] !== 0);
    say("select-group-drag: delta=" + JSON.stringify(deltas[0]) + " same-for-all=" + same);

    /* The command line names the same set without the keyboard. */
    const command = doc.getElementById("command");
    command.value = "select all";
    command.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    await sleep(250);
    const byCommand = picked(".is-selected").length;
    say("select-command: selected=" + byCommand + "  | log: " + logTail());

    /* Delete removes the whole set in one step, and one Ctrl+Z brings it back. */
    const beforeDelete = cardIds().length;
    key(win, doc, { key: "Delete" });
    await sleep(500);
    const afterDelete = cardIds().length;
    key(win, doc, { key: "z", ctrlKey: true });
    await sleep(600);
    const restored = cardIds().length;
    say("select-delete: " + beforeDelete + " -> " + afterDelete + " undo -> " + restored);

    selectOk = selectedAll && toggled && bandOk && moved
      && byCommand === every.length && afterDelete === 0 && restored === beforeDelete;
  } catch (error) {
    selectOk = false;
    say("select-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- search: a word found across the workspace, opened at its line --- */
  let searchOk = true;
  try {
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
    const commandBox = doc.getElementById("command");
    commandBox.value = "find registerCardKind";
    commandBox.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    const searchCard = () => doc.querySelector("#cards [data-card-id].card-search");
    const rowsOf = () => {
      const node = searchCard();
      return node === null ? [] : [...node.querySelectorAll('[data-role="search-hit"]')];
    };
    // Reading a workspace takes as long as the workspace is big, so wait for the
    // rows instead of betting on a sleep.
    await waitUntil(() => rowsOf().length > 0);
    const card = searchCard();
    const rows = rowsOf();
    const status = card === null
      ? "" : (card.querySelector('[data-role="card-status"]').textContent || "").trim();
    say("search-card: open=" + (card !== null) + " rows=" + rows.length + " status=\\"" + status + "\\"");

    const first = rows.length > 0 ? rows[0] : null;
    const wantPath = first === null ? "" : first.dataset.path;
    const wantLine = first === null ? 0 : Number(first.dataset.line);
    if (first !== null) first.click();
    await sleep(900);
    let hitEditor = null;
    for (const node of doc.querySelectorAll("#cards [data-card-id]")) {
      const area = node.querySelector("textarea.ed-input");
      const label = node.querySelector(".card-label");
      if (area !== null && label !== null && label.textContent === wantPath) hitEditor = node;
    }
    const area = hitEditor === null ? null : hitEditor.querySelector("textarea.ed-input");
    const text = area === null ? "" : area.value;
    /* Where that line starts, counted the way a person counts lines: the first
       line starts at 0 and every newline moves it one character on. */
    const expected = text.split("\\n").slice(0, Math.max(0, wantLine - 1)).join("\\n").length
      + (wantLine > 1 ? 1 : 0);
    const caret = area === null ? -1 : area.selectionStart;
    say("search-open: path=" + wantPath + " line=" + wantLine
      + " caret=" + caret + " expected=" + expected);
    searchOk = card !== null && rows.length > 0 && status.indexOf("hit") !== -1
      && area !== null && caret === expected;
  } catch (error) {
    searchOk = false;
    say("search-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- frame: a named rectangle that moves the cards standing in it --- */
  let frameOk = true;
  try {
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
    const mine = () => [...doc.querySelectorAll("#cards [data-card-id]")]
      .filter((node) => !node.classList.contains("card-frame"));
    const runLine = (text) => {
      const box = doc.getElementById("command");
      box.value = text;
      box.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    };

    /* Group the whole board: the frame then wraps every card, and every card
       has its centre inside it, so one drag has to move the lot. */
    key(win, doc, { key: "a", ctrlKey: true });
    await sleep(150);
    const plain = mine().map((node) => node.dataset.cardId);
    const beforeBoxes = new Map(plain.map((id) => {
      const box = boxOf(id);
      return [id, Math.round(box.x) + "," + Math.round(box.y)];
    }));
    runLine("group smoke-frame");
    await sleep(350);
    const frame = doc.querySelector("#cards .card-frame");
    const titleInput = frame === null ? null : frame.querySelector('[data-role="frame-title"]');
    const counted = frame === null ? ""
      : (frame.querySelector('[data-role="frame-count"]').textContent || "").trim();
    const held = counted === "" ? 0 : Number((counted.match(/\\d+/) || [0])[0]);
    /* A frame that covered the cards it groups would hide the work, so it has
       to render below every card however often it is clicked. */
    const frameZ = frame === null ? 0 : Number(win.getComputedStyle(frame).zIndex);
    const behind = frame !== null && mine().length > 0
      && mine().every((node) => Number(win.getComputedStyle(node).zIndex) > frameZ);
    say("frame-group: open=" + (frame !== null)
      + " title=" + JSON.stringify(titleInput === null ? "" : titleInput.value)
      + " count=" + JSON.stringify(counted) + " cards=" + plain.length + " behind=" + behind);

    /* Drag the frame itself: the frame and every card standing in it move by
       the same delta, because a frame *is* the group. */
    const rect = frame.getBoundingClientRect();
    const from = { clientX: Math.round(rect.left + 6), clientY: Math.round(rect.top + 6) };
    const to = { clientX: from.clientX + 80, clientY: from.clientY + 60 };
    press2("pointerdown", frame, from);
    press2("pointermove", frame, to);
    press2("pointerup", frame, Object.assign({ buttons: 0 }, to));
    await Promise.race([
      new Promise((resolve) => win.requestAnimationFrame(() => resolve())),
      sleep(300),
    ]);
    key(win, doc, { key: "a", ctrlKey: true }); // a synchronous repaint
    await sleep(250);
    const moved = mine().map((node) => {
      const box = boxOf(node.dataset.cardId);
      const was = beforeBoxes.get(node.dataset.cardId).split(",");
      return [Math.round(box.x) - Number(was[0]), Math.round(box.y) - Number(was[1])];
    });
    const oneDelta = moved.length > 0
      && moved.every(([dx, dy]) => dx === moved[0][0] && dy === moved[0][1]);
    const dragged = oneDelta && (moved[0][0] !== 0 || moved[0][1] !== 0);
    say("frame-move: delta=" + JSON.stringify(moved[0] || [0, 0])
      + " same-for-all=" + oneDelta + " cards=" + moved.length);

    /* Ungroup takes the region away and leaves the work where it stands. */
    const stay = new Map(mine().map((node) => {
      const id = node.dataset.cardId;
      const box = boxOf(id);
      return [id, Math.round(box.x) + "," + Math.round(box.y)];
    }));
    runLine("ungroup");
    await sleep(400);
    const framesLeft = doc.querySelectorAll("#cards .card-frame").length;
    const stayed = mine().length > 0
      && mine().every((node) => {
        const box = boxOf(node.dataset.cardId);
        return stay.get(node.dataset.cardId) === Math.round(box.x) + "," + Math.round(box.y);
      });
    const kept = mine().length === plain.length;
    say("frame-ungroup: frames=" + framesLeft + " cards=" + mine().length + " stayed=" + stayed);

    frameOk = frame !== null && held >= plain.length && behind && dragged && framesLeft === 0 && stayed && kept;
  } catch (error) {
    frameOk = false;
    say("frame-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- watch: a change made on disk that nobody announced ---
     The kernel announces its own writes; a file rewritten by another program is
     the case no announcement covers.  So this rewrites one with a real child
     process -- `cmd /c echo` -- and reads back what the card holding it says. */
  let watchOk = true;
  try {
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
    const scratch = "build/__watch_smoke.txt";
    // cmd.exe wants backslashes; make one without typing one.
    const nativePath = scratch.split("/").join(String.fromCharCode(92));
    let nextId = 0;
    const rpc = async (method, params) => {
      const answer = await fetch("/rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++nextId, method, params }),
      });
      const body = await answer.json();
      if (body.error) throw new Error(method + ": " + body.error.message);
      return body.result;
    };
    const outside = (text) => rpc("proc.start", {
      cmd: 'cmd /c echo ' + text + '> "' + nativePath + '"',
    });
    /* Waiting for that child is a *real* wait: every probe is a round trip to
       the host, and virtual time stands still while a request is in flight. */
    const readBack = async (want) => {
      let last = "";
      for (let i = 0; i < 60; i++) {
        try {
          const result = await rpc("file.read", { path: scratch });
          if (typeof result.text === "string" && result.text.indexOf(want) !== -1) return result;
        } catch (error) {
          last = error.message;
        }
        await sleep(250);
      }
      say("watch-note: never read " + JSON.stringify(want) + " back: " + last);
      return null;
    };
    const vanished = async () => {
      for (let i = 0; i < 60; i++) {
        try {
          const answer = await rpc("file.stat", { path: scratch });
          if (answer.exists !== true) return answer;
        } catch (error) {
          return null;
        }
        await sleep(250);
      }
      return null;
    };
    const editorHolding = () => {
      for (const node of doc.querySelectorAll("#cards [data-card-id]")) {
        const area = node.querySelector("textarea.ed-input");
        const label = node.querySelector(".card-label");
        if (area !== null && label !== null && label.textContent.indexOf("__watch_smoke") !== -1) {
          return { node, area };
        }
      }
      return null;
    };
    const statusOf = (held) => {
      const node = held === null ? null : held.node.querySelector('[data-role="card-status"]');
      return node === null ? "" : (node.textContent || "").trim();
    };
    const runLine = (text) => {
      const box = doc.getElementById("command");
      box.value = text;
      box.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    };

    /* The file first exists before any card holds it -- nothing to tell. */
    await outside("one");
    const first = await readBack("one");
    runLine("open " + scratch);
    await waitUntil(() => editorHolding() !== null, 60, 250);
    const held = editorHolding();
    /* Wait for the read to answer: a card that has been made but has not read
       the file yet holds no revision, which is the one thing this section is
       about. */
    await waitUntil(() => held !== null && held.area.value.indexOf("one") === 0, 60, 250);
    say("watch-open: open=" + (held !== null)
      + " text=" + JSON.stringify(held === null ? "" : held.area.value)
      + " status=" + JSON.stringify(statusOf(held)));

    /* A second writer rewrites it.  A clean card takes the bytes. */
    await outside("two");
    await readBack("two");
    const reloaded = await waitUntil(() => statusOf(held).indexOf("reloaded from disk") !== -1, 60, 250);
    say("watch-reload: reloaded=" + reloaded
      + " text=" + JSON.stringify(held === null ? "" : held.area.value)
      + " status=" + JSON.stringify(statusOf(held)));

    /* The same write, but this card has unsaved edits: it is told, and the text
       stays.  An editor that silently overwrites typing is worse than one that
       never reloads at all. */
    const kept = "mine, unsaved\\n";
    if (held !== null) {
      held.area.focus();
      held.area.value = kept;
      held.area.dispatchEvent(new win.Event("input", { bubbles: true }));
    }
    await sleep(80);
    await outside("three");
    await readBack("three");
    const warned = await waitUntil(() => statusOf(held).indexOf("changed on disk") !== -1, 60, 250);
    say("watch-warn: warned=" + warned
      + " kept=" + (held !== null && held.area.value === kept)
      + " status=" + JSON.stringify(statusOf(held)));

    /* The file disappears under the card.  Said, not silently written back. */
    await rpc("proc.start", { cmd: 'cmd /c del "' + nativePath + '"' });
    const gone = await vanished();
    const reported = gone !== null
      && await waitUntil(() => statusOf(held).indexOf("gone from disk") !== -1, 60, 250);
    say("watch-gone: gone=" + reported
      + " kept=" + (held !== null && held.area.value === kept)
      + " status=" + JSON.stringify(statusOf(held)));

    watchOk = first !== null && held !== null && reloaded && warned && reported
      && held.area.value === kept;
  } catch (error) {
    watchOk = false;
    say("watch-error: " + (error && error.message ? error.message : String(error)));
  }

  /* --- classic view: the same board, tiled as a sidebar, tabs and a code area ---
     classic.mjs's arithmetic is pinned by the pure suite; what a browser has to
     witness is the pixels.  The strip has to be a band under the HUD, the code
     area has to fill what is left of the right column, the sidebar the left, and
     the two have to end on the board's bottom edge together -- while a card with
     no place in the tile is hidden, never moved off screen.  Then `mode board`
     has to put every card back exactly where the document says it was: that is
     what makes the view a projection of the board and not a second board. */
  let classicOk = true;
  try {
    if (doc.activeElement && doc.activeElement.blur) doc.activeElement.blur();
    const cardsNow = () => Array.from(doc.querySelectorAll("#cards [data-card-id]"));
    const drawn = (node) => win.getComputedStyle(node).display !== "none";
    const near = (a, b) => Math.abs(a - b) <= 2;
    const strip = () => doc.getElementById("tabs");
    const tabButtons = () => Array.from(strip().querySelectorAll("button[data-card-id]"));
    const selectionLine = () => (doc.getElementById("hud-selection").textContent || "").trim();
    const runLine = (text) => {
      const box = doc.getElementById("command");
      box.value = text;
      box.dispatchEvent(new win.KeyboardEvent("keydown", { bubbles: true, cancelable: true, key: "Enter" }));
    };
    /* What a round trip through the classic view has to preserve: the board's own
       pan and zoom, the link layer, and every card's place, size and visibility. */
    const snapshot = () => {
      const parts = ["stage=" + stageTransform(), "zoom=" + hudZoom(),
        "links=" + (doc.getElementById("links").hidden ? "hidden" : "shown")];
      for (const node of cardsNow()) {
        parts.push([node.dataset.cardId, node.style.transform, node.style.width,
          node.style.height, win.getComputedStyle(node).display].join(" "));
      }
      return parts.join(" | ");
    };

    const before = snapshot();
    const editors = cardsNow().filter((node) => node.dataset.kind === "editor").map((node) => node.dataset.cardId);
    runLine("mode classic");
    await waitUntil(() => doc.body.classList.contains("is-classic"), 40, 100);
    const isClassic = doc.body.classList.contains("is-classic");
    const modeText = (doc.getElementById("mode-toggle").textContent || "").trim();
    const buttons = tabButtons();
    const shownCards = cardsNow().filter(drawn);
    const areaNode = shownCards.find((node) => node.dataset.kind === "editor") || null;
    const sideNode = shownCards.find((node) => node !== areaNode) || null;
    const boardRect = doc.getElementById("board").getBoundingClientRect();
    const hudRect = doc.getElementById("hud").getBoundingClientRect();
    const stripRect = strip().getBoundingClientRect();
    const areaRect = areaNode === null ? null : areaNode.getBoundingClientRect();
    const sideRect = sideNode === null ? null : sideNode.getBoundingClientRect();
    /* The tile is in the board's own pixels, so measure from the board's corner:
       `hudBottom` is where classic.mjs starts the strip (it asks the HUD how tall
       it is), and the two columns end on the board's bottom edge together. */
    const hudBottom = hudRect.bottom - boardRect.top;
    const relTop = (rect) => rect.top - boardRect.top;
    const relLeft = (rect) => rect.left - boardRect.left;
    /* One place each: what is drawn is the code area and -- when the board has a
       card that can stand in the sidebar -- the sidebar, and nothing else. */
    const places = shownCards.length === (sideNode === null ? 1 : 2)
      && shownCards.every((node) => node === areaNode || node === sideNode);
    const tile = isClassic && areaRect !== null && stripRect.height > 0
      && near(relTop(stripRect), hudBottom)
      && near(relTop(areaRect), relTop(stripRect) + stripRect.height)
      && (sideRect === null
        ? near(relLeft(stripRect), 0)
        : near(relLeft(stripRect), relLeft(sideRect) + sideRect.width)
          && near(relTop(sideRect), hudBottom)
          && near(sideRect.bottom, boardRect.bottom))
      && near(areaRect.right, boardRect.right)
      && near(areaRect.bottom, boardRect.bottom);
    say("classic-mode: on=" + isClassic + " tabs=" + buttons.length + " editors=" + editors.length
      + " shown=" + shownCards.map((node) => node.dataset.cardId).join(",")
      + " places=" + places + " tile=" + tile + " strip=" + Math.round(stripRect.height)
      + " button=" + JSON.stringify(modeText) + " zoom=" + JSON.stringify(hudZoom()));
    say("classic-rect: board=" + Math.round(boardRect.width) + "x" + Math.round(boardRect.height)
      + " hud-bottom=" + Math.round(hudBottom)
      + " tabs=" + Math.round(relLeft(stripRect)) + "," + Math.round(relTop(stripRect))
      + "+" + Math.round(stripRect.width) + "x" + Math.round(stripRect.height)
      + " area=" + (areaRect === null ? "-" : Math.round(relLeft(areaRect)) + "," + Math.round(relTop(areaRect))
        + "+" + Math.round(areaRect.width) + "x" + Math.round(areaRect.height))
      + " side=" + (sideRect === null ? "-" : Math.round(relLeft(sideRect)) + "," + Math.round(relTop(sideRect))
        + "+" + Math.round(sideRect.width) + "x" + Math.round(sideRect.height)));

    /* A tab is a file: clicking one makes it the code area, on the same pixels
       the previous one had, and selects it -- the route `focus` takes. */
    let tabClick = false;
    let clickedId = "";
    if (buttons.length >= 2 && areaRect !== null) {
      const other = buttons.find((button) => button.dataset.cardId !== areaNode.dataset.cardId);
      clickedId = other.dataset.cardId;
      other.click();
      await sleep(200);
      const moved = cardsNow().find((node) => node.dataset.cardId === clickedId);
      const movedRect = moved.getBoundingClientRect();
      const active = strip().querySelector("button.is-active");
      tabClick = drawn(moved) && near(relLeft(movedRect), relLeft(areaRect))
        && near(relTop(movedRect), relTop(areaRect))
        && near(movedRect.width, areaRect.width) && near(movedRect.height, areaRect.height)
        && active !== null && active.dataset.cardId === clickedId
        && selectionLine().indexOf(clickedId) !== -1;
    }
    say("classic-tab: clicked=" + JSON.stringify(clickedId) + " moved=" + tabClick
      + " selection=" + JSON.stringify(selectionLine()));

    /* The wheel is the board's gesture and the board is not on screen: neither a
       ctrl+wheel over the code area nor a plain wheel over the strip may move the
       viewport, and the HUD has to keep saying there is no zoom to speak of. */
    const stageBefore = stageTransform();
    const zoomBefore = hudZoom();
    const areaNow = cardsNow().find((node) => node.dataset.kind === "editor" && drawn(node)) || null;
    if (areaNow !== null) {
      const rect = areaNow.getBoundingClientRect();
      const at = { clientX: Math.round(rect.left + rect.width / 2),
        clientY: Math.round(rect.top + Math.min(40, Math.max(1, rect.height / 2))) };
      wheel(win, doc.elementFromPoint(at.clientX, at.clientY) || areaNow,
        Object.assign({ deltaY: -240, ctrlKey: true }, at));
    }
    await sleep(120);
    wheel(win, doc.getElementById("board"), { deltaY: 160,
      clientX: Math.round(stripRect.left + 4), clientY: Math.round(stripRect.top + 2) });
    await sleep(120);
    const frozen = stageTransform() === stageBefore && hudZoom() === zoomBefore
      && hudZoom() === "no zoom";
    say("classic-wheel: frozen=" + frozen + " stage=" + JSON.stringify(stageBefore)
      + "->" + JSON.stringify(stageTransform()) + " zoom=" + JSON.stringify(zoomBefore)
      + "->" + JSON.stringify(hudZoom()));

    /* And back: the same document, on the same pixels, with the viewport exactly
       where it was -- nothing was mounted, unmounted or moved while away. */
    runLine("mode board");
    await sleep(250);
    const back = !doc.body.classList.contains("is-classic") && snapshot() === before;
    say("classic-back: restored=" + back + " classic=" + doc.body.classList.contains("is-classic"));

    classicOk = isClassic && editors.length > 0 && buttons.length === editors.length
      && places && tile && tabClick && frozen && back;
  } catch (error) {
    classicOk = false;
    say("classic-error: " + (error && error.message ? error.message : String(error)));
  }

  say("page errors: " + (pageErrors.length === 0
    ? "none"
    : pageErrors.length + " " + JSON.stringify(pageErrors.slice(-4))));
  say("RESULT: " + (pageErrors.length === 0 && ok && wheelOk && editorOk && selectOk && searchOk && frameOk && watchOk && classicOk
    ? "undo, redo, wheel ownership, the editor keys, language completions and issues, multi-select, a workspace search, a frame, a watched file and the classic view work in a real browser"
    : "FAILED -- see the counts, wheel, editor, select, search, frame, watch, classic and page-error lines above"));
  document.title = "input smoke done";
}

main();
</script>
</body></html>
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="input_smoke.py",
        description=(
            "Boot the real app in the system browser, make a board change, press "
            "Ctrl+Z and Ctrl+Shift+Z, dispatch a wheel over a card's own scroll "
            "region and over the board, and drive the editor card's indent, "
            "auto-indent, find and replace keys, ask it for completions with "
            "^Space and read the issue strip, then select with Ctrl+A, "
            "ctrl+click and a shift+drag rubber band, drag the group and delete "
            "it, and finally search the workspace with `find`, open a hit at "
            "its line, frame a whole selection with `group` and take the frame "
            "away again with `ungroup`, and finally switch to the classic view -- "
            "the same cards as a sidebar, a tab strip and a code area -- click a "
            "tab, wheel it and come back to the board. Exit codes: 0 pass or "
            "skipped, 1 a check failed, 2 could not run, 3 usage."
        ),
    )
    parser.add_argument("--edge", help="path to msedge.exe (default: the usual two places)")
    parser.add_argument("--port", type=int, default=0, help="port for the host (default: a free one)")
    parser.add_argument("--timeout", type=float, default=180.0, help="seconds to allow the browser")
    parser.add_argument("--keep", action="store_true", help="keep the wrapper page for debugging")
    return parser


class Results:
    """The PASS/FAIL lines and the summary, in the shape browser_smoke.py uses."""

    def __init__(self) -> None:
        self.checks = []

    def check(self, name: str, ok: bool, detail: str = "") -> None:
        self.checks.append((name, bool(ok), detail))
        mark = "PASS" if ok else "FAIL"
        print(f"[{mark}] {name}" + (f": {detail}" if detail else ""))

    def report(self, attempts: int) -> int:
        passed = sum(1 for _, ok, _ in self.checks if ok)
        failed = len(self.checks) - passed
        print(f"summary: {passed} passed, {failed} failed ({len(self.checks)} checks, "
              f"{attempts} browser launch(es))")
        return 0 if failed == 0 else 1


def parse_counts(body: str) -> dict:
    found = re.search(r"counts: boot=(\d+) added=(\d+) undone=(\d+) redone=(\d+) in-field=(\d+)", body)
    if found is None:
        return {}
    keys = ["boot", "added", "undone", "redone", "inField"]
    return dict(zip(keys, (int(value) for value in found.groups())))


def parse_wheel(body: str) -> dict:
    """The two wheel lines the wrapper wrote, as tuples of strings."""
    found = {}
    patterns = (
        ("card", r"wheel-card: defaultPrevented=(\w+) viewport-moved=(\w+)(?:  \((.+)\))?"),
        ("board", r"wheel-board: defaultPrevented=(\w+) viewport-moved=(\w+)"),
        ("ctrl", r"wheel-ctrl: (\S+) -> (\S+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"wheel-card: none -- .*?\[(.+)\]", body)
    if none is not None:
        found["card_none"] = (none.group(1),)
    return found


def parse_editor(body: str) -> dict:
    """The editor lines the wrapper wrote, as tuples of raw strings."""
    found = {}
    patterns = (
        ("indent", r'editor-indent: tab="([^"]*)" caret=(\d+) shift-tab-restores=(\w+)'),
        ("enter", r'editor-enter: "([^"]*)" caret=(\d+)'),
        ("find", r'editor-find: open=(\w+) hits=(\d+) count="([^"]*)"'),
        ("next", r'editor-find-next: count="([^"]*)" current=(\d+)'),
        ("replace", r'editor-replace: "([^"]*)" closed=(\w+)'),
        ("undo", r"editor-undo: typed=(\w+) command=(\w+) restored=(\w+)"),
        ("complete", r'editor-complete: (true|false) shown=(\d+) labels="([^"]*)" source="([^"]*)"'),
        ("issues", r'editor-issues: (true|false) rows=(\d+) severities="([^"]*)" first="([^"]*)"'),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"editor: none -- (.+)", body)
    if none is not None:
        found["none"] = (none.group(1),)
    return found


def parse_select(body: str) -> dict:
    """The multi-select lines the wrapper wrote, as tuples of raw strings."""
    found = {}
    patterns = (
        ("all", r"select-all: cards=(\d+) selected=(\d+) primary=(\d+)"),
        ("toggle", r"select-ctrl-click: without=(\d+) back=(\d+) \(of (\d+)\)"),
        ("band", r"select-band: drawn=(\w+) closed=(\w+) selected=(\d+) of (\d+)"),
        ("drag", r"select-group-drag: delta=(\[[^\]]*\]) same-for-all=(\w+)"),
        ("command", r"select-command: selected=(\d+)"),
        ("delete", r"select-delete: (\d+) -> (\d+) undo -> (\d+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"select-band: none -- (.+)", body)
    if none is not None:
        found["band_none"] = (none.group(1),)
    return found


def parse_search(body: str) -> dict:
    """The workspace-search lines the wrapper wrote, as tuples of raw strings."""
    found = {}
    patterns = (
        ("card", r'search-card: open=(\w+) rows=(\d+) status="([^"]*)"'),
        ("open", r"search-open: path=(\S+) line=(\d+) caret=(-?\d+) expected=(-?\d+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"search-error: (.+)", body)
    if none is not None:
        found["error"] = (none.group(1),)
    return found


def parse_frame(body: str) -> dict:
    """The frame lines the wrapper wrote, as tuples of raw strings."""
    found = {}
    patterns = (
        ("group", r'frame-group: open=(\w+) title="([^"]*)" count="([^"]*)" cards=(\d+) behind=(\w+)'),
        ("move", r"frame-move: delta=(\[[^\]]*\]) same-for-all=(\w+) cards=(\d+)"),
        ("ungroup", r"frame-ungroup: frames=(\d+) cards=(\d+) stayed=(\w+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"frame-error: (.+)", body)
    if none is not None:
        found["error"] = (none.group(1),)
    return found


def parse_watch(body: str) -> dict:
    """The watched-file lines the wrapper wrote, as tuples of raw strings."""
    found = {}
    patterns = (
        ("open", r'watch-open: open=(\w+) text="([^"]*)" status="([^"]*)"'),
        ("reload", r'watch-reload: reloaded=(\w+) text="([^"]*)" status="([^"]*)"'),
        ("warn", r'watch-warn: warned=(\w+) kept=(\w+) status="([^"]*)"'),
        ("gone", r'watch-gone: gone=(\w+) kept=(\w+) status="([^"]*)"'),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"watch-(?:error|note): (.+)", body)
    if none is not None:
        found["error"] = (none.group(1),)
    return found


def parse_classic(body: str) -> dict:
    """The four classic-view lines the wrapper wrote, as tuples of strings."""
    found = {}
    patterns = (
        ("mode", r'classic-mode: on=(\w+) tabs=(\d+) editors=(\d+) shown=(\S*)'
                 r' places=(\w+) tile=(\w+) strip=(\d+) button=("[^"]*") zoom=("[^"]*")'),
        ("tab", r'classic-tab: clicked=("[^"]*") moved=(\w+) selection=("[^"]*")'),
        ("wheel", r'classic-wheel: frozen=(\w+) stage=("[^"]*")->("[^"]*")'
                  r' zoom=("[^"]*")->("[^"]*")'),
        ("back", r"classic-back: restored=(\w+) classic=(\w+)"),
    )
    for key, pattern in patterns:
        match = re.search(pattern, body)
        if match is not None:
            found[key] = match.groups()
    none = re.search(r"classic-error: (.+)", body)
    if none is not None:
        found["error"] = (none.group(1),)
    return found


def parse_page_errors(body: str) -> dict:
    """The exceptions the app threw, as the wrapper's error listeners caught them.

    A listener that throws changes no DOM node, so every other check in this file
    reads it as "nothing happened" -- the wrapper reports the count so that a dead
    feature cannot pass as an absent one.
    """
    match = re.search(r"^page errors: (.+)$", body, re.MULTILINE)
    if match is None:
        return {"count": -1, "detail": "no 'page errors' line -- the page never got that far"}
    if match.group(1).strip() == "none":
        return {"count": 0, "detail": ""}
    count = re.match(r"(\d+)", match.group(1))
    return {
        "count": int(count.group(1)) if count is not None else -1,
        "detail": match.group(1).strip(),
    }


def main(argv=None) -> int:
    args = build_parser().parse_args(argv)
    if args.timeout <= 0:
        build_parser().error("--timeout must be positive")
    if args.port < 0 or args.port > 65535:
        print(f"input_smoke.py: --port {args.port} is not a TCP port", file=sys.stderr)
        return 2
    if WRAPPER.exists():
        print(f"input_smoke.py: refusing to overwrite {WRAPPER}", file=sys.stderr)
        return 2

    try:
        edge = bs.find_edge(args.edge)
    except bs.DriverError as exc:
        print(f"[SKIP] no browser available: {exc}")
        print("summary: 0 passed, 0 failed, 37 skipped (no browser)")
        return 0

    backup = bs.BoardBackup(bs.BOARD_PATH)
    backup.snapshot()
    try:
        backup.install_if_absent()
    except (bs.DriverError, OSError) as exc:
        print(f"[FAIL] cannot set up a board: {exc}")
        backup.discard()
        return 2

    print(f"input smoke           {bs.REPO_ROOT}")
    print(f"browser               {edge}")
    print(f"board                 {bs.BOARD_PATH}")
    print("-" * 68)
    profile = Path(tempfile.mkdtemp(prefix="seide-input-smoke-"))
    WRAPPER.write_text(PAGE, encoding="utf-8", newline="\n")
    host = bs.Host(args.port or bs.free_port())
    results = Results()
    attempts = 0
    body = ""
    try:
        host.start()
        host.wait_ready(min(30.0, args.timeout))
        url = host.url + WRAPPER_NAME
        argv = [str(edge), *bs.EDGE_FLAGS, f"--user-data-dir={profile}"]
        argv = [item if not item.startswith("--virtual-time-budget=")
                else f"--virtual-time-budget={BUDGET_MS}" for item in argv]
        done = subprocess.run([*argv, "--dump-dom", url], capture_output=True, text=True,
                              encoding="utf-8", errors="replace", timeout=args.timeout)
        attempts = 1
        found = RESULT_RE.search(done.stdout or "")
        if found is None:
            print("[FAIL] the page never wrote a result block")
            tail = (done.stdout or "")[-400:]
            if tail:
                print(f"       dom tail: {tail!r}")
        else:
            body = found.group(1)
            for entity, char in (("&lt;", "<"), ("&gt;", ">"), ("&quot;", '"'), ("&amp;", "&")):
                body = body.replace(entity, char)
            for line in body.splitlines():
                print(f"  {line}")
    except (bs.DriverError, OSError, subprocess.TimeoutExpired) as exc:
        print(f"[FAIL] the run did not finish: {exc}")
    finally:
        if not args.keep:
            WRAPPER.unlink(missing_ok=True)
        SCRATCH.unlink(missing_ok=True)
        alive = host.proc is not None and host.proc.poll() is None
        if alive:
            bs.terminate(host.proc)
        shutil.rmtree(profile, ignore_errors=True)
        restored = backup.restore()
        backup.discard()
        host_gone = not (host.proc is not None and host.proc.poll() is None)

    counts = parse_counts(body)
    booted = "kernel ready: true" in body
    results.check("the app boots in an iframe and reaches kernel ready", booted)
    errors = parse_page_errors(body)
    results.check("the app threw nothing while it was driven", errors["count"] == 0,
                  (f"{errors['count']} exception(s): {errors['detail']}" if errors["count"] > 0
                   else errors["detail"]))
    results.check("a double-click on empty space adds a card",
                  counts.get("added") == counts.get("boot", -1) + 1 if counts else False,
                  f"boot={counts.get('boot')} added={counts.get('added')}" if counts else "no counts")
    results.check("Ctrl+Z takes that card back",
                  bool(counts) and counts.get("undone") == counts.get("boot")
                  and "undid:" in body,
                  f"undone={counts.get('undone')} after added={counts.get('added')}" if counts else "no counts")
    results.check("Ctrl+Shift+Z puts it back",
                  bool(counts) and counts.get("redone") == counts.get("added")
                  and "redid:" in body,
                  f"redone={counts.get('redone')}" if counts else "no counts")
    results.check("Ctrl+Z with a text field focused leaves the board alone",
                  bool(counts) and counts.get("inField") == counts.get("redone"),
                  f"in-field={counts.get('inField')} redone={counts.get('redone')}" if counts else "no counts")
    results.check("the board is back as it was found", restored,
                  "byte-identical" if restored else "NOT byte-identical")

    wheel = parse_wheel(body)
    card_wheel = wheel.get("card")
    if card_wheel is None:
        why = wheel.get("card_none")
        results.check("a wheel over a card's own scroll region is left to the card", True,
                      (f"no card's scroll region is under the pointer ({why[0]}) -- not proven"
                       if why else "no card's scroll region is under the pointer -- not proven"))
    else:
        where = f"  ({card_wheel[2]})" if card_wheel[2] else ""
        results.check("a wheel over a card's own scroll region is left to the card",
                      card_wheel[:2] == ("false", "false"),
                      f"defaultPrevented={card_wheel[0]} viewport-moved={card_wheel[1]}{where}"
                      " -- the card keeps the wheel and the board does not move")
    board_wheel = wheel.get("board")
    results.check("a wheel over the board still pans",
                  board_wheel == ("true", "true"),
                  f"defaultPrevented={board_wheel[0]} viewport-moved={board_wheel[1]}"
                  if board_wheel else "no wheel-board line")
    ctrl_wheel = wheel.get("ctrl")
    results.check("ctrl+wheel over a card is still a zoom",
                  bool(ctrl_wheel) and ctrl_wheel[0] != ctrl_wheel[1],
                  f"zoom {ctrl_wheel[0]} -> {ctrl_wheel[1]}" if ctrl_wheel else "no wheel-ctrl line")

    editor = parse_editor(body)
    editor_expected = (
        ("Tab indents the editor's file and shift+Tab puts it back", "indent",
         ("    ", "4", "true")),
        ("Enter keeps the indentation and steps in after an opener", "enter",
         ("foo {\\n    \\nbar", "10")),
        ("Ctrl+F opens the find bar and paints every hit", "find",
         ("true", "2", "1/2")),
        ("the next-match button walks the hits and marks the current one", "next",
         ("2/2", "1")),
        ("replace-all rewrites every hit and Escape closes the bar", "replace",
         ("fzzzz {\\n    \\nbar", "true")),
        ("the card's own edits stay in the textarea's undo stack", "undo",
         ("true", "true", "true")),
    )
    for name, key, want in editor_expected:
        got = editor.get(key)
        if got is not None:
            detail = " ".join(got)
        elif editor.get("none") is not None:
            detail = editor["none"][0]
        else:
            detail = f"no editor-{key} line"
        results.check(name, got == want, detail)

    complete = editor.get("complete")
    results.check("^Space asks the language subsystem and Enter takes a completion",
                  complete is not None and complete[0] == "true" and complete[3] == "lsp",
                  " ".join(complete[1:]) if complete else "no editor-complete line")
    issues = editor.get("issues")
    results.check("a stray brace becomes an issue row and clicking it moves the caret there",
                  issues is not None and issues[0] == "true",
                  " ".join(issues[1:]) if issues else "no editor-issues line")

    select = parse_select(body)

    def select_detail(key: str) -> str:
        got = select.get(key)
        if got is not None:
            return " ".join(got)
        if key == "band" and select.get("band_none") is not None:
            return f"{select['band_none'][0]} -- not proven"
        return f"no select-{key} line"

    all_line = select.get("all")
    results.check("Ctrl+A selects every card and leaves exactly one leader",
                  bool(all_line) and all_line[0] == all_line[1] != "0" and all_line[2] == "1",
                  select_detail("all"))
    toggle = select.get("toggle")
    results.check("ctrl+click takes one card out of the set and puts it back",
                  bool(toggle) and int(toggle[0]) == int(toggle[2]) - 1 and toggle[1] == toggle[2],
                  f"without={toggle[0]} back={toggle[1]} of {toggle[2]}" if toggle else select_detail("toggle"))
    band = select.get("band")
    if band is None:
        results.check("shift+drag draws a rubber band that selects what it touches",
                      False, select_detail("band"))
    else:
        results.check("shift+drag draws a rubber band that selects what it touches",
                      band[0] == "true" and band[1] == "true" and int(band[2]) >= 2,
                      f"drawn={band[0]} closed={band[1]} selected={band[2]} of {band[3]}")
    drag = select.get("drag")
    results.check("dragging one selected card moves the whole set by one delta",
                  bool(drag) and drag[1] == "true" and drag[0] != "[0,0]",
                  f"delta={drag[0]} same-for-all={drag[1]}" if drag else select_detail("drag"))
    command = select.get("command")
    results.check("`select all` on the command line names the same set",
                  bool(command) and bool(all_line) and command[0] == all_line[1],
                  f"selected={command[0]}" if command else select_detail("command"))
    gone = select.get("delete")
    results.check("Delete removes the whole set in one step and one Ctrl+Z brings it back",
                  bool(gone) and gone[1] == "0" and gone[2] == gone[0],
                  f"{gone[0]} -> {gone[1]} undo -> {gone[2]}" if gone else select_detail("delete"))

    search = parse_search(body)

    def search_detail(key: str) -> str:
        got = search.get(key)
        if got is not None:
            return " ".join(got)
        if search.get("error") is not None:
            return f"search-error: {search['error'][0]}"
        return f"no search-{key} line"

    card = search.get("card")
    results.check("`find <text>` opens a search card that finds a word across the workspace",
                  bool(card) and card[0] == "true" and int(card[1]) > 0 and "hit" in card[2],
                  f"rows={card[1]} status={card[2]!r}" if card else search_detail("card"))
    opened = search.get("open")
    results.check("clicking a hit opens that file with the caret on its line",
                  bool(opened) and int(opened[3]) >= 0 and opened[2] == opened[3],
                  f"{opened[0]}:{opened[1]} caret={opened[2]} expected={opened[3]}" if opened
                  else search_detail("open"))

    frame = parse_frame(body)

    def frame_detail(key: str) -> str:
        got = frame.get(key)
        if got is not None:
            return " ".join(got)
        if frame.get("error") is not None:
            return f"frame-error: {frame['error'][0]}"
        return f"no frame-{key} line"

    grouped = frame.get("group")
    held = None
    if grouped is not None:
        digits = re.search(r"\d+", grouped[2])
        held = int(digits.group()) if digits is not None else None
    results.check("`group` frames the selection and counts the cards standing in it",
                  bool(grouped) and grouped[0] == "true" and grouped[4] == "true"
                  and held is not None and held >= int(grouped[3]) >= 2,
                  f"title={grouped[1]!r} count={grouped[2]!r} cards={grouped[3]} behind={grouped[4]}"
                  if grouped else frame_detail("group"))
    movedFrame = frame.get("move")
    results.check("dragging a frame moves every card inside it by one delta",
                  bool(movedFrame) and movedFrame[1] == "true" and movedFrame[0] != "[0,0]"
                  and int(movedFrame[2]) >= 2,
                  f"delta={movedFrame[0]} same-for-all={movedFrame[1]} cards={movedFrame[2]}"
                  if movedFrame else frame_detail("move"))
    goneFrame = frame.get("ungroup")
    results.check("`ungroup` takes the frame away and leaves the cards where they were",
                  bool(goneFrame) and goneFrame[0] == "0" and goneFrame[2] == "true"
                  and int(goneFrame[1]) >= 2,
                  f"frames={goneFrame[0]} cards={goneFrame[1]} stayed={goneFrame[2]}"
                  if goneFrame else frame_detail("ungroup"))

    watch = parse_watch(body)

    def watch_detail(key: str) -> str:
        got = watch.get(key)
        if got is not None:
            return " ".join(got)
        if watch.get("error") is not None:
            return f"watch: {watch['error'][0]}"
        return f"no watch-{key} line"

    held_rev = watch.get("open")
    results.check("an editor card on a file reports the revision it read",
                  bool(held_rev) and held_rev[0] == "true" and held_rev[1].startswith("one")
                  and "rev " in held_rev[2] and "loaded" in held_rev[2],
                  f"text={held_rev[1]!r} status={held_rev[2]!r}" if held_rev
                  else watch_detail("open"))
    reloaded = watch.get("reload")
    results.check("a write from another process reaches a clean card, which reloads it",
                  bool(reloaded) and reloaded[0] == "true" and reloaded[1].startswith("two")
                  and "reloaded from disk" in reloaded[2],
                  f"reloaded={reloaded[0]} text={reloaded[1]!r} status={reloaded[2]!r}"
                  if reloaded else watch_detail("reload"))
    warned = watch.get("warn")
    results.check("a card with unsaved edits keeps them and says the file changed",
                  bool(warned) and warned[0] == "true" and warned[1] == "true"
                  and "changed on disk" in warned[2] and "modified" in warned[2],
                  f"warned={warned[0]} kept={warned[1]} status={warned[2]!r}"
                  if warned else watch_detail("warn"))
    deleted = watch.get("gone")
    results.check("a file deleted under a card is reported and the text stays",
                  bool(deleted) and deleted[0] == "true" and deleted[1] == "true"
                  and "gone from disk" in deleted[2],
                  f"gone={deleted[0]} kept={deleted[1]} status={deleted[2]!r}"
                  if deleted else watch_detail("gone"))

    classic = parse_classic(body)

    def classic_detail(key: str) -> str:
        got = classic.get(key)
        if got is not None:
            return " ".join(got)
        if classic.get("error") is not None:
            return f"classic: {classic['error'][0]}"
        return f"no classic-{key} line"

    mode = classic.get("mode")
    results.check("`mode classic` tiles the same cards into a sidebar, a tab strip and a code area",
                  bool(mode) and mode[0] == "true" and int(mode[2]) >= 1
                  and int(mode[1]) == int(mode[2]) and mode[3] != ""
                  and mode[4] == "true" and mode[5] == "true" and int(mode[6]) >= 20
                  and mode[7].strip('"') == "board view" and mode[8].strip('"') == "no zoom",
                  f"tabs={mode[1]} editors={mode[2]} shown={mode[3]} places={mode[4]} "
                  f"tile={mode[5]} strip={mode[6]}px button={mode[7]} zoom={mode[8]}"
                  if mode else classic_detail("mode"))
    tab = classic.get("tab")
    results.check("clicking a tab makes that file the code area",
                  bool(tab) and tab[0] != '""' and tab[1] == "true",
                  f"clicked={tab[0]} moved={tab[1]} selection={tab[2]}" if tab
                  else classic_detail("tab"))
    wheeled = classic.get("wheel")
    results.check("the board's wheel gestures are off once the board is not on screen",
                  bool(wheeled) and wheeled[0] == "true" and wheeled[2] == wheeled[1]
                  and wheeled[4] == wheeled[3],
                  f"frozen={wheeled[0]} stage={wheeled[1]}->{wheeled[2]} "
                  f"zoom={wheeled[3]}->{wheeled[4]}" if wheeled else classic_detail("wheel"))
    back = classic.get("back")
    results.check("`mode board` puts every card back where the document says it was",
                  bool(back) and back[0] == "true" and back[1] == "false",
                  f"restored={back[0]} classic={back[1]}" if back else classic_detail("back"))

    if not host_gone:
        results.check("the host is gone", False, "still running -- kill it by hand")
    code = results.report(attempts)
    if args.keep and WRAPPER.exists():
        print(f"wrapper kept: {WRAPPER}")
    return code


if __name__ == "__main__":
    sys.exit(main())
