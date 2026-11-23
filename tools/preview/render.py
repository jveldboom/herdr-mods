#!/usr/bin/env python3
"""Render a mod's preview image (mods/<name>/preview.png) from its preview.json.

  tools/preview/render.py mods/<name>

Reads mods/<name>/preview/preview.json:

  {
    "title": ["Scratch", "Pad"],          one entry per line of the big title
    "bullets": ["...", "..."],            short phrases, about six
    "screenshot": "screenshot.png",       a retina screenshot, next to preview.json
    "crop": [[x0, y0, x1, y1], ...]       screenshot pixels; stacked top to bottom
  }

Each crop rectangle is cut from the screenshot and the pieces are stacked, so a
tall panel can drop its empty middle. Every rectangle must be the same width.
The result is a 1920x1080 PNG in the shared style (template.html), rendered
with headless Chrome. Set CHROME to use a different browser binary.
"""
import html, json, os, struct, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
PANEL_WIDTH, PANEL_MAX_HEIGHT = 560, 860

def png_size(path):
    with open(path, "rb") as f: head = f.read(24)
    if head[:8] != b"\x89PNG\r\n\x1a\n": sys.exit(f"{path} is not a PNG")
    return struct.unpack(">II", head[16:24])

def copy_without_color_profile(src, dest):
    # macOS screenshots are tagged Display P3; Chrome would convert them and the
    # panel would come out darker than the app looks. Keep the raw pixel values.
    with open(src, "rb") as f: data = f.read()
    out, i = [data[:8]], 8
    while i < len(data):
        n, kind = struct.unpack(">I4s", data[i:i + 8])
        if kind not in (b"iCCP", b"cHRM", b"gAMA", b"sRGB"): out.append(data[i:i + 12 + n])
        i += 12 + n
    with open(dest, "wb") as f: f.write(b"".join(out))

def main(mod_dir):
    src = os.path.join(mod_dir, "preview")
    cfg = json.load(open(os.path.join(src, "preview.json")))
    shot = os.path.join(src, cfg["screenshot"])
    img_w, _ = png_size(shot)
    crops = cfg["crop"]
    widths = {x1 - x0 for x0, _, x1, _ in crops}
    if len(widths) != 1: sys.exit("every crop rectangle must be the same width")
    crop_w = widths.pop()
    crop_h = sum(y1 - y0 for _, y0, _, y1 in crops)
    width = min(PANEL_WIDTH, PANEL_MAX_HEIGHT * crop_w / crop_h)
    k = width / crop_w

    segments = "\n".join(
        f'      <div style="height: {(y1 - y0) * k:.2f}px; background-image: url(screenshot.png); '
        f'background-size: {img_w * k:.2f}px auto; background-position: {-x0 * k:.2f}px {-y0 * k:.2f}px"></div>'
        for x0, y0, x1, y1 in crops)
    page = open(os.path.join(HERE, "template.html")).read()
    page = (page.replace("{{title}}", "<br>".join(html.escape(t) for t in cfg["title"]))
                .replace("{{bullets}}", "\n".join(f"        <li>{html.escape(b)}</li>" for b in cfg["bullets"]))
                .replace("{{panel_width}}", f"{width:.2f}")
                .replace("{{segments}}", segments))

    out = os.path.join(mod_dir, "preview.png")
    with tempfile.TemporaryDirectory() as tmp:
        copy_without_color_profile(shot, os.path.join(tmp, "screenshot.png"))
        with open(os.path.join(tmp, "page.html"), "w") as f: f.write(page)
        subprocess.run([CHROME, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                        "--force-device-scale-factor=1", "--window-size=1920,1080",
                        f"--screenshot={os.path.abspath(out)}", "file://" + os.path.join(tmp, "page.html")],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    print(f"wrote {out}")

if __name__ == "__main__":
    if len(sys.argv) != 2: sys.exit(__doc__)
    main(sys.argv[1].rstrip("/"))
