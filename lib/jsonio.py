"""Read and write Herdr's JSON config files, backing each up once as *.bak."""
import json, os, shutil

def load(p, default=None):
    if default is not None and not os.path.exists(p): return default
    with open(p) as f: return json.load(f)

def save(p, d):
    if os.path.exists(p) and not os.path.exists(p + ".bak"): shutil.copy(p, p + ".bak")
    with open(p, "w") as f: json.dump(d, f, indent=2); f.write("\n")
