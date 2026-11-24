"""
Cut a scanned ECI electoral-roll PDF (Gujarati, 3x10 voter cards per page) into:

  <out>/cards/p<page>_<idx>.png   each voter card (300 dpi, grey)
  <out>/photos/<serial>.webp      the voter photo from each card (colour, 150 px wide)
  <out>/review/p<page>_<half>.png 15-card sheets used to read/verify names
  <out>/manifest.json             serial -> page/card index (serials run in card order)

The text layer of these PDFs is a single scanned image, so names are read from the
review sheets into a TSV (see README.md) and then loaded with import_roll.js.

Usage:
  python3 roll_cards.py --pdf roll.pdf --out work/ [--first-serial 1]
"""
import argparse
import json
import os

import cv2
import fitz
import numpy as np

CARD_W = (650, 900)   # card size range at 300 dpi
CARD_H = (250, 450)
PHOTO_W = (165, 190)  # photo box size range at 300 dpi
PHOTO_H = (185, 210)


def find_cards(gray):
    bw = (gray < 160).astype(np.uint8) * 255
    h = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (300, 1)))
    v = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, (1, 180)))
    grid = cv2.dilate(h | v, np.ones((3, 3), np.uint8))
    cnts, _ = cv2.findContours(255 - grid, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    boxes = [cv2.boundingRect(c) for c in cnts]
    boxes = [b for b in boxes if CARD_W[0] < b[2] < CARD_W[1] and CARD_H[0] < b[3] < CARD_H[1]]
    # drop inner duplicates (inner/outer contour of the same border)
    boxes = [b for b in boxes if not any(
        o != b and o[0] <= b[0] and o[1] <= b[1] and o[0] + o[2] >= b[0] + b[2] and o[1] + o[3] >= b[1] + b[3]
        for o in boxes)]
    boxes.sort(key=lambda b: (round(b[1] / 100), b[0]))
    return boxes


def find_photo(card_gray):
    h, w = card_gray.shape
    x0 = int(w * 0.70)
    reg = card_gray[60:h - 5, x0:w - 12]
    bw = (reg < 200).astype(np.uint8) * 255
    cnts, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if cnts:
        bx, by, bw_, bh = max((cv2.boundingRect(c) for c in cnts), key=lambda b: b[2] * b[3])
        if PHOTO_W[0] < bw_ < PHOTO_W[1] and PHOTO_H[0] < bh < PHOTO_H[1]:
            return x0 + bx, 60 + by, bw_, bh
    return 585, 70, 176, 198  # standard position in this layout


def review_tile(card_gray):
    h, w = card_gray.shape
    bw = int(w * 0.76)
    head = cv2.resize(card_gray[4:54, 4:w - 4], (bw, int(50 * bw / (w - 8))), interpolation=cv2.INTER_AREA)
    body = card_gray[54:min(h, 300), 0:bw]
    if body.shape[0] < 246:
        body = np.vstack([body, np.full((246 - body.shape[0], bw), 255, np.uint8)])
    t = np.vstack([head, body])
    t = cv2.resize(t, (470, int(t.shape[0] * 470 / bw)), interpolation=cv2.INTER_AREA)
    return cv2.copyMakeBorder(t, 3, 3, 3, 3, cv2.BORDER_CONSTANT, value=128)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pdf', required=True)
    ap.add_argument('--out', required=True)
    ap.add_argument('--first-serial', type=int, default=1)
    args = ap.parse_args()

    for sub in ('cards', 'photos', 'review'):
        os.makedirs(os.path.join(args.out, sub), exist_ok=True)

    doc = fitz.open(args.pdf)
    serial = args.first_serial - 1
    manifest = {}
    for pi in range(doc.page_count):
        pix = doc[pi].get_pixmap(dpi=300)
        rgb = np.frombuffer(pix.samples, np.uint8).reshape(pix.h, pix.w, pix.n)[:, :, :3][:, :, ::-1].copy()
        gray = cv2.cvtColor(rgb, cv2.COLOR_BGR2GRAY)
        boxes = find_cards(gray)
        tiles = []
        for k, (x, y, w, h) in enumerate(boxes):
            serial += 1
            card_g = gray[y:y + h, x:x + w]
            card_c = rgb[y:y + h, x:x + w]
            cv2.imwrite(os.path.join(args.out, 'cards', f'p{pi:02d}_{k:02d}.png'), card_g)
            px, py, pw, ph = find_photo(card_g)
            photo = card_c[py + 3:py + ph - 3, px + 3:px + pw - 3]
            photo = cv2.resize(photo, (150, int(photo.shape[0] * 150 / photo.shape[1])), interpolation=cv2.INTER_AREA)
            cv2.imwrite(os.path.join(args.out, 'photos', f'{serial:05d}.webp'), photo, [cv2.IMWRITE_WEBP_QUALITY, 85])
            manifest[serial] = {'page': pi + 1, 'card': k}
            tiles.append(review_tile(card_g))
        for half in range(0, len(tiles), 15):
            sub = tiles[half:half + 15]
            while len(sub) % 3:
                sub.append(np.full_like(sub[0], 255))
            sheet = np.vstack([np.hstack(sub[i:i + 3]) for i in range(0, len(sub), 3)])
            cv2.imwrite(os.path.join(args.out, 'review', f'p{pi + 1:02d}_{half // 15}.png'), sheet)

    with open(os.path.join(args.out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f)
    print(json.dumps({'cards': serial - args.first_serial + 1, 'lastSerial': serial}))


if __name__ == '__main__':
    main()
