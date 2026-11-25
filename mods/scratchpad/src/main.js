// Scratch pad: one markdown pad per space, in a layout panel beside the terminals.
//
// Two roles, chosen by props:
//   { role: "button" } — the Pad button beside the tab bar. Always shown, so it
//     receives `scratchpad.toggle`, remembers each tab's last focused terminal, and
//     deletes pads whose space has closed.
//   { role: "pad" }    — the pad itself, in the layout node PANEL. Shows the focused
//     space's text and handles `scratchpad.send`.
//
// Every pad is stored on this computer, in <Herdr home>/data/scratchpad/<space>.md,
// with its images in <space>.images/. A remote space's text is also kept in step
// with the copy on its machine (sync.js), so every computer connected to that
// machine shares it; images stay on the computer that added them. Sending pastes
// into the terminal, and Herdr copies images over. Deleted when the space closes.

import { View, div, image, svg } from "gpui-kit";
import { Editor, EditorState, h_flex, v_flex } from "gpui-base";
import {
  appHome, checking, closeOverlay, exec, focused, layout, machines, nextCommand, openOverlay, props,
  run, settings, spaces, theme, watchFolder, window as appWindow, writeTextFile,
} from "herdr";
import * as fs from "fs/promises";
import { clipboard } from "./clipboard.js";
import { Stale, readRemote, removeRemote, writeRemote } from "./sync.js";

const MOD = "scratchpad";
const PANEL = "scratchpad-panel";
const ICON = `mods/${MOD}/pad.svg`;
const SEND = "scratchpad_send";
const dir = () => `${appHome()}/data/${MOD}`;
const fileFor = (space) => `${dir()}/${encodeURIComponent(space)}.md`;
const baseFor = (space) => `${dir()}/${encodeURIComponent(space)}.base`;
const imageFolder = (space) => `${encodeURIComponent(space)}.images`;
const imageName = /^[a-f0-9]{32}\.png$/;
const incoming = new Set();  // images moved into place but not referenced yet
let sending = false;

// Remote pads are checked only while one is shown, the window is visible and
// its machine is connected: this often while the window is focused, less when not.
const POLL_MS = 3000;
const POLL_IDLE_MS = 15000;
const POLL_MAX_MS = 60000;  // after failures

// The pad's image references, in order, as ranges of the text. `here` is false
// for images another computer added: synced text can name images it doesn't have.
function imageRefs(text, space) {
  const refs = [];
  for (const match of text.matchAll(/!\[[^\]\n]*\]\(([^)\n/]+\.images)\/([a-f0-9]{32}\.png)\)/g)) {
    refs.push({
      path: `${match[1]}/${match[2]}`, here: match[1] === imageFolder(space),
      start: match.index, end: match.index + match[0].length,
    });
  }
  return refs;
}

// Shared by every copy of this mod.
const texts = new Map();         // space id -> pad text
const synced = new Map();        // space id -> text last read from or written to its file
const bases = new Map();         // remote space id -> text both copies last agreed on, or null
const stamps = new Map();        // remote space id -> the other copy's stamp when it held that text
const lastPoll = new Map();      // remote space id -> when its machine was last asked
const unpushed = new Set();      // remote space ids saved here but not yet on their machine
const syncErrors = new Map();    // remote space id -> why it isn't synced, for the header
const merged = new Map();        // space id -> notice that the pad now holds two versions
const lastTerminal = new Map();  // tab id -> last focused terminal address
const state = { padFocused: false, wantFocus: false, pad: null, saveError: null };

function find(node, id) {
  if (!node) return null;
  if (node.id === id) return node;
  for (const c of node.children ?? []) {
    const hit = find(c, id);
    if (hit) return hit;
  }
  return null;
}

const panelShown = () => {
  const n = find(layout(), PANEL);
  return !!n && !n.hidden;
};

// "vps/sp12" is space "sp12" on machine "vps"; a bare id is on this computer.
const machineOf = (space) => (space.includes("/") ? space.slice(0, space.indexOf("/")) : "");
const isReady = (machine) => machines().some((m) => (m.name ?? "") === machine && m.layout === "ready");

// One save or sync at a time per pad, in order.
const chains = new Map();
function serial(space, job) {
  const next = (chains.get(space) ?? Promise.resolve()).catch(() => {}).then(job);
  chains.set(space, next);
  return next;
}

