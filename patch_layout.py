#!/usr/bin/env python3
"""Add or remove the Scratch Pad nodes in a Herdr layout, and its key bindings.

  patch_layout.py add    <layout.json> <layout-name> <keys.json> <mod-keys.json>
  patch_layout.py remove <layout.json> <layout-name> <keys.json>

Finds nodes by what they hold, not by id: the block running the `tabs` mod gets
wrapped in a row beside the Pad button, and a hidden panel is added right after
the block that shows the active tab. Idempotent; backs each file up once (.bak).
"""
import json, os, shutil, sys

def load(p):
    with open(p) as f: return json.load(f)

def save(p, d):
    if os.path.exists(p) and not os.path.exists(p + ".bak"): shutil.copy(p, p + ".bak")
    with open(p, "w") as f: json.dump(d, f, indent=2); f.write("\n")

def walk(node, parent=None):
    yield node, parent
    for c in node.get("children", []): yield from walk(c, node)

def find(root, pred):
    return next(((n, p) for n, p in walk(root) if pred(n)), (None, None))

def has_id(root, i): return find(root, lambda n: n.get("id") == i)[0] is not None

def add(layout, name, keys, modkeys):
    L = load(layout)
    if not has_id(L, "scratchpad-button"):
        tabs, parent = find(L, lambda n: n.get("content", {}).get("mod") == "tabs")
        if not tabs: sys.exit("This layout has no block running the `tabs` mod, so there is nowhere to put the Pad button.")
        row = {"id": "tabs-row", "type": "row", "size": tabs.get("size", {"px": 42}), "resizable": False,
               "children": [tabs, {"id": "scratchpad-button", "type": "block", "size": {"px": 64},
                                   "content": {"mod": "scratchpad", "props": {"role": "button"}}}]}
        tabs["size"] = {"weight": 1}
        parent["children"][parent["children"].index(tabs)] = row
    if not has_id(L, "scratchpad-panel"):
        main, parent = find(L, lambda n: n.get("content", {}).get("tab") == "active")
        if not main: sys.exit("This layout has no block showing the active tab, so there is nowhere to put the panel.")
        parent["children"].insert(parent["children"].index(main) + 1,
            {"id": "scratchpad-panel", "type": "column", "hidden": True, "size": {"px": 360}, "min": 240, "max": 900,
             "children": [{"id": "scratchpad-pad", "type": "block",
                           "content": {"mod": "scratchpad", "props": {"role": "pad"}}}]})
    save(layout, L)
    K = load(keys)
    for scope, binds in load(modkeys).items():
        scope = f"layout:{name}" if scope.startswith("layout:") else scope
        for combo, cmd in binds.items():
            cur = K.setdefault(scope, {}).get(combo)
            if cur not in (None, cmd): print(f"note: {scope} {combo} was {cur}; now {cmd}")
            K[scope][combo] = cmd
    save(keys, K)

def remove(layout, name, keys):
    L = load(layout)
    row, rp = find(L, lambda n: n.get("id") == "tabs-row")
    if row:
        tabs = row["children"][0]; tabs["size"] = row.get("size", {"px": 42})
        rp["children"][rp["children"].index(row)] = tabs
    panel, pp = find(L, lambda n: n.get("id") == "scratchpad-panel")
    if panel: pp["children"].remove(panel)
    save(layout, L)
    K = load(keys)
    K.pop(f"layout:{name}", None); K.pop("mod:scratchpad", None)
    save(keys, K)

if __name__ == "__main__":
    a = sys.argv[1:]
    if a and a[0] == "add" and len(a) == 5: add(*a[1:])
    elif a and a[0] == "remove" and len(a) == 4: remove(*a[1:])
    else: sys.exit(__doc__)
