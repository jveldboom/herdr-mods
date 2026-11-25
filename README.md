# herdr-mods

Mods for the [Herdr](https://herdr.dev) desktop app. Each mod adds a feature to Herdr's window, such as a panel, a button or new key bindings, and runs inside Herdr through its JavaScript mod API.

## Mods

| Mod | What it does |
| --- | --- |
| [Scratch Pad](mods/scratchpad/) | A markdown notepad for each space. Highlight text or images and paste them into your last terminal. Text syncs across computers that share a remote space. |

## Install

Clone the repo once, then install mods by name:

```sh
git clone https://github.com/jveldboom/herdr-mods.git ~/herdr-mods
~/herdr-mods/install.sh scratchpad          # install a mod
~/herdr-mods/install.sh scratchpad --remove # take it out again
~/herdr-mods/install.sh                     # list the mods in this repo
```

The installer copies the mod into `~/.config/herdr-app/mods/<name>`, runs `herdr-app check` on it, and merges its key bindings into your `keys.json` (backed up once as `keys.json.bak`). Some mods take extra options; see each mod's README. To update, run `git pull` in the clone and install again.

You need `herdr-app` on your `PATH`, plus `python3` and `rsync`.

## Layout

```
install.sh          installs any mod: ./install.sh <name> [options]
lib/                helpers the installer and mod hooks share (key merging, JSON backups)
mods/<name>/
  README.md         what the mod does and how to use it
  src/              the mod itself; copied to Herdr's mods/<name>/
  keys.json         optional key bindings to merge
  hooks/install.sh  optional; runs in place of the default install steps
  preview/          preview.json and the screenshot behind preview.png
  preview.png       rendered by tools/preview/render.py
tools/preview/      the preview renderer and its shared template
```

To add a mod, create `mods/<name>/src/` with its `mod.json` and code. A `keys.json` next to `src/` is merged on install. If the mod needs more, such as layout changes, add `hooks/install.sh`. The repo's `install.sh` sources it with `$home`, `$mod` and `$dest` set, and the `copy_mod`, `remove_mod`, `add_keys` and `remove_keys` helpers available.

## Preview images

Every mod's `preview.png` uses the same layout: a 1920×1080 dark card with a soft gradient at the top and bottom, the mod's name and a few short bullets on the left, and a screenshot of the mod on the right. Don't edit the PNG by hand; render it:

```sh
tools/preview/render.py mods/<name>
```

The renderer reads `mods/<name>/preview/preview.json` and writes `mods/<name>/preview.png`:

```json
{
  "title": ["Scratch", "Pad"],
  "bullets": ["A markdown pad for each space", "Saved as you type"],
  "screenshot": "screenshot.png",
  "crop": [[252, 100, 1040, 1200], [252, 1830, 1040, 1940]]
}
```

- `title`: one entry per line of the big heading.
- `bullets`: about six short phrases.
- `screenshot`: a full-resolution (Retina) macOS screenshot of the mod in Herdr, saved next to `preview.json`.
- `crop`: rectangles in screenshot pixels, `[left, top, right, bottom]`, stacked top to bottom. Use one rectangle for the whole panel, or several of the same width to cut out empty space. Include the panel's own border.

The shared style lives in `tools/preview/template.html`: fonts, sizes, colors, and the gradient (from `gray-800` at the top through `#0f0f0f` to `gray-900` at the bottom). Change it there so every mod's preview changes together, then re-render each mod. Rendering needs Google Chrome; set `CHROME` to use another Chromium binary.

## Releases

Each push to `main` creates a GitHub release. The version comes from the [Conventional Commits](https://www.conventionalcommits.org/) since the last release, worked out by [action-conventional-versioning](https://github.com/jveldboom/action-conventional-versioning).

## License

[MIT](LICENSE)
