DejaVu Sans — subset, bundled for the statement PDF renderer
(server/app/services/statement_pdf.py).

Source:  https://dejavu-fonts.github.io/  (version 2.37)
License: see LICENSE.txt (Bitstream Vera / Public-domain derived, free to
         redistribute and embed in documents).

Why bundled: fpdf2's built-in core fonts are latin-1 only and cannot encode the
Indian rupee sign (U+20B9). The upstream TTFs are ~750 KB each, so these files
were subset with fontTools to the ranges the statements actually use:

  U+0020-007E  basic latin
  U+00A0-00FF  latin-1 supplement (accented names)
  U+0100-017F  latin extended-A
  U+2010-2027  punctuation (en/em dash, quotes, ellipsis)
  U+2030-205E  per-mille, primes, misc punctuation
  U+20A0-20BF  currency symbols, incl. U+20B9 RUPEE SIGN
  U+2190-2193  arrows      U+2212 minus      U+25A0-25CF geometric shapes
  U+2713/2717  check/cross U+FB01-FB02 fi/fl ligatures

That takes each face from ~750 KB to ~34 KB. Regenerate with:

  python -m fontTools.subset DejaVuSans.ttf \
    --unicodes="U+0020-007E,U+00A0-00FF,U+0100-017F,U+2010-2027,U+2030-205E,\
U+20A0-20BF,U+2190-2193,U+2212,U+25A0-25CF,U+2713,U+2717,U+FB01-FB02" \
    --layout-features='' --no-hinting --desubroutinize \
    --output-file=DejaVuSans.ttf

The renderer falls back to Helvetica + "Rs." if these files are ever missing, so
a broken/absent font degrades the look but never breaks statement generation.
