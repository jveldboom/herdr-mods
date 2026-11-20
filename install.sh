#!/bin/sh
# Installs a mod from this repo into Herdr and, for scratchpad, wires it into a layout.
#
#   ./install.sh scratchpad                 add to the layout you're using now
#   ./install.sh scratchpad --layout NAME   add to that layout
#   ./install.sh scratchpad --clone         leave your layouts alone; make "<layout>-scratchpad"
#   ./install.sh scratchpad --remove        take it out again (layout, keys and mod)
#
# Shipped layouts (like "main") can't be changed structurally by Herdr, so for those
# a copy named "<layout>-scratchpad" is made automatically. Personal layouts are
# edited in place. Layout and keys files are backed up once as *.bak.
set -eu
name="${1:-}"; [ -n "$name" ] || { sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }
shift
target=""; clone=0; remove=0
while [ $# -gt 0 ]; do
  case "$1" in
    --layout) target="${2:?--layout needs a name}"; shift ;;
    --clone) clone=1 ;;
    --remove) remove=1 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done

repo="$(cd "$(dirname "$0")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
src="$repo/$name/mods/$name"
dest="$home/mods/$name"
command -v herdr-app >/dev/null || { echo "herdr-app not found on PATH" >&2; exit 1; }
[ -d "$home" ] || { echo "no Herdr home at $home (has Herdr been run?)" >&2; exit 1; }
[ -d "$src" ] || { echo "no mod at $src" >&2; exit 1; }

if [ "$name" != scratchpad ]; then   # other mods: just copy
  [ -L "$dest" ] && rm "$dest"; mkdir -p "$dest"
  rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$src/" "$dest/"
  herdr-app check "$dest"; exit 0
fi
command -v python3 >/dev/null || { echo "python3 is needed to edit layouts" >&2; exit 1; }

if [ -z "$target" ]; then
  target="$(herdr-app status | python3 -c 'import json,sys; print(json.load(sys.stdin)["layout"])')" \
    || { echo "couldn't read the current layout; is Herdr open? Pass --layout NAME." >&2; exit 1; }
fi
[ -f "$home/layouts/$target.json" ] || { echo "no layout $home/layouts/$target.json" >&2; exit 1; }

if [ "$remove" = 1 ]; then
  for l in "$target" "$target-scratchpad"; do
    [ -f "$home/layouts/$l.json" ] || continue
    if [ "$l" = "$target-scratchpad" ] && ! grep -q '"scratchpad-' "$home/layouts/$l.json" 2>/dev/null; then continue; fi
    python3 "$repo/patch_layout.py" remove "$home/layouts/$l.json" "$l" "$home/keys.json"
    echo "removed from layout $l"
  done
  rm -rf "$dest"; echo "removed mod. Restart Herdr."; exit 0
fi

# Shipped layouts are listed in installed.json as "layout:<name>"; those must be cloned.
shipped=0
grep -q "\"layout:$target\"" "$home/installed.json" 2>/dev/null && shipped=1
if [ "$clone" = 1 ] || [ "$shipped" = 1 ]; then
  new="$target-scratchpad"
  [ "$shipped" = 1 ] && [ "$clone" = 0 ] && echo "'$target' is a shipped layout; adding to a copy named '$new' instead."
  [ -e "$home/layouts/$new.json" ] || cp "$home/layouts/$target.json" "$home/layouts/$new.json"
  target="$new"
fi

# Install the mod (asks before replacing a scratchpad that isn't this one).
if [ -d "$dest" ] && ! [ -L "$dest" ] && ! diff -rq -x jsconfig.json -x '*.d.ts' "$src" "$dest" >/dev/null 2>&1; then
  if [ -t 0 ]; then printf 'A different mod already lives at %s. Replace it? [y/N] ' "$dest"; read -r a
    [ "$a" = y ] || [ "$a" = Y ] || { echo "aborted"; exit 1; }
  else echo "replacing $dest" ; fi
fi
[ -L "$dest" ] && rm "$dest"
mkdir -p "$dest"
rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$src/" "$dest/"
herdr-app check "$dest"
python3 "$repo/patch_layout.py" add "$home/layouts/$target.json" "$target" "$home/keys.json" "$repo/$name/keys.json"
echo "Done. Layout: $target. Switch to it with the layout key (Cmd+Shift+L) or restart Herdr; then Cmd+Shift+J opens the pad."
