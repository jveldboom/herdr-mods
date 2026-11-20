// Scratch pad: one markdown pad per space, in a layout panel beside the terminals.
//
// Two roles, chosen by props:
//   { role: "button" } — the Pad button beside the tab bar. Always shown, so it
//     receives `scratchpad.toggle`, remembers each tab's last focused terminal, and
//     deletes pads whose space has closed.
//   { role: "pad" }    — the pad itself, in the layout node PANEL. Shows the focused
//     space's text and handles `scratchpad.send`.
//
// A pad is stored on its space's machine, in that machine's
// <Herdr home>/data/scratchpad/<space>.md, so every screen connected to the
// machine shares it. Deleted when the space closes.

import { View, div, svg } from "gpui-kit";
import { Editor, EditorState, h_flex, v_flex } from "gpui-base";
import {
  appHome, checking, exec, focused, layout, machines, nextCommand, props, readTextFile,
  run, settings, spaces, theme, watchFolder,
} from "herdr";
import * as fs from "fs/promises";

const MOD = "scratchpad";
const PANEL = "scratchpad-panel";
const ICON = `mods/${MOD}/pad.svg`;
const SEND = "scratchpad_send";
const POLL_MS = 3000;
const dir = () => `${appHome()}/data/${MOD}`;
const fileFor = (space) => `${dir()}/${encodeURIComponent(space)}.md`;

// Shared by every copy of this mod.
const texts = new Map();         // space id -> pad text
const synced = new Map();        // space id -> text last read from or written to its file
const stamps = new Map();        // remote space id -> file fingerprint when it was last read
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
function whereIs(space) {
  const i = space.indexOf("/");
  return i < 0 ? { machine: null, id: space } : { machine: space.slice(0, i), id: space.slice(i + 1) };
}

