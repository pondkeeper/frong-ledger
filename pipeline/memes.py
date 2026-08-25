#!/usr/bin/env python3
"""Rebuild docs/memes/manifest.json from whatever image files sit in docs/memes/.

    python3 pipeline/memes.py

Run it after dropping a new meme into docs/memes/ (PNG / JPG / GIF / WebP).
Existing entries keep their hand-edited `title`, `credit` and `added` values;
new files get a title derived from the filename and today's date. Stdlib only.
"""
import json, os, re, struct, sys
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIR = os.path.join(ROOT, 'docs', 'memes')
MANIFEST = os.path.join(DIR, 'manifest.json')
EXTS = {'.png': 'png', '.jpg': 'jpg', '.jpeg': 'jpg', '.gif': 'gif', '.webp': 'webp'}


def dims(path, fmt):
    with open(path, 'rb') as f:
        head = f.read(32)
        if fmt == 'png' and head[:8] == b'\x89PNG\r\n\x1a\n':
            return struct.unpack('>II', head[16:24])
        if fmt == 'gif' and head[:6] in (b'GIF87a', b'GIF89a'):
            return struct.unpack('<HH', head[6:10])
        if fmt == 'webp' and head[:4] == b'RIFF' and head[8:12] == b'WEBP':
            chunk = head[12:16]
            if chunk == b'VP8X':
                w = int.from_bytes(head[24:27], 'little') + 1
                h = int.from_bytes(head[27:30], 'little') + 1
                return w, h
            if chunk == b'VP8L':
                b = head[21:25]
                w = 1 + (((b[1] & 0x3F) << 8) | b[0])
                h = 1 + (((b[3] & 0xF) << 10) | (b[2] << 2) | ((b[1] & 0xC0) >> 6))
                return w, h
            if chunk == b'VP8 ':
                return struct.unpack('<HH', head[26:30])[0] & 0x3FFF, struct.unpack('<HH', head[28:32])[0] & 0x3FFF
        if fmt == 'jpg' and head[:2] == b'\xff\xd8':
            f.seek(2)
            while True:
                b = f.read(1)
                if not b:
                    break
                if b != b'\xff':
                    continue
                marker = f.read(1)
                while marker == b'\xff':
                    marker = f.read(1)
                m = marker[0]
                if m in (0xD8, 0x01) or 0xD0 <= m <= 0xD7:
                    continue
                (ln,) = struct.unpack('>H', f.read(2))
                if m in (0xC0, 0xC1, 0xC2, 0xC3, 0xC5, 0xC6, 0xC7, 0xC9, 0xCA, 0xCB, 0xCD, 0xCE, 0xCF):
                    f.read(1)
                    h, w = struct.unpack('>HH', f.read(4))
                    return w, h
                f.seek(ln - 2, 1)
    return None, None


def title_from(name):
    stem = re.sub(r'^template-', '', os.path.splitext(name)[0])
    return re.sub(r'[-_]+', ' ', stem).strip().capitalize()


def main():
    old = {}
    if os.path.exists(MANIFEST):
        with open(MANIFEST) as f:
            old = {m['file']: m for m in json.load(f).get('memes', [])}
    today = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    memes = []
    for name in sorted(os.listdir(DIR)):
        ext = os.path.splitext(name)[1].lower()
        if ext not in EXTS:
            continue
        path = os.path.join(DIR, name)
        fmt = EXTS[ext]
        w, h = dims(path, fmt)
        if not w:
            print('skip (unreadable header):', name, file=sys.stderr)
            continue
        prev = old.get(name, {})
        tags = []
        if fmt == 'gif':
            tags.append('gif')
        if name.startswith('template-'):
            tags.append('template')
        if 'pfp' in name:
            tags.append('pfp')
        memes.append({
            'file': name, 'fmt': fmt, 'w': w, 'h': h, 'bytes': os.path.getsize(path),
            'title': prev.get('title') or title_from(name),
            'credit': prev.get('credit', ''),
            'added': prev.get('added') or today,
            'tags': tags,
        })
    memes.sort(key=lambda m: (m['added'], m['file']), reverse=True)
    out = {'generated': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
           'count': len(memes), 'memes': memes}
    with open(MANIFEST, 'w') as f:
        json.dump(out, f, indent=1)
        f.write('\n')
    print(f'{len(memes)} memes -> {os.path.relpath(MANIFEST, ROOT)}')


if __name__ == '__main__':
    main()