async function sh(script, ...args) {
  const r = await exec("sh", ["-c", script, "sh", ...args], { timeout: 15000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  return r.stdout;
}

async function ensureDir() {
  if (!(await fs.exists(dir()))) await fs.mkdir(dir(), { recursive: true });
}

// Reads a pad's file: "" when there is none.
async function readPad(space) {
  const path = fileFor(space);
  return (await fs.exists(path)) ? await fs.readFile(path, "utf8") : "";
}

// Replaces the pad's file only if it still holds `expected`; throws Stale when
// something else (another computer, for this machine's spaces) changed it.
async function writePad(space, text, expected) {
  await ensureDir();
  const path = fileFor(space);
  const exists = await fs.exists(path);
  if (!exists && expected !== "") throw new Stale();
  if (text === "") {
    if (exists && (await readPad(space)) !== expected) throw new Stale();
    if (exists) await fs.unlink(path);
    return;
  }
  try {
    await writeTextFile(path, text, exists ? expected : null);
  } catch (err) {
    if ((await readPad(space)) !== expected) throw new Stale();
    throw err;
  }
}

// Two versions edited at once: keep both, mine first.
function merge(mine, theirs, from) {
  if (!mine.trim()) return theirs;
  if (!theirs.trim()) return mine;
  return `${mine.replace(/\s+$/, "")}\n\n---\n\nAlso edited on ${from}:\n\n${theirs}`;
}

// Puts `next` in place of the pad's text, then saves it over `expected`. Callers
// check there are no edits that `next` leaves out. It shows first, so typing
// during the write builds on it. If the save fails, the pad shows `fallback`.
async function take(space, next, { expected = synced.get(space), fallback = expected } = {}) {
  texts.set(space, next);
  if (state.pad?.space === space) state.pad.show(next);
  try {
    await writePad(space, next, expected);
  } catch (err) {
    if (texts.get(space) === next) {
      texts.set(space, fallback);
      if (state.pad?.space === space) state.pad.show(fallback);
    }
    throw err;
  }
  synced.set(space, next);
  await removeImages(space).catch(() => {});
}

// Deletes the space's images that its latest text no longer references.
async function removeImages(space) {
  const folder = `${dir()}/${imageFolder(space)}`;
  if (!(await fs.exists(folder))) return;
  const kept = new Set(imageRefs(texts.get(space) ?? "", space).map((ref) => ref.path));
  for (const name of await fs.readdir(folder)) {
    const path = `${imageFolder(space)}/${name}`;
    if (imageName.test(name) && !kept.has(path) && !incoming.has(path)) await fs.unlink(`${folder}/${name}`);
  }
}

async function loadText(space) {
  if (texts.has(space)) return texts.get(space);
  const text = await readPad(space);
  if (!texts.has(space)) {
    texts.set(space, text);
    synced.set(space, text);
  }
  return texts.get(space);
}

async function saveText(space, text) {
  if (!spaces().some((s) => s.id === space)) return;  // closed: sweep() has its files
  if (texts.get(space) !== text) return;  // newer edits have their own save coming
  try {
    try {
      await writePad(space, text, synced.get(space) ?? "");
      synced.set(space, text);
    } catch (err) {
      if (!(err instanceof Stale)) throw err;
      // Another computer saved this pad since it was read here.
      const theirs = await readPad(space);
      if (texts.get(space) !== text) return;
      await take(space, merge(text, theirs, "another computer"), { expected: theirs, fallback: text });
      merged.set(space, "Edited here and on another computer at once: both versions are in the pad.");
    }
    state.saveError = null;
  } catch (err) {
    state.saveError = `Not saved: ${err?.message ?? err}`;
    return;
  }
  try {
    await removeImages(space);
  } catch (err) {
    state.saveError = `Saved, but image cleanup failed: ${err?.message ?? err}`;
  }
  if (machineOf(space)) {
    unpushed.add(space);
    await syncRemote(space);
  }
}

async function readBase(space) {
  if (!bases.has(space)) {
    const path = baseFor(space);
    bases.set(space, (await fs.exists(path)) ? await fs.readFile(path, "utf8") : null);
  }
  return bases.get(space);
}

// Both copies hold `text`; the other one is at `stamp`.
async function agree(space, text, stamp) {
  stamps.set(space, stamp);
  unpushed.delete(space);
  if (bases.get(space) === text) return;
  await ensureDir();
  await fs.writeFile(baseFor(space), text);
  bases.set(space, text);
}

// Brings a remote space's saved pad and the copy on its machine into agreement:
// whichever changed since they last agreed wins, and if both did, the pad keeps
// both. Edits that aren't saved yet are left for their save, which calls this.
// Run it through serial(). Returns false when the machine couldn't be reached.
async function syncRemote(space) {
  const machine = machineOf(space);
  const id = encodeURIComponent(space.slice(machine.length + 1));
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!spaces().some((s) => s.id === space)) return true;
    if (!isReady(machine)) {
      if (unpushed.has(space)) syncErrors.set(space, `Not synced: ${machine} isn't connected.`);
      return false;
    }
    try {
      await loadText(space);
      if (!isClean(space)) return true;
      const mine = synced.get(space);
      const base = await readBase(space);
      const known = base === null ? undefined : stamps.get(space);
      let stamp;
      if (known !== undefined && mine !== base) {
        // Saved here since they agreed: one exec, unless the other copy changed too.
        stamp = await writeRemote(machine, id, mine, known);
        await agree(space, mine, stamp);
      } else {
        const remote = await readRemote(machine, id, known);
        const theirs = remote.text ?? base;
        stamp = remote.stamp;
        if (!isClean(space) || synced.get(space) !== mine) return true;
        if (theirs === mine) {
          await agree(space, mine, stamp);
        } else if (base === null ? theirs === "" : theirs === base) {
          await agree(space, mine, await writeRemote(machine, id, mine, stamp));
        } else if (base === null ? mine === "" : mine === base) {
          await take(space, theirs);
          await agree(space, theirs, stamp);
        } else {
          const both = merge(mine, theirs, machine);
          await take(space, both);
          merged.set(space, `Edited here and on ${machine} at once: both versions are in the pad.`);
          await agree(space, both, await writeRemote(machine, id, both, stamp));
        }
      }
      syncErrors.delete(space);
      return true;
    } catch (err) {
      if (err instanceof Stale) {
        stamps.delete(space);
        continue;
      }
      syncErrors.set(space, `Not synced with ${machine}: ${err?.message ?? err}`);
      return false;
    }
  }
  return true;
}

