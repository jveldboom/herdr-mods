#!/usr/bin/env python3
"""Merge a mod's key bindings into Herdr's keys.json, or take them out again.

  keys.py add    <keys.json> <mod-keys.json> [layout-name]
  keys.py remove <keys.json> <mod-keys.json> [layout-name]

Any `layout:*` scope in the mod's file is applied to `layout:<layout-name>`;
without a layout name those scopes are skipped. Removing only drops bindings
that still run the mod's command, so the user's own bindings stay.
"""
import sys
from jsonio import load, save

def scopes(modkeys, layout):
    for scope, binds in load(modkeys).items():
        if scope.startswith("layout:"):
            if not layout: print(f"note: skipping {scope} keys (no layout given)"); continue
            scope = f"layout:{layout}"
        yield scope, binds

def add(keys, modkeys, layout=None):
    K = load(keys, {})
    for scope, binds in scopes(modkeys, layout):
        for combo, cmd in binds.items():
            cur = K.setdefault(scope, {}).get(combo)
            if cur not in (None, cmd): print(f"note: {scope} {combo} was {cur}; now {cmd}")
            K[scope][combo] = cmd
    save(keys, K)

def remove(keys, modkeys, layout=None):
    K = load(keys, {})
    for scope, binds in scopes(modkeys, layout):
        cur = K.get(scope, {})
        for combo, cmd in binds.items():
            if cur.get(combo) == cmd: del cur[combo]
        if scope in K and not cur: del K[scope]
    save(keys, K)

if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] in ("add", "remove") and len(a) in (3, 4): {"add": add, "remove": remove}[a[0]](*a[1:])
    else: sys.exit(__doc__)
