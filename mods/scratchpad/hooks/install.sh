# Sourced by the repo's install.sh, which provides $repo, $home, $mod, $dest and
# the copy_mod, remove_mod, add_keys and remove_keys helpers.
#
#   ./install.sh scratchpad                 add to the layout you're using now
#   ./install.sh scratchpad --layout NAME   add to that layout
#   ./install.sh scratchpad --clone         leave your layouts alone; make "<layout>-scratchpad"
#   ./install.sh scratchpad --remove        take it out again (layout, keys and mod)
#
# Shipped layouts (like "main") can't be changed structurally by Herdr, so for those
# a copy named "<layout>-scratchpad" is made automatically. Personal layouts are
# edited in place. Layout and keys files are backed up once as *.bak.
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
need_python

if [ -z "$target" ]; then
  target="$(herdr-app status | python3 -c 'import json,sys; print(json.load(sys.stdin)["layout"])')" \
    || { echo "couldn't read the current layout; is Herdr open? Pass --layout NAME." >&2; exit 1; }
fi
[ -f "$home/layouts/$target.json" ] || { echo "no layout $home/layouts/$target.json" >&2; exit 1; }

if [ "$remove" = 1 ]; then
  for l in "$target" "$target-scratchpad"; do
    [ -f "$home/layouts/$l.json" ] || continue
    if [ "$l" = "$target-scratchpad" ] && ! grep -q '"scratchpad-' "$home/layouts/$l.json" 2>/dev/null; then continue; fi
    python3 "$mod/hooks/layout.py" remove "$home/layouts/$l.json"
    remove_keys "$l"
    echo "removed from layout $l"
  done
  remove_mod; echo "removed mod. Restart Herdr."; exit 0
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

copy_mod
python3 "$mod/hooks/layout.py" add "$home/layouts/$target.json"
add_keys "$target"
echo "Done. Layout: $target. Switch to it with the layout key (Cmd+Shift+L) or restart Herdr; then Cmd+Shift+J opens the pad."
