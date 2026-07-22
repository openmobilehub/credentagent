#!/usr/bin/env python3
"""Generate designed card-art PNGs for the CredentAgent demo credentials.

One tasteful card per credential type, sized for the Multipaz wallet's ~1.586:1
card aspect (1000x630). Each card: a diagonal brand gradient, a rounded inner
border, the "UTOPIA / DEMO" issuer chrome, a large native-color emoji glyph, a
title, a subtitle, and a small doctype label along the bottom edge so the art is
self-documenting. Reuses the teal/blue treatment from the original
professional-license card (see f1e3a225.../make_card.py) and parameterizes it.

Run:  python3 make_cards.py        (writes *.png next to this script)
Deps: Pillow only (no numpy required).
"""
from PIL import Image, ImageDraw, ImageFont
import os

W, H = 1000, 630
OUTDIR = os.path.dirname(os.path.abspath(__file__))
HELV = "/System/Library/Fonts/Helvetica.ttc"
EMOJI = "/System/Library/Fonts/Apple Color Emoji.ttc"


def font(size):
    return ImageFont.truetype(HELV, size)


def diagonal_gradient(top, bot):
    """Top-left -> bottom-right diagonal blend. Pure-PIL, no numpy."""
    img = Image.new("RGB", (W, H))
    px = img.load()
    for y in range(H):
        ty = y / H
        for x in range(W):
            t = (x / W) * 0.45 + ty * 0.55
            px[x, y] = (
                int(top[0] + (bot[0] - top[0]) * t),
                int(top[1] + (bot[1] - top[1]) * t),
                int(top[2] + (bot[2] - top[2]) * t),
            )
    return img


def emoji_glyph(char, box=250):
    """Render a native-color emoji, scaled, on transparent bg."""
    try:
        ef = ImageFont.truetype(EMOJI, 160)
        em = Image.new("RGBA", (200, 200), (0, 0, 0, 0))
        ImageDraw.Draw(em).text((20, 10), char, font=ef, embedded_color=True)
        return em.resize((box, box), Image.LANCZOS)
    except Exception as e:  # pragma: no cover - fallback for missing emoji font
        print("  emoji render failed:", e)
        return None


def make_card(filename, top, bot, emoji, title, subtitle, doctype):
    img = diagonal_gradient(top, bot)
    draw = ImageDraw.Draw(img, "RGBA")

    # subtle rounded inner border
    draw.rounded_rectangle([24, 24, W - 24, H - 24], radius=28,
                           outline=(255, 255, 255, 70), width=2)

    # issuer chrome
    draw.text((60, 54), "UTOPIA", font=font(38), fill=(255, 255, 255, 235))
    draw.text((W - 190, 60), "DEMO", font=font(28), fill=(255, 255, 255, 150))

    # emoji glyph, upper-left of the art zone
    glyph = emoji_glyph(emoji)
    if glyph is not None:
        img.paste(glyph, (58, 168), glyph)

    # title + subtitle
    draw.text((60, 452), title, font=font(60), fill=(255, 255, 255, 255))
    draw.text((62, 528), subtitle, font=font(30), fill=(255, 255, 255, 200))

    # doctype label, bottom-right, monospace-ish small
    tw = draw.textlength(doctype, font=font(22))
    draw.text((W - 60 - tw, H - 62), doctype, font=font(22),
              fill=(255, 255, 255, 165))

    out = os.path.join(OUTDIR, filename)
    img.save(out, "PNG")
    print("wrote", filename, os.path.getsize(out), "bytes")


CARDS = [
    # filename, top color, bottom color, emoji, title, subtitle, doctype label
    ("card-mdl.png", (37, 99, 235), (23, 37, 84),
     "\U0001FAAA", "Driver License", "Age over 21 & over 65",
     "org.iso.18013.5.1.mDL"),
    ("card-age.png", (217, 119, 6), (124, 45, 18),
     "\U0001F382", "Age Credential", "Over 21 / Over 65",
     "org.iso.18013.5.1.mDL"),
    ("card-membership.png", (124, 58, 237), (46, 16, 101),
     "⭐", "Membership", "Utopia loyalty tier",
     "org.multipaz.loyalty.1"),
    ("card-payment.png", (5, 150, 105), (6, 78, 59),
     "\U0001F4B3", "Digital Payment", "Amount-bound mandate",
     "org.multipaz.payment.sca.1"),
    ("card-professional.png", (37, 99, 235), (23, 37, 84),
     "\U0001F527", "Professional License", "Licensed trade",
     "org.example.license.1"),
]


def main():
    for c in CARDS:
        make_card(*c)
    print("done ->", OUTDIR)


if __name__ == "__main__":
    main()
