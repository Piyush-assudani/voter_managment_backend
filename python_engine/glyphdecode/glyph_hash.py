"""Outline hashing shared by the DB builder and the runtime decoder."""
import hashlib
from fontTools.pens.recordingPen import DecomposingRecordingPen


def outline_hash(glyphset, name):
    """Hash of the fully decomposed outline. Composite glyphs are flattened so a
    subset font (renamed components) hashes the same as the original."""
    pen = DecomposingRecordingPen(glyphset)
    glyphset[name].draw(pen)
    if not pen.value:
        return None  # empty glyph (space etc.) — handled by advance width
    parts = []
    for op, pts in pen.value:
        parts.append(op[0] + ','.join(f'{round(x)}:{round(y)}' for x, y in pts))
    return hashlib.md5('|'.join(parts).encode()).hexdigest()[:16]
