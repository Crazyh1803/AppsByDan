#!/usr/bin/env python3
"""Rebuild the two card banners that aren't hand-made artwork.

True Shuffle has no banner of its own, so one is composed from the app's own
logo on the site's dark theme. Manual Bridge has a banner in its repo, but at
2.07:1 - wider than the card's 16/9 frame - so it is cropped rather than left
to be trimmed unpredictably.

Both write a full-size PNG into assets/img/, which tools/optimize_images.py
then turns into the .webp/.jpg the pages actually load. Run this, then that.

Usage:  pip install Pillow playwright && python3 tools/make_app_banners.py
"""

import base64
import pathlib
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "assets" / "img"

TRUE_SHUFFLE_LOGO = "https://raw.githubusercontent.com/Crazyh1803/spotifyshuffle/gh-pages/favicon.svg"
MANUAL_BRIDGE_BANNER = "https://raw.githubusercontent.com/Crazyh1803/tricaremanualtopdf/main/docs/assets/banner.png"

CHROME = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome"


def true_shuffle() -> None:
    """Logo + wordmark only. The card prints the name and tagline as real text
    right below, so anything more is duplication - and small type here is
    illegible once the card scales the banner down to ~340px wide."""
    from playwright.sync_api import sync_playwright

    svg = urllib.request.urlopen(TRUE_SHUFFLE_LOGO).read().decode()
    b64 = base64.b64encode(svg.encode()).decode()
    html = f"""<body style="margin:0">
<div style="width:1600px;height:900px;background:#121212;position:relative;overflow:hidden;
            font-family:Helvetica,Arial,sans-serif;display:flex;align-items:center;
            justify-content:center;gap:70px">
  <div style="position:absolute;left:-8%;top:-32%;width:1000px;height:1000px;border-radius:50%;
              background:radial-gradient(circle,rgba(138,99,255,.34) 0%,transparent 62%)"></div>
  <div style="position:absolute;right:-14%;bottom:-40%;width:1000px;height:1000px;border-radius:50%;
              background:radial-gradient(circle,rgba(29,185,84,.20) 0%,transparent 62%)"></div>
  <img src="data:image/svg+xml;base64,{b64}" style="width:520px;height:520px;flex:none;position:relative">
  <div style="position:relative;color:#fff;font-size:150px;font-weight:700;
              line-height:.98;letter-spacing:-.035em">True<br>Shuffle</div>
</div></body>"""
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path=CHROME, args=["--no-sandbox"])
        pg = b.new_page(viewport={"width": 1600, "height": 900})
        pg.set_content(html)
        pg.wait_for_timeout(600)
        pg.screenshot(path=str(OUT / "TrueShuffleBanner.png"))
        b.close()
    print("wrote assets/img/TrueShuffleBanner.png  1600x900")


def manual_bridge() -> None:
    from PIL import Image
    import io

    raw = urllib.request.urlopen(MANUAL_BRIDGE_BANNER).read()
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    new_w = int(h * 16 / 9)
    off = (w - new_w) // 2
    out = im.crop((off, 0, off + new_w, h))
    out.save(OUT / "ManualBridgeBanner.png")
    print(f"wrote assets/img/ManualBridgeBanner.png  {out.width}x{out.height}")


if __name__ == "__main__":
    true_shuffle()
    manual_bridge()
    print("\nnow run: python3 tools/optimize_images.py")
