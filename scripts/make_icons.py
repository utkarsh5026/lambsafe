"""Regenerates extension/icons/*.png. Needs Pillow: pip install pillow"""
from pathlib import Path

from PIL import Image, ImageDraw

OUT = Path(__file__).resolve().parent.parent / "extension" / "icons"
S = 512  # draw large, downsample for smooth edges

img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# Rounded-square tile.
d.rounded_rectangle((16, 16, S - 16, S - 16), radius=112, fill=(208, 90, 0, 255))

# Shield.
shield = [(256, 70), (420, 128), (408, 290), (256, 452), (104, 290), (92, 128)]
d.polygon(shield, fill=(255, 244, 232, 255))

# Lambda glyph drawn with strokes so it doesn't depend on installed fonts.
ink = (160, 64, 0, 255)
w = 42
d.line([(196, 150), (236, 150), (340, 372)], fill=ink, width=w, joint="curve")
d.line([(272, 250), (180, 372)], fill=ink, width=w)
for x, y in [(196, 150), (340, 372), (180, 372)]:
    r = w // 2
    d.ellipse((x - r, y - r, x + r, y + r), fill=ink)

OUT.mkdir(parents=True, exist_ok=True)
for size in (16, 32, 48, 128):
    img.resize((size, size), Image.LANCZOS).save(OUT / f"icon{size}.png")
print("wrote", sorted(p.name for p in OUT.glob("icon*.png")))
