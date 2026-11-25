// Reads and writes a pad's copy on the machine its space runs on, in that
// machine's <Herdr home>/data/scratchpad/<space>.md: the file its own window
// uses for the space. Each call is one `exec` on that machine, except writes
// over CHUNK characters.
//
// A stamp (mtime, size and inode, or "none" for no file) identifies a version.
// Every write replaces the file, so its inode changes even when the mtime is coarse.

import { exec } from "herdr";

const PRELUDE = `set -e
d="\${HERDR_APP_HOME:-$HOME/.config/herdr-app}/data/scratchpad"
f="$d/$1.md"
st() { if [ -e "$1" ]; then stat -c '%y %s %i' "$1" 2>/dev/null || stat -f '%Fm %z %i' "$1"; else echo none; fi; }
`;

export class Stale extends Error {
  constructor() { super("The other machine's copy changed."); }
}

async function sh(machine, script, ...args) {
  const r = await exec("sh", ["-c", PRELUDE + script, "sh", ...args], { on: machine, timeout: 15000 });
  if (r.code === 3) throw new Stale();
  if (r.code !== 0) throw new Error(r.stderr.trim() || `exit ${r.code}`);
  return r.stdout;
}

// exec keeps at most 8 MiB of output: the reply ends with END, so a cut-off one is an error.
const END = "\n--scratchpad-end--";

// { stamp, text }. text is undefined when the stamp is still `known`, so an
// unchanged pad costs one stat. No file reads as "".
export async function readRemote(machine, id, known) {
  const out = await sh(machine,
    `s=$(st "$f"); printf "%s\\n" "$s"; if [ "$s" != "$2" ] && [ "$s" != none ]; then cat "$f"; fi; printf %s "$3"`,
    id, known ?? "", END);
  const nl = out.indexOf("\n");
  const stamp = out.slice(0, nl);
  if (nl < 0 || !stamp || !out.endsWith(END)) throw new Error("The pad on the other machine couldn't be read in full.");
  if (stamp === known) return { stamp, text: undefined };
  return { stamp, text: stamp === "none" ? "" : out.slice(nl + 1, -END.length) };
}

// exec passes text as an argument; Linux caps one at 128 KiB, so write in pieces.
const CHUNK = 30000;

// Replaces the copy with text, only if it is still at stamp `expected`; throws
// Stale otherwise. "" deletes it. Returns the new stamp.
export async function writeRemote(machine, id, text, expected) {
  if (text === "") {
    const out = await sh(machine, '[ "$(st "$f")" = "$2" ] || exit 3; rm -f "$f"; echo none', id, expected);
    return out.trim();
  }
  let tmp = "";
  try {
    for (let i = 0; i < text.length;) {
      let end = Math.min(i + CHUNK, text.length);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;  // keep surrogate pairs whole
      const last = end === text.length ? "1" : "";
      const out = await sh(machine, `t="$3"
if [ -z "$t" ]; then mkdir -p "$d"; t=$(mktemp "$f.XXXXXX"); fi
case "$t" in "$f".*) ;; *) exit 2 ;; esac
printf %s "$4" >> "$t"
if [ -z "$5" ]; then echo "$t"; exit 0; fi
if [ "$(st "$f")" != "$2" ]; then rm -f "$t"; exit 3; fi
chmod 644 "$t"
mv -f "$t" "$f"
st "$f"`, id, expected, tmp, text.slice(i, end), last);
      if (last) return out.trim();
      tmp = out.trim();
      i = end;
    }
  } catch (err) {
    if (tmp) await sh(machine, 'case "$2" in "$f".*) rm -f "$2" ;; esac', id, tmp).catch(() => {});
    throw err;
  }
  return "none";  // not reached: text isn't empty
}

// Deletes the copy, whatever it holds: for a space that has closed.
export async function removeRemote(machine, id) {
  await sh(machine, 'rm -f "$f"', id);
}