// True when the pad has no edits that haven't been saved yet.
const isClean = (space) => !texts.has(space) || texts.get(space) === synced.get(space);

// Deletes pads and images whose space has closed on a machine that reports its
// spaces. A synced pad (it has a .base) is deleted on its machine too; its .base
// stays until that works, so a later sweep tries again.
async function sweep(live, ready) {
  if (!(await fs.exists(dir()))) return;
  for (const name of await fs.readdir(dir())) {
    const suffix = [".md", ".images", ".base"].find((s) => name.endsWith(s));
    if (!suffix) continue;
    const space = decodeURIComponent(name.slice(0, -suffix.length));
    const machine = machineOf(space);
    if (live.has(space) || !ready.has(machine)) continue;
    if (suffix === ".base") {
      try {
        await removeRemote(machine, encodeURIComponent(space.slice(machine.length + 1)));
      } catch {
        continue;
      }
    }
    for (const map of [texts, synced, bases, stamps, lastPoll, syncErrors, merged]) map.delete(space);
    unpushed.delete(space);
    await sh('rm -rf "$1"', `${dir()}/${name}`);
  }
}

// Paste each selected text/image part without Enter, then restore all clipboard
// formats. One send at a time keeps clipboard saves and restores from racing.
async function pasteInto(terminal, parts, cx) {
  if (sending) throw new Error("A paste is already in progress.");
  sending = true;
  let tmp, saved, count;
  const wait = (ms, action = () => {}) => new Promise((resolve, reject) => {
    cx.timer.after(ms, (cx) => {
      try { action(cx); resolve(); } catch (err) { reject(err); }
    });
  });
  try {
    await ensureDir();
    tmp = (await sh('umask 077; mktemp -d "$1/.send-XXXXXX"', dir())).trim();
    saved = `${tmp}/clipboard.json`;
    count = await clipboard("save", saved);
    for (const part of parts) {
      let path = `${tmp}/payload`;
      if (part.image) path = `${dir()}/${part.image}`;
      else await fs.writeFile(path, part.text);
      if (await clipboard("count") !== count) throw new Error("Clipboard changed during send; paste stopped.");
      count = await clipboard(part.image ? "image" : "text", path, count, saved);
      run("pane.focus", { terminal });
      await wait(60, () => run("terminal.paste"));
      await wait(400);
    }
  } finally {
    try {
      if (saved && count !== undefined) await clipboard("restore", saved, count);
    } finally {
      try {
        if (tmp) await sh('rm -rf "$1"', tmp);
      } finally {
        sending = false;
      }
    }
  }
}

