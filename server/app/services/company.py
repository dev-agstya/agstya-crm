"""Hard-coded company profile used on statements, emails and message templates.

One place to change the agency's public identity. Logo images live in
``server/app/assets`` so the server-rendered PDF can embed them without touching
the frontend bundle.
"""

from __future__ import annotations

from pathlib import Path

COMPANY_NAME = "Agstya Associate"
COMPANY_ADDRESS = "Opp. Sachin Motors, Panchwati, Udaipur (Raj)."
COMPANY_EMAIL = "agstyaassociate@gmail.com"
COMPANY_PHONE = "0294-2416290"
COMPANY_WEBSITE = "http://www.agstyaassociate.in/"
COMPANY_GSTIN: str | None = None

_ASSETS = Path(__file__).resolve().parent.parent / "assets"
LOGO_FULL = _ASSETS / "logo_full.png"        # header wordmark
LOGO_WATERMARK = _ASSETS / "logo_half.png"   # faint centre watermark

# Subset DejaVu Sans faces bundled for the PDF renderer — the built-in core
# fonts are latin-1 and cannot encode the rupee sign. See assets/fonts/README.
_FONTS = _ASSETS / "fonts"
FONT_FACES = {
    "": _FONTS / "DejaVuSans.ttf",
    "B": _FONTS / "DejaVuSans-Bold.ttf",
    "I": _FONTS / "DejaVuSans-Oblique.ttf",
}


def logo_full_path() -> str | None:
    return str(LOGO_FULL) if LOGO_FULL.exists() else None


def logo_watermark_path() -> str | None:
    return str(LOGO_WATERMARK) if LOGO_WATERMARK.exists() else None


def font_faces() -> dict[str, str] | None:
    """{style: path} for the bundled Unicode faces, or None if any is missing.

    All-or-nothing: a half-registered family would render bold text in a
    different typeface, so the renderer falls back to Helvetica instead."""
    if not all(p.exists() for p in FONT_FACES.values()):
        return None
    return {style: str(path) for style, path in FONT_FACES.items()}
