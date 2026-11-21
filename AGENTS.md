# Project guide

This repository contains mods for Herdr, a terminal app. The current mod is
Scratch Pad: a per-space Markdown notepad that can paste selected text into the
last focused terminal.

## Where things live

- `README.md`: user-facing overview, install/use instructions, requirements.
- `scratchpad/RECIPE.md`: detailed behavior, implementation notes, pitfalls,
  and the acceptance checklist. Read this before changing the mod.
- `scratchpad/mods/scratchpad/`: mod source (`main.js`, `mod.json`, and assets).
- `scratchpad/keys.json`: key bindings merged during installation.
- `install.sh` and `patch_layout.py`: install/remove the mod and wire it into a
  Herdr layout. The installer changes files under the Herdr config directory;
  don't run it unless installation or that integration is part of the task.

## Project constraints

- The mod uses Herdr's JavaScript mod API, not a standalone app framework.
  Preserve Herdr-specific behaviors and APIs described in the recipe.
- Sending uses macOS `pbcopy`/`pbpaste` and Cmd-based shortcuts. Remote-space
  file operations use POSIX `sh`; don't assume remote machines are macOS.
- Keep the installer idempotent and preserve its backup and `--remove`
  behavior when changing layout integration.
- Validate mod changes with `herdr-app check scratchpad/mods/scratchpad` when
  Herdr's CLI is available. Use the recipe's “Done when” list for behavior
  changes; avoid running install/remove during checks because those modify the
  user's Herdr configuration.

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