// Cmd+Shift+J opens the pad, then focuses it, then closes it. The button just
// opens or closes it (pass hide: true).
function toggle({ hide = state.padFocused } = {}) {
  const f = focused();
  if (!panelShown()) {
    state.wantFocus = true;
    run("layout.show", { id: PANEL });
  } else if (hide) {
    run("layout.hide", { id: PANEL });
    const t = f?.tab && lastTerminal.get(f.tab);
    if (t) run("pane.focus", { terminal: t });
  } else {
    state.pad?.focus();
  }
}

class Button {
  constructor() {
    this.knownSpaces = "";
    this.listedMachines = new Set();
    this.lastSpace = null;
    this.pending = null;  // panel state asked for on a space switch, not yet applied
    try { this.open = JSON.parse(localStorage.getItem("open") ?? "{}") ?? {}; } catch { this.open = {}; }
  }

  saveOpen() {
    localStorage.setItem("open", JSON.stringify(this.open));
  }

  // Like Files and Changes: each space remembers whether its pad was open.
  syncPanel(space) {
    if (!space) return;
    const shown = panelShown();
    if (space !== this.lastSpace) {
      this.lastSpace = space;
      const want = !!this.open[space];
      if (want !== shown) {
        this.pending = want;
        run(want ? "layout.show" : "layout.hide", { id: PANEL });
      }
      return;
    }
    if (this.pending !== null) {
      if (shown !== this.pending) return;
      this.pending = null;
    }
    if (!!this.open[space] !== shown) {
      if (shown) this.open[space] = true;
      else delete this.open[space];
      this.saveOpen();
    }
  }

  init(cx) {
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "toggle") toggle();
        cx.notify();
      }
    });
  }

  // Runs on every render: focus and space changes both re-render.
  track(cx) {
    const f = focused();
    if (f?.tab && f.terminal) lastTerminal.set(f.tab, f.terminal);
    if (!checking()) this.syncPanel(f?.space);

    // A machine that isn't ready lists none of its spaces; keep those pads.
    const ready = new Set(machines().filter((m) => m.layout === "ready").map((m) => m.name ?? ""));
    const key = spaces().map((s) => s.id).sort().join("\n") + "|" + [...ready].sort().join(",");
    if (key === this.knownSpaces || checking()) return;
    this.knownSpaces = key;
    // Saves that couldn't reach their machine go over once it's back.
    for (const space of unpushed) {
      if (ready.has(machineOf(space))) cx.spawn(async () => serial(space, () => syncRemote(space)).catch(() => {}));
    }
    const live = new Set(spaces().map((s) => s.id));
    // A machine with no spaces yet may still be loading: leave its pads alone.
    // Once it has listed spaces, an empty list means its last space closed.
    for (const m of this.listedMachines) if (!ready.has(m)) this.listedMachines.delete(m);
    for (const s of spaces()) if (ready.has(s.machine ?? "")) this.listedMachines.add(s.machine ?? "");
    for (const m of [...ready]) if (!this.listedMachines.has(m)) ready.delete(m);
    const gone = Object.keys(this.open).filter((id) => !live.has(id) && ready.has(id.includes("/") ? id.split("/")[0] : ""));
    if (gone.length) {
      for (const id of gone) delete this.open[id];
      this.saveOpen();
    }
    cx.spawn(async () => sweep(live, ready));
  }

  render(cx) {
    this.track(cx);
    const t = theme();
    const on = panelShown();
    return h_flex()
      .size_full()
      .items_center()
      .pr(10)
      .bg(t.chrome)
      .border_b(1)
      .border_color(t.border)
      .child(
        h_flex()
          .id("scratchpad-button")
          .h(26).px(8).gap(5).flex_none().items_center().rounded(6)
          .text_size(12)
          .bg(on ? t.selected : t.chrome)
          .text_color(on ? t.foreground : t.muted)
          .hover((s) => s.bg(t.hover))
          .on_click(() => toggle({ hide: true }))
          .child(svg(ICON).size(14))
          .child("Pad"),
      );
  }
}

class Pad {
  constructor() {
    this.space = null;
    this.loading = false;
    this.saveTask = null;
    this.lastSend = 0;
    this.cmdHeld = false;
    this.armed = null;  // text and selection when Cmd went down
    this.hasSelection = false;
    this.empty = true;
    this.pollTask = null;
    this.polling = false;
    this.failures = 0;
  }

