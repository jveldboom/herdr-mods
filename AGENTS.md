# Project guide

This repository contains mods for the Herdr desktop app. Each mod lives in
`mods/<name>/`. The current mod is Scratch Pad: a per-space Markdown notepad
that can paste selected text and images into the last focused terminal.

## Where things live

- `README.md`: repo overview, the list of mods, and the general install steps.
- `install.sh`: installs or removes any mod (`./install.sh <name> [options]`).
  It copies `mods/<name>/src/`, merges `mods/<name>/keys.json`, or sources
  `mods/<name>/hooks/install.sh` in their place when that hook exists. The
  installer changes files under the Herdr config directory; don't run it
  unless installation or that integration is part of the task. To test it,
  point `HERDR_APP_HOME` at a temporary folder.
- `lib/`: Python helpers shared by the installer and hooks (`keys.py` merges
  and removes key bindings; `jsonio.py` reads and writes JSON with a one-time
  `.bak` backup).
- `.github/workflows/release.yaml`: makes a GitHub release on every push to
  `main`, versioned from Conventional Commits.
- `tools/preview/`: `render.py` builds `mods/<name>/preview.png` from
  `mods/<name>/preview/preview.json` and a screenshot, using the shared
  `template.html`. Never edit a `preview.png` directly; change the JSON,
  screenshot or template and re-render (see "Preview images" in `README.md`).
- `mods/<name>/README.md`: the mod's user docs (use, requirements, access).
- `mods/scratchpad/RECIPE.md`: detailed behavior, implementation notes,
  pitfalls, and the acceptance checklist. Read this before changing the mod.
- `mods/scratchpad/src/`: mod source (`main.js`, `clipboard.js`, `mod.json`,
  and assets).
- `mods/scratchpad/keys.json`: key bindings merged during installation.
- `mods/scratchpad/hooks/`: `install.sh` (layout choice, `--layout`,
  `--clone`, `--remove`) and `layout.py`, which adds the Pad button and panel
  to a Herdr layout.

## Adding a mod

Create `mods/<name>/src/` with `mod.json` and code, plus a `README.md`.
Optionally add `keys.json` and `hooks/install.sh`. Add `preview/preview.json`
and a screenshot, then run `tools/preview/render.py mods/<name>`. Add the mod to the
table in the root `README.md`.

## Project constraints

- Mods use Herdr's JavaScript mod API, not a standalone app framework.
  Preserve Herdr-specific behaviors and APIs described in the recipe.
- Clipboard and image handling use macOS `osascript` with AppKit
  (`clipboard.js`), and the shortcuts are Cmd-based. Pads and images are stored
  only on this computer; nothing runs on remote machines.
- Keep the installer idempotent and preserve its backup and `--remove`
  behavior when changing layout integration.
- Validate mod changes with `herdr-app check mods/<name>/src` when
  Herdr's CLI is available. Use the recipe's “Done when” list for behavior
  changes; avoid running install/remove during checks because those modify the
  user's Herdr configuration.

## Branches and pull requests

Never push directly to `main`. Make every change on a branch, push the branch,
and open a pull request against `main`. Each merge to `main` creates a release,
so the PR title should be a Conventional Commit too (it becomes the squash
commit).

## Commit messages

Use Conventional Commits for all commit messages, following this format:

`<type>(<optional scope>): <description>`

Examples:

- `feat: add export command`
- `fix(parser): handle empty input`
- `docs: clarify installation steps`

Use standard types such as `feat`, `fix`, `docs`, `style`, `refactor`, `perf`,
`test`, `build`, `ci`, and `chore`. Mark breaking changes with `!` after the
type or scope, and explain them in the commit body or footer.
