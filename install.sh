#!/bin/sh
# Copies a mod from this repo into Herdr's mods folder and checks it.
# Usage: ./install.sh <mod>      e.g. ./install.sh scratchpad
# Key bindings in <mod>/keys.json are merged by hand (see that mod's README/RECIPE).
set -eu
name="${1:?usage: ./install.sh <mod>}"
repo="$(cd "$(dirname "$0")" && pwd)"
home="${HERDR_APP_HOME:-$HOME/.config/herdr-app}"
src="$repo/$name/mods/$name"
dest="$home/mods/$name"

[ -d "$src" ] || { echo "no mod at $src" >&2; exit 1; }
[ -L "$dest" ] && rm "$dest"
mkdir -p "$dest"
rsync -a --delete --exclude jsconfig.json --exclude '*.d.ts' "$src/" "$dest/"
herdr-app check "$dest"