  init(cx) {
    state.pad = this;
    const t = theme();
    this.editor = EditorState.new({
      language: "markdown",
      value: "",
      font_family: settings().font_family,
      line_numbers: false,
      folding: false,
      soft_wrap: true,
      syntax: {
        keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4,
        type: t.ansi6, number: t.ansi3, constant: t.ansi3, punctuation: t.muted,
      },
    });
    this.editor.on("change", (_e, cx) => this.changed(cx));
    this.editor.on("focus", () => { state.padFocused = true; });
    this.editor.on("blur", () => { state.padFocused = false; });
    // The editor submits on plain Enter too; only Cmd+Enter sends.
    this.editor.on("submit", (_e, cx) => { if (this.cmdHeld && this.armed) this.trySend(cx, this.armed); });
    this.editor.on("paste_other", (_e, cx) => this.addImages([null], cx));
    // Cmd+Enter still reaches the editor first as a newline; isCmdEnterEdit
    // undoes that. These bindings cover builds where the editor lets it through.
    cx.bind_keys([
      { keystroke: "cmd-enter", action: SEND, context: "ScratchPad" },
      { keystroke: "cmd-enter", action: SEND, context: "ScratchPad > Editor" },
      { keystroke: "cmd-enter", action: SEND, context: "ScratchPad > Input" },
    ]);

    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.focus();
        if (c === "send") this.trySend(cx, this.snapshot());
        cx.notify();
      }
    });
    if (checking()) return;

    // Another copy of the mod, or another program, can change a pad's file.
    cx.spawn(async (cx) => {
      await ensureDir();
      for (;;) {
        const paths = await watchFolder(dir());
        if (this.space && paths.some((p) => p === dir() || p === fileFor(this.space))) this.refresh(cx);
      }
    });
  }

  // Re-reads the shown pad's file and shows it, unless there are unsaved edits.
  refresh(cx) {
    const space = this.space;
    if (!space || this.refreshing || !isClean(space)) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        const text = await readPad(space);
        if (text === synced.get(space) || !isClean(space)) return;
        texts.set(space, text);
        synced.set(space, text);
        if (this.space === space) this.show(text);
        cx.notify();
      } catch {
        // Keep showing what we have.
      } finally {
        this.refreshing = false;
      }
    });
  }

  // The machine to ask for changes to the shown pad, or null when it shouldn't be asked.
  pollMachine() {
    const machine = this.space ? machineOf(this.space) : "";
    if (!machine || checking() || !panelShown() || !appWindow()?.visible || !isReady(machine)) return null;
    return machine;
  }

  // Called on every render. A hidden or minimized pad lets its timer lapse, and
  // the next render starts it again.
  schedulePoll(cx) {
    if (this.polling || !this.pollMachine()) return;
    const every = Math.min(POLL_MAX_MS, (appWindow()?.active ? POLL_MS : POLL_IDLE_MS) * 2 ** Math.min(this.failures, 4));
    const due = (lastPoll.get(this.space) ?? 0) + every;
    if (this.pollTask && this.pollDue <= due) return;
    this.pollTask?.cancel();
    this.pollDue = due;
    this.pollTask = cx.timer.after(Math.max(0, due - Date.now()), (cx) => {
      this.pollTask = null;
      if (!this.pollMachine()) return;
      const space = this.space;
      this.polling = true;
      lastPoll.set(space, Date.now());
      cx.spawn(async (cx) => {
        const ok = await serial(space, () => syncRemote(space)).catch(() => false);
        this.failures = ok ? 0 : this.failures + 1;
        this.polling = false;
        cx.notify();
      });
    });
  }

  focus() {
    this.editor.focus();
  }

  // Follows the focused space: saves nothing, just swaps the shown text.
  follow(cx) {
    const space = focused()?.space ?? null;
    if (!space || space === this.space) return;
    this.space = space;
    this.status = null;
    this.failures = 0;
    if (texts.has(space)) {
      this.show(texts.get(space));
      this.refresh(cx);
      return;
    }
    // Until it loads, show nothing rather than the last space's text.
    this.show("");
    cx.spawn(async (cx) => {
      try {
        await loadText(space);
        if (this.space === space) this.show(texts.get(space));
      } catch (err) {
        if (this.space === space) state.saveError = `Couldn't read the pad: ${err?.message ?? err}`;
      }
      cx.notify();
    });
  }

  show(text) {
    this.empty = text === "";
    if (this.editor.value() === text) return;
    this.loading = true;
    this.editor.set_value(text);
    this.loading = false;
  }

  // The editor emits no selection events; check after each mouse or key release.
  checkSelection(cx) {
    const { start, end } = this.editor.selected_range();
    const has = start !== end;
    if (has !== this.hasSelection) {
      this.hasSelection = has;
      cx.notify();
    }
  }

  snapshot() {
    const range = this.editor.selected_range();
    return { value: this.editor.value(), start: Math.min(range.start, range.end), end: Math.max(range.start, range.end), space: this.space, tab: focused()?.tab };
  }

  addImages(paths, cx) {
    if (checking() || !this.space || !texts.has(this.space) || this.addingImages) return;
    const space = this.space;
    this.addingImages = true;
    cx.spawn(async (cx) => {
      let tmp;
      try {
        await ensureDir();
        tmp = (await sh('umask 077; mktemp -d "$1/.capture-XXXXXX"', dir())).trim();
        for (const [index, path] of paths.entries()) {
          const name = await clipboard("capture", path ?? "", tmp);
          if (!imageName.test(name)) throw new Error("Invalid image name.");
          const relative = `${imageFolder(space)}/${name}`;
          // In place before the reference shows, so its thumbnail loads.
          incoming.add(relative);
          await sh('mkdir -p "$(dirname "$2")" && mv -f "$1" "$2"', `${tmp}/${name}`, `${dir()}/${relative}`);
          if (this.space !== space) break;  // the next save or sweep removes it
          const { value, start, end } = this.snapshot();
          const reference = `![image](${relative})`;
          this.editor.set_value(value.slice(0, start) + reference + value.slice(end));
          const next = start + reference.length;
          this.editor.set_selected_range({ start: index === paths.length - 1 ? start : next, end: next });
          this.changed(cx);
          this.checkSelection(cx);
        }
      } catch (err) {
        this.status = `Image not added: ${err?.message ?? err}`;
      } finally {
        incoming.clear();
        try {
          if (tmp) await sh('rm -rf "$1"', tmp);
        } finally {
          this.addingImages = false;
          cx.notify();
        }
      }
    });
  }

  // Selects an image's reference, so Send pastes that image.
  selectImage(ref, cx) {
    this.editor.set_selected_range({ start: ref.start, end: ref.end });
    this.focus();
    this.checkSelection(cx);
  }

  // Deletes the reference (and its line, if that's all it held); the save removes the file.
  removeImage(ref, cx) {
    const value = this.editor.value();
    const { start } = ref;
    let { end } = ref;
    if ((start === 0 || value[start - 1] === "\n") && value[end] === "\n") end++;
    this.hoveredThumb = null;
    this.editor.set_value(value.slice(0, start) + value.slice(end));
    this.editor.set_selected_range({ start, end: start });
    this.changed(cx);
    this.checkSelection(cx);
    cx.notify();
  }

  preview(ref) {
    openOverlay({
      mod: MOD, kind: "dialog", width: 0.8, height: 0.8,
      props: { role: "preview", image: `data/${MOD}/${ref.path}` },
    });
  }

  // The pad's images under the text. Click one to select it and see it larger;
  // its × removes it.
  thumbnails(t) {
    const refs = this.space ? imageRefs(this.editor.value(), this.space) : [];
    if (!refs.length) return null;
    return h_flex()
      .id("scratchpad-thumbs").flex_none().max_h(150).overflow_y_scroll().flex_wrap()
      .gap(6).px(14).py(8).border_t(1).border_color(t.border)
      .children(refs.map((ref, i) => div()
        .id(`scratchpad-thumb-${i}`)
        .relative().size(64).flex_none().rounded(6).overflow_hidden().cursor_pointer()
        .border_1().border_color(t.border).bg(t.raised)
        .hover((s) => s.border_color(t.accent))
        .on_hover((hovered, cx) => {
          if (hovered) this.hoveredThumb = i;
          else if (this.hoveredThumb === i) this.hoveredThumb = null;
          cx.notify();
        })
        .on_click((_e, cx) => {
          this.selectImage(ref, cx);
          if (ref.here) this.preview(ref);
        })
        .child(ref.here
          ? image(`data/${MOD}/${ref.path}`).size_full()
          : v_flex().size_full().p(4).items_center().justify_center().text_center()
            .text_size(10).text_color(t.dim).child("On another computer"))
        .when(this.hoveredThumb === i, (el) => el.child(
          h_flex()
            .id(`scratchpad-thumb-remove-${i}`)
            .absolute().top(3).right(3).size(18).rounded(9).items_center().justify_center()
            .bg(t.background).border_1().border_color(t.border)
            .text_size(12).text_color(t.foreground).cursor_pointer()
            .hover((s) => s.bg(t.hover))
            .on_click((_e, cx) => {
              cx.stop_propagation();
              this.removeImage(ref, cx);
            })
            .child("×")))));
  }

  onModifiers(e, cx) {
    const held = !!e.modifiers?.platform;
    if (held && !this.cmdHeld) this.armed = this.snapshot();
    this.cmdHeld = held;
    if (!held) {
      this.armed = null;
      this.checkSelection(cx);  // macOS sends no key-up while Cmd is held (Cmd+A)
    }
  }

  // Cmd+A and other Cmd chords change the selection without a key-up or mouse-up.
  // Select-all is done here too (the editor's own run is harmless, this is the
  // same range), so the button updates in the same press with no timer. Other
  // keys are checked straight away; releasing Cmd checks once more. Either way
  // re-arm, so a Cmd+Enter that follows sees the new selection.
  onKeyDown(e, cx) {
    if (e.key === "enter") return;
    if (e.keystroke === "cmd-a") this.editor.set_selected_range({ start: 0, end: this.editor.value().length });
    this.checkSelection(cx);
    if (this.cmdHeld) this.armed = this.snapshot();
  }

  // The editor turns Cmd+Enter into a newline over the selection. Spot that edit,
  // put the text and selection back exactly as they were, and send instead.
  isCmdEnterEdit(value) {
    const a = this.armed;
    if (!this.cmdHeld || !a || value === a.value) return false;
    const head = a.value.slice(0, a.start), tail = a.value.slice(a.end);
    if (!value.startsWith(head) || !value.endsWith(tail)) return false;
    const inserted = value.slice(head.length, value.length - tail.length);
    return /^\r?\n[ \t]*$/.test(inserted);
  }

  changed(cx) {
    if (this.loading || !this.space) return;
    if (this.isCmdEnterEdit(this.editor.value())) {
      const a = this.armed;
      this.loading = true;
      this.editor.set_value(a.value);
      this.editor.set_selected_range({ start: a.start, end: a.end });
      this.loading = false;
      this.trySend(cx, a);
      return;
    }
    const space = this.space;
    if (!texts.has(space)) return;  // not loaded yet
    if (this.status || merged.has(space)) {
      this.status = null;
      merged.delete(space);  // they've seen it: they're editing the pad
      cx.notify();
    }
    const empty = this.editor.value() === "";
    if (empty !== this.empty) {
      this.empty = empty;
      cx.notify();
    }
    texts.set(space, this.editor.value());
    if (checking()) return;
    this.saveTask?.cancel();
    this.saveTask = cx.timer.after(400, (cx) => {
      cx.spawn(async (cx) => {
        await serial(space, () => saveText(space, texts.get(space) ?? ""));
        cx.notify();
      });
    });
  }

  // The key binding and the editor's own submit can both fire for one press.
  trySend(cx, snap) {
    const now = Date.now();
    if (now - this.lastSend < 300) return;
    this.lastSend = now;
    const s = snap ?? this.snapshot();
    cx.spawn(async (cx) => {
      try {
        this.status = await this.send(s, cx);
      } catch (err) {
        this.status = `Send failed: ${err?.message ?? err}`;
      }
      cx.notify();
    });
  }

  // Reads the pad, never writes it: a failed send leaves the text as it was.
  async send({ value, start, end, space = this.space, tab = focused()?.tab }, cx) {
    const text = value.slice(start, end);
    if (!text.trim()) return "Highlight the text you want to send.";

    const target = tab && lastTerminal.get(tab);
    if (!target) return "No terminal to send to yet: click one first.";
    const parts = [];
    let offset = start;
    for (const ref of imageRefs(value, space)) {
      if (ref.end <= start || ref.start >= end) continue;
      if (ref.start < start || ref.end > end) return "Highlight the entire image reference to send it.";
      if (!ref.here) return "That image was added on another computer, so it can't be sent from here.";
      if (ref.start > offset) parts.push({ text: value.slice(offset, ref.start) });
      parts.push({ image: ref.path });
      offset = ref.end;
    }
    if (offset < end) parts.push({ text: value.slice(offset, end) });
    await pasteInto(target, parts, cx);
    return null;
  }

  headerNote() {
    return state.saveError ?? syncErrors.get(this.space) ?? merged.get(this.space) ?? null;
  }

  // Shown over an empty pad. No mouse handlers, so clicks reach the editor.
  hint(t) {
    const line = (text) => div().child(text);
    return v_flex()
      .absolute().inset_0().px(24).gap(6)
      .items_center().justify_center().text_center()
      .text_size(12).text_color(t.dim)
      .child(div().text_color(t.muted).child("Notes for this space"))
      .child(line("Highlight text, then ⌘↵ to send"))
      .child(line("Paste or drop images"))
      .child(line("⌘⇧J to toggle"));
  }

  render(cx) {
    this.follow(cx);
    this.schedulePoll(cx);
    if (state.wantFocus && panelShown()) {
      state.wantFocus = false;
      this.focus();
    }
    const t = theme();
    const thumbs = this.thumbnails(t);
    return v_flex()
      .id("scratchpad")
      .key_context("ScratchPad")
      .on_action(SEND, (_e, cx) => this.trySend(cx, this.snapshot()))
      .on_modifiers_changed((e, cx) => this.onModifiers(e, cx))
      .on_drop((e, cx) => this.addImages(e.paths ?? [], cx))
      .size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(
        h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().font_semibold().child("Scratch Pad"))
          .when(!!this.headerNote(), (el) => el.child(
            div().text_size(11).text_color(t.dim).truncate().child(this.headerNote()))),
      )
      .child(
        div().id("scratchpad-editor").relative().flex_1().min_h(0).p(8)
          .on_mouse_up("left", (_e, cx) => this.checkSelection(cx))
          .on_key_up((_e, cx) => this.checkSelection(cx))
          .on_key_down((e, cx) => this.onKeyDown(e, cx))
          .child(Editor.new(this.editor))
          .when(this.empty, (el) => el.child(this.hint(t))),
      )
      .when(!!thumbs, (el) => el.child(thumbs))
      .child(
        h_flex().flex_none().px(14).py(8).gap(8).items_center().justify_between()
          .border_t(1).border_color(t.border).text_size(11)
          // Why the last send didn't happen; cleared by typing or switching spaces.
          .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(this.status ?? ""))
          .child(
            h_flex()
              .id("scratchpad-send")
              .flex_none().h(24).px(10).gap(6).items_center().rounded(6)
              .border_1().border_color(t.border).bg(t.raised)
              .text_color(this.hasSelection ? t.foreground : t.dim)
              .when(this.hasSelection, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
              .when(!this.hasSelection, (el) => el.opacity(0.5))
              // Take the selection on press, before the editor loses focus.
              .on_mouse_down("left", () => { this.pressed = this.snapshot(); })
              .on_click((_e, cx) => {
                // Judge by the selection at press time, not the cached flag.
                const snap = this.pressed ?? this.snapshot();
                this.pressed = null;
                if (snap.start === snap.end) return;
                this.trySend(cx, snap);
              })
              .child("Send")
              .child(div().opacity(0.7).child("⌘↵")),
          ),
      );
  }
}

