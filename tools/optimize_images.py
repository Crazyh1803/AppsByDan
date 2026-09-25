#!/usr/bin/env python3
"""Generate web-sized derivatives of the source artwork.

The originals committed to this repo are 2-5 MB apiece, which is far too heavy
to put on a landing page. This resizes them and writes a .webp plus a
same-format fallback into assets/img/, which is what the pages actually load.

Usage:  pip install Pillow && python3 tools/optimize_images.py
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "img"

# source -> (output stem, target width, fallback format, quality)
JOBS = [
    ("pantryLogic.png", "pantry-logic", 1600, "JPEG", 82),
    ("assets/img/GagaPitTesters.webp", "gaga-pit-showdown-v2", 1600, "JPEG", 74),
    ("assets/img/PixelHeadshot.jpg", "dan-portrait-v2", 480, "JPEG", 82),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for src_name, stem, width, fmt, quality in JOBS:
        src = ROOT / src_name
        if not src.exists():
            print(f"skip {src_name} (not found)")
            continue

        im = Image.open(src)
        if im.width > width:
            height = round(im.height * width / im.width)
            im = im.resize((width, height), Image.LANCZOS)

        # JPEG has no alpha channel; flatten onto the site background.
        if fmt == "JPEG" and im.mode in ("RGBA", "LA", "P"):
            im = im.convert("RGBA")
            flat = Image.new("RGB", im.size, (18, 18, 18))
            flat.paste(im, mask=im.split()[-1])
            im = flat
        elif im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGB")

        ext = "jpg" if fmt == "JPEG" else fmt.lower()
        for path, kwargs in (
            (OUT / f"{stem}.webp", {"format": "WEBP", "quality": quality, "method": 6}),
            (OUT / f"{stem}.{ext}", {"format": fmt, "quality": quality, "optimize": True, "progressive": True}),
        ):
            im.save(path, **kwargs)
            print(f"{path.relative_to(ROOT)}  {im.width}x{im.height}  {path.stat().st_size / 1024:.0f} KB")


if __name__ == "__main__":
    main()
