#!/usr/bin/env python3
"""Build the Startclip logo: the S from Fira Sans ExtraBold (SIL OFL) cut on a diagonal, its halves offset.

One flattened path on a 100-unit tile, so no clip masks reach the favicon, the .ico or a desktop icon theme.

    python3 tools/make-logo.py           print the path
    python3 tools/make-logo.py --apply   write assets/startclip-mark.svg, assets/startclip-icon.svg and the
                                         logo and favicon in index.html (then run: node tools/make-icon.cjs)

Needs fontTools and the font file (pacman: python-fonttools, ttf-fira-sans). Writes LF, keeps every other byte.
"""
import re
import sys
from pathlib import Path
from urllib.parse import quote

from fontTools.pens.basePen import decomposeQuadraticSegment
from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont

FONT = '/usr/share/fonts/TTF/FiraSans-ExtraBold.ttf'
ROOT = Path(__file__).resolve().parent.parent
LIME, INK = '#c9f53f', '#14170f'
SCALE, SLOPE = 0.086, -0.32            # font units to tile units; the cut falls 32 units over the tile's width
UPPER = dict(dx=31.5, dy=75.4, edge=59.88, keep=-1)   # above the cut, shifted up and right
LOWER = dict(dx=21.5, dy=84.4, edge=66.88, keep=1)    # below the cut, shifted down and left


def glyph_segments():
    """The S as line and quadratic segments on the tile: (start, end) or (start, control, end)."""
    font = TTFont(FONT)
    glyphs = font.getGlyphSet()
    pen = RecordingPen()
    glyphs[font.getBestCmap()[ord('S')]].draw(pen)
    segments, here, first = [], None, None
    for op, args in pen.value:
        if op == 'moveTo':
            here = first = args[0]
        elif op == 'lineTo':
            segments.append((here, args[0]))
            here = args[0]
        elif op == 'qCurveTo':
            for control, end in decomposeQuadraticSegment(args):
                segments.append((here, control, end))
                here = end
        elif op in ('closePath', 'endPath') and here != first:
            segments.append((here, first))
            here = first
    return segments


def place(segments, dx, dy):
    return [tuple((dx + x * SCALE, dy - y * SCALE) for x, y in seg) for seg in segments]


def split(seg, t):
    """de Casteljau split of a line or quadratic segment at t."""
    lerp = lambda a, b: (a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)
    if len(seg) == 2:
        mid = lerp(*seg)
        return (seg[0], mid), (mid, seg[1])
    a, b = lerp(seg[0], seg[1]), lerp(seg[1], seg[2])
    mid = lerp(a, b)
    return (seg[0], a, mid), (mid, b, seg[2])


def crossings(seg, side):
    """Parameters in (0, 1) where the segment crosses the cut line."""
    values = [side(p) for p in seg]
    if len(seg) == 2:
        a, b = values
        return [a / (a - b)] if a * b < 0 else []
    p0, p1, p2 = values
    a, b, c = p0 - 2 * p1 + p2, 2 * (p1 - p0), p0
    if abs(a) < 1e-9:
        roots = [-c / b] if b else []
    else:
        disc = b * b - 4 * a * c
        roots = [(-b + s * disc ** .5) / (2 * a) for s in (-1, 1)] if disc >= 0 else []
    return sorted(t for t in roots if 1e-6 < t < 1 - 1e-6)


def clip(segments, edge, keep):
    """Keep the part of the closed outline on one side of the cut, bridging gaps along the cut itself."""
    side = lambda p: (p[1] - (edge + SLOPE * p[0])) * keep
    kept = []
    for seg in segments:
        rest, done = seg, 0.0
        pieces = []
        for t in crossings(seg, side):
            head, rest = split(rest, (t - done) / (1 - done))
            done = t
            pieces.append(head)
        pieces.append(rest)
        for piece in pieces:
            mid = split(piece, .5)[0][-1]
            if side(mid) > 0:
                kept.append(piece)
    return kept


def path_data(segments):
    fmt = lambda p: '%g %g' % (round(p[0], 2), round(p[1], 2))
    out, here = ['M' + fmt(segments[0][0])], segments[0][0]
    for seg in segments:
        if seg[0] != here:
            out.append('L' + fmt(seg[0]))
        out.append(('L' + fmt(seg[1])) if len(seg) == 2 else ('Q' + fmt(seg[1]) + ' ' + fmt(seg[2])))
        here = seg[-1]
    return ''.join(out) + 'Z'


def logo_path():
    outline = glyph_segments()
    return ''.join(path_data(clip(place(outline, part['dx'], part['dy']), part['edge'], part['keep'])) for part in (UPPER, LOWER))


def favicon_svg(d):
    return ('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" rx="23" fill="%s"/>'
            '<path d="%s" fill="%s"/></svg>' % (LIME, d, INK))


def apply(d):
    (ROOT / 'assets').mkdir(exist_ok=True)
    (ROOT / 'assets/startclip-mark.svg').write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><path d="%s" fill="%s"/></svg>\n' % (d, INK), encoding='utf-8')
    (ROOT / 'assets/startclip-icon.svg').write_text(favicon_svg(d) + '\n', encoding='utf-8')
    page = ROOT / 'index.html'
    with open(page, encoding='utf-8', newline='') as f:
        html = f.read()
    href = 'data:image/svg+xml,' + quote(favicon_svg(d), safe="-_.!~*'()")
    html, links = re.subn(r'<link rel="icon" href="[^"]+">', lambda _: '<link rel="icon" href="%s">' % href, html)
    logo = '  logo:\'<path transform="scale(.24)" d="%s" fill="currentColor" stroke="none"/>\'' % d
    html, logos = re.subn(r"^  logo:'.*'$", lambda _: logo, html, flags=re.M)
    if links != 1 or logos != 1:
        raise SystemExit('expected one favicon link and one icons.logo line, found %d and %d' % (links, logos))
    with open(page, 'w', encoding='utf-8', newline='') as f:
        f.write(html)


if __name__ == '__main__':
    d = logo_path()
    if '--apply' in sys.argv[1:]:
        apply(d)
    print(d)
