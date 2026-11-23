#!/bin/sh
# Installs a mod from this repo into Herdr.
#
#   ./install.sh NAME [options]   install mods/NAME
#   ./install.sh NAME --remove    take it out again
#   ./install.sh                  list the mods in this repo
#
# Copies mods/NAME/src into Herdr's mods folder, checks it, and merges
# mods/NAME/keys.json into your keys.json (backed up once as keys.json.bak).
# A mod that needs more, such as layout changes, ships mods/NAME/hooks/install.sh,
# which is run in place of the default steps and takes the mod's own options.
set -eu
repo="$(cd "$(dirname "$0")" && pwd)"
name="${1:-}"
if [ -z "$name" ]; then
  sed -n '2,11p' "$0" | sed 's/^# \{0,1\}//'
  echo; echo "Mods:"; for d in "$repo"/mods/*/; do echo "  $(basename "$d")"; done
  exit 1
fi
shift

home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
mod="$repo/mods/$name"
src="$mod/src"
dest="$home/mods/$name"
command -v herdr-app >/dev/null || { echo "herdr-app not found on PATH" >&2; exit 1; }
[ -d "$home" ] || { echo "no Herdr home at $home (has Herdr been run?)" >&2; exit 1; }
[ -d "$src" ] || { echo "no mod at $src" >&2; exit 1; }

# Helpers for the default steps and for hooks/install.sh.
need_python() { command -v python3 >/dev/null || { echo "python3 is needed to edit Herdr's config" >&2; exit 1; }; }

copy_mod() {   # asks before replacing a different mod of the same name
  if [ -d "$dest" ] && ! [ -L "$dest" ] && ! diff -rq -x jsconfig.json -x '*.d.ts' "$src" "$dest" >/dev/null 2>&1; then
    if [ -t 0 ]; then printf 'A different mod already lives at %s. Replace it? [y/N] ' "$dest"; read -r a
      [ "$a" = y ] || [ "$a" = Y ] || { echo "aborted"; exit 1; }
    else echo "replacing $dest"; fi
  fi
  [ -L "$dest" ] && rm "$dest"
  mkdir -p "$dest"
  rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$src/" "$dest/"
  herdr-app check "$dest"
}

remove_mod() { rm -rf "$dest"; }

add_keys() {   # [layout]: layout-scoped keys apply to this layout
  [ -f "$mod/keys.json" ] || return 0
  need_python; python3 "$repo/lib/keys.py" add "$home/keys.json" "$mod/keys.json" "$@"
}

remove_keys() {   # [layout]
  [ -f "$mod/keys.json" ] && [ -f "$home/keys.json" ] || return 0
  need_python; python3 "$repo/lib/keys.py" remove "$home/keys.json" "$mod/keys.json" "$@"
}

if [ -f "$mod/hooks/install.sh" ]; then
  . "$mod/hooks/install.sh"
  exit 0
fi

remove=0
while [ $# -gt 0 ]; do
  case "$1" in
    --remove) remove=1 ;;
    *) echo "unknown option $1" >&2; exit 1 ;;
  esac
  shift
done
if [ "$remove" = 1 ]; then
  remove_keys; remove_mod; echo "removed $name. Restart Herdr."; exit 0
fi
copy_mod
add_keys
echo "Done. Restart Herdr to load $name."