// A pad image in a dialog, at its own size or shrunk to fit. image() fills its
// box and crops, so the box takes the image's shape. Click or Esc closes it.
class Preview {
  init(cx) {
    this.natural = null;
    this.loaded = false;
    this.box = null;
    cx.spawn(async (cx) => {
      try {
        // Pad images are always PNG: width and height are big-endian at bytes 16 and 20.
        const b = await fs.readFile(`${appHome()}/${props().image}`);
        const at = (i) => ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
        if (b.length >= 24 && at(16) > 0 && at(20) > 0) this.natural = { width: at(16), height: at(20) };
      } catch {
        // Shown filling the dialog instead.
      }
      this.loaded = true;
      cx.notify();
    });
  }

  render() {
    const t = theme();
    const p = props();
    const pad = 12;
    let picture = image(p.image).size_full();
    if (this.natural && this.box) {
      const { width, height } = this.natural;
      const scale = Math.min(1, (this.box.width - 2 * pad) / width, (this.box.height - 2 * pad) / height);
      picture = image(p.image).w(Math.max(1, Math.floor(width * scale))).h(Math.max(1, Math.floor(height * scale)));
    }
    return h_flex()
      .id("scratchpad-preview")
      .size_full().p(pad).items_center().justify_center().bg(t.background).cursor_pointer()
      .on_size_change((size, cx) => {
        if (this.box?.width === size.width && this.box?.height === size.height) return;
        this.box = size;
        cx.notify();
      })
      .on_click(() => closeOverlay(p.overlay))
      .when(this.loaded && (!this.natural || !!this.box), (el) => el.child(picture));
  }
}

export default class Scratchpad extends View {
  init(p, cx) {
    const role = (props() ?? p)?.role;
    this.role = role === "button" ? new Button() : role === "preview" ? new Preview() : new Pad();
    this.role.init(cx);
  }

  render(cx) {
    return this.role.render(cx);
  }
}