async function sh(machine, script, ...args) {
  const r = await exec("sh", ["-c", script, "sh", ...args], { on: machine, timeout: 15000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  return r.stdout;
}

// The pad folder in another machine's Herdr home, which its own window uses too.
const remoteDirs = new Map();
async function remoteDir(machine) {
  if (!remoteDirs.has(machine)) {
    const d = await sh(machine, 'printf %s "${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/scratchpad"');
    if (!d.startsWith("/")) throw new Error(`unexpected Herdr home on ${machine}: ${d}`);
    remoteDirs.set(machine, d);
  }
  return remoteDirs.get(machine);
}

const remotePath = async (machine, id) => `${await remoteDir(machine)}/${encodeURIComponent(id)}.md`;

// Sub-second mtime, size and inode, or "none": cheap to fetch, and it changes on
// any write, in place or by rename. GNU and BusyBox stat take -c, BSD and macOS -f.
async function remoteStamp(machine, id) {
  const out = await sh(machine,
    'if [ -e "$1" ]; then stat -c "%y %s %i" "$1" 2>/dev/null || stat -f "%Fm %z %i" "$1"; else echo none; fi',
    await remotePath(machine, id));
  return out.trim();
}

async function ensureDir() {
  if (!(await fs.exists(dir()))) await fs.mkdir(dir(), { recursive: true });
}

// Reads a pad's file: "" when there is none.
async function readPad(space) {
  const { machine, id } = whereIs(space);
  if (!machine) {
    const path = fileFor(space);
    return (await fs.exists(path)) ? await fs.readFile(path, "utf8") : "";
  }
  const text = await readTextFile(await remotePath(machine, id), { on: machine });
  if (text !== null) return text;
  // Older versions kept remote spaces' pads on this computer: move one over.
  const legacy = fileFor(space);
  if (!(await fs.exists(legacy))) return "";
  const old = await fs.readFile(legacy, "utf8");
  await writePad(space, old);
  await fs.unlink(legacy);
  return old;
}

// exec passes text as an argument; Linux caps one at 128 KiB, so write in pieces.
const CHUNK = 30000;
async function writeRemote(machine, path, text) {
  const tmp = `${path}.tmp`;
  await sh(machine, 'mkdir -p "$(dirname "$1")" && : > "$1"', tmp);
  for (let i = 0; i < text.length;) {
    let end = Math.min(i + CHUNK, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;  // keep surrogate pairs whole
    await sh(machine, 'printf %s "$2" >> "$1"', tmp, text.slice(i, end));
    i = end;
  }
  await sh(machine, 'mv -f "$1" "$2"', tmp, path);
}

async function writePad(space, text) {
  const { machine, id } = whereIs(space);
  if (!machine) {
    await ensureDir();
    if (text === "") {
      if (await fs.exists(fileFor(space))) await fs.unlink(fileFor(space));
    } else {
      await fs.writeFile(fileFor(space), text);
    }
    return;
  }
  const path = await remotePath(machine, id);
  if (text === "") await sh(machine, 'rm -f "$1"', path);
  else await writeRemote(machine, path, text);
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
  try {
    await writePad(space, text);
    synced.set(space, text);
    state.saveError = null;
  } catch (err) {
    const { machine } = whereIs(space);
    state.saveError = `Not saved${machine ? ` on ${machine}` : ""}: ${err?.message ?? err}`;
  }
}

// True when the pad has no edits that haven't been saved yet.
const isClean = (space) => !texts.has(space) || texts.get(space) === synced.get(space);

// Deletes pad files whose space has closed on a machine that reports its spaces.
async function sweep(live, ready) {
  if (await fs.exists(dir())) {
    for (const name of await fs.readdir(dir())) {
      if (!name.endsWith(".md")) continue;
      const space = decodeURIComponent(name.slice(0, -3));
      if (live.has(space) || !ready.has(whereIs(space).machine ?? "")) continue;
      texts.delete(space);
      synced.delete(space);
      await fs.unlink(`${dir()}/${name}`);
    }
  }
  for (const machine of ready) {
    if (!machine) continue;
    try {
      const d = await remoteDir(machine);
      const names = (await sh(machine, 'cd "$1" 2>/dev/null && ls -1 || true', d)).split("\n");
      for (const name of names) {
        if (!name.endsWith(".md")) continue;
        const id = decodeURIComponent(name.slice(0, -3));
        if (id.includes("/") || live.has(`${machine}/${id}`)) continue;  // its own remote pads: not ours to judge
        texts.delete(`${machine}/${id}`);
        synced.delete(`${machine}/${id}`);
        stamps.delete(`${machine}/${id}`);
        await sh(machine, 'rm -f "$1"', `${d}/${name}`);
      }
    } catch {
      // Unreachable now; the next change in spaces tries again.
    }
  }
}

// Puts text on the clipboard, pastes it into a terminal without pressing Enter,
// then restores the previous clipboard text.
async function pasteInto(terminal, text, cx) {
  await ensureDir();
  const tmp = `${dir()}/.send`;
  const saved = `${dir()}/.clipboard`;
  const copy = (path) => exec("sh", ["-c", 'pbcopy < "$1"', "sh", path]);
  const before = await exec("pbpaste", []);
  await fs.writeFile(saved, before.stdout ?? "");
  await fs.writeFile(tmp, text);
  const r = await copy(tmp);
  if (r.code !== 0) throw new Error(`pbcopy failed: ${r.stderr}`);
  run("pane.focus", { terminal });
  cx.timer.after(60, (cx) => {
    run("terminal.paste");
    cx.timer.after(400, (cx) => {
      cx.spawn(async () => {
        await copy(saved);
        await fs.unlink(tmp);
        await fs.unlink(saved);
      });
    });
  });
}

function toggle() {
  const f = focused();
  if (!panelShown()) {
    state.wantFocus = true;
    run("layout.show", { id: PANEL });
  } else if (state.padFocused) {
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
    const live = new Set(spaces().map((s) => s.id));
    // A machine with no spaces yet may still be loading: leave its pads alone.
    for (const m of [...ready]) if (!spaces().some((s) => (s.machine ?? "") === m)) ready.delete(m);
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
          .on_click(() => toggle())
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

    // Other screens can edit the same pad: this computer's pads are watched,
    // another machine's are polled (see poll()).
    cx.spawn(async (cx) => {
      await ensureDir();
      for (;;) {
        const paths = await watchFolder(dir());
        if (this.space && !whereIs(this.space).machine &&
            paths.some((p) => p === dir() || p === fileFor(this.space))) this.refresh(cx);
      }
    });
  }

  // A remote pad is re-read every few seconds, but only while the panel shows it.
  // Hidden copies keep their timers, so the timer stops itself once it isn't
  // needed, and render() starts it again.
  wantsPoll() {
    return !checking() && !!this.space && !!whereIs(this.space).machine && panelShown();
  }

  poll(cx) {
    if (this.pollTask || !this.wantsPoll()) return;
    this.pollTask = cx.timer.every(POLL_MS, (cx) => {
      if (!this.wantsPoll()) {
        this.pollTask?.cancel();
        this.pollTask = null;
        return;
      }
      this.refresh(cx);
    });
  }

  // Re-reads the shown pad's file and shows it, unless there are unsaved edits.
  // A remote file is only read when its fingerprint has changed.
  refresh(cx) {
    const space = this.space;
    if (!space || this.refreshing || !isClean(space)) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      try {
        const { machine, id } = whereIs(space);
        const stamp = machine ? await remoteStamp(machine, id) : null;
        if (machine && stamp === stamps.get(space)) return;
        const text = await readPad(space);
        // Taken before the read: a write in between just means one more read next time.
        if (machine) stamps.set(space, stamp);
        if (text === synced.get(space) || !isClean(space)) return;
        texts.set(space, text);
        synced.set(space, text);
        if (this.space === space) {
          this.unreachable = null;
          this.show(text);
        }
        cx.notify();
      } catch {
        // Unreachable for now; keep showing what we have.
      } finally {
        this.refreshing = false;
      }
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
    if (texts.has(space)) {
      this.show(texts.get(space));
      this.refresh(cx);
      return;
    }
    // Until it loads, show nothing rather than the last space's text.
    this.show("");
    this.unreachable = null;
    cx.spawn(async (cx) => {
      try {
        const text = await loadText(space);
        if (this.space === space) this.show(text);
      } catch {
        // The poll keeps retrying; until then edits aren't kept.
        if (this.space === space) this.unreachable = whereIs(space).machine ?? "this computer";
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
    return { value: this.editor.value(), start: Math.min(range.start, range.end), end: Math.max(range.start, range.end) };
  }

  onModifiers(e) {
    const held = !!e.modifiers?.platform;
    if (held && !this.cmdHeld) this.armed = this.snapshot();
    this.cmdHeld = held;
    if (!held) this.armed = null;
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
    if (this.status) {
      this.status = null;
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
        await saveText(space, texts.get(space) ?? "");
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
  async send({ value, start, end }, cx) {
    const text = value.slice(start, end);
    if (!text.trim()) return "Highlight the text you want to send.";

    const tab = focused()?.tab;
    const target = tab && lastTerminal.get(tab);
    if (!target) return "No terminal to send to yet: click one first.";
    await pasteInto(target, text, cx);
    return null;
  }

  // Shown over an empty pad. No mouse handlers, so clicks reach the editor.
  hint(t) {
    const line = (text) => div().child(text);
    return v_flex()
      .absolute().inset_0().px(24).gap(6)
      .items_center().justify_center().text_center()
      .text_size(12).text_color(t.dim)
      .child(div().text_color(t.muted).child("Scratch notes for this space."))
      .child(line("Highlight text, then ⌘↵ or Send to paste it into your last terminal."))
      .child(line("⌘⇧J opens and closes this panel."))
      .child(line("Saved on the space's machine; cleared when the space closes."));
  }

  render(cx) {
    this.follow(cx);
    this.poll(cx);
    if (state.wantFocus && panelShown()) {
      state.wantFocus = false;
      this.focus();
    }
    const t = theme();
    return v_flex()
      .id("scratchpad")
      .key_context("ScratchPad")
      .on_action(SEND, (_e, cx) => this.trySend(cx, this.snapshot()))
      .on_modifiers_changed((e) => this.onModifiers(e))
      .size_full().min_h(0).rounded(10).overflow_hidden()
      .bg(t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(
        h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
          .child(div().font_semibold().child("Scratch Pad"))
          .when(!!this.unreachable, (el) => el.child(
            div().text_size(11).text_color(t.dim).child(`Can't reach ${this.unreachable}: edits won't be saved`)))
          .when(!this.unreachable && !!state.saveError, (el) => el.child(
            div().text_size(11).text_color(t.dim).truncate().child(state.saveError))),
      )
      .child(
        div().id("scratchpad-editor").relative().flex_1().min_h(0).p(8)
          .on_mouse_up("left", (_e, cx) => this.checkSelection(cx))
          .on_key_up((_e, cx) => this.checkSelection(cx))
          .child(Editor.new(this.editor))
          .when(this.empty, (el) => el.child(this.hint(t))),
      )
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
                if (!this.hasSelection) return;
                const snap = this.pressed ?? this.snapshot();
                this.pressed = null;
                this.trySend(cx, snap);
              })
              .child("Send")
              .child(div().opacity(0.7).child("⌘↵")),
          ),
      );
  }
}

export default class Scratchpad extends View {
  init(p, cx) {
    this.role = (props() ?? p)?.role === "button" ? new Button() : new Pad();
    this.role.init(cx);
  }

  render(cx) {
    return this.role.render(cx);
  }
}
