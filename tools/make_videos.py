#!/usr/bin/env python3
"""Render ProjectorCal's test patterns to video files for playback on the Apple TV.

    python3 tools/make_videos.py                 # all patterns -> videos/
    python3 tools/make_videos.py --only hdr_hl1000,hdr_black
    python3 tools/make_videos.py --verify        # also decode and check exact code values

SDR patterns: H.264, BT.709, 8-bit limited range (what an Apple TV sends for SDR).
HDR patterns: HEVC Main10, BT.2020 + PQ, HDR10 metadata (mastering display and
MaxCLL), tagged hvc1 so Apple devices play them.

Every video: 2 s black, 2 s white, 2 s black, 2 s white (so the app can find the
screen), then the pattern held for --hold seconds.

Needs ffmpeg with libx264/libx265, numpy and Pillow. Pattern definitions come from
web/js/patterns.js through tools/export_patterns.mjs (needs node).
"""
import argparse
import json
import math
import os
import shutil
import struct
import subprocess
import sys
import tempfile
import zlib
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
SEG = 10  # seconds per encoded pattern segment; the hold is this segment repeated


def export_patterns():
    out = subprocess.run(["node", str(ROOT / "tools" / "export_patterns.mjs")], check=True, capture_output=True, text=True, cwd=ROOT)
    return json.loads(out.stdout)


def jsround(x):
    # JavaScript Math.round (half up), so pixel edges match the browser renderer
    return int(math.floor(x + 0.5))


def fill_value(fill, kind):
    """Normalized 0..1 signal per channel. SDR: full-range code / 255.
    HDR: (PQ 10-bit limited code - 64) / 876, so ffmpeg's tv-range conversion
    lands exactly on the intended code."""
    if fill.get("rgb") is not None:
        return np.array(fill["rgb"], dtype=np.float64) / 255.0
    if fill.get("pq10") is not None:
        v = (fill["pq10"] - 64) / 876.0
        return np.array([v, v, v])
    raise ValueError(fill)


def render(p, W, H):
    img = np.zeros((H, W, 3), dtype=np.float64)
    img[:, :] = fill_value(p["bg"], p["kind"])
    ys, xs = np.mgrid[0:H, 0:W]
    for e in p["elements"]:
        x, y, w, h = e["rect"]
        x0, y0, x1, y1 = jsround(x * W), jsround(y * H), jsround((x + w) * W), jsround((y + h) * H)
        if x1 <= x0 or y1 <= y0:
            continue
        f = e["fill"]
        if f["type"] == "solid":
            img[y0:y1, x0:x1] = fill_value(f, p["kind"])
            continue
        a = np.array(f["a"], dtype=np.float64) / 255.0
        b = np.array(f["b"], dtype=np.float64) / 255.0
        sx, sy = xs[y0:y1, x0:x1], ys[y0:y1, x0:x1]
        if f["type"] == "hlines":
            on = sy % 2 == 0
        elif f["type"] == "vlines":
            on = sx % 2 == 0
        elif f["type"] == "checker":
            on = (sx + sy) % 2 == 0
        else:  # dots25
            on = (sx % 2 == 0) & (sy % 2 == 0)
        img[y0:y1, x0:x1] = np.where(on[..., None], b, a)
    draw_labels(img, p, W, H)
    return img


def draw_labels(img, p, W, H):
    if not p["labels"]:
        return
    from PIL import Image, ImageDraw, ImageFont

    for lab in p["labels"]:
        size = max(8, jsround(lab["size"] * H))
        font = None
        for fp in ("/System/Library/Fonts/Helvetica.ttc", "/System/Library/Fonts/SFNS.ttf", "/Library/Fonts/Arial.ttf"):
            if os.path.exists(fp):
                try:
                    font = ImageFont.truetype(fp, size)
                    break
                except OSError:
                    pass
        if font is None:
            font = ImageFont.load_default(size)
        mask = Image.new("L", (W, H), 0)
        ImageDraw.Draw(mask).text((lab["x"] * W, lab["y"] * H), lab["text"], fill=255, font=font, anchor="mm")
        m = np.asarray(mask) > 127
        if lab.get("rgb"):
            val = np.array(lab["rgb"], dtype=np.float64) / 255.0
        else:
            val = fill_value({"pq10": lab["pq10"]}, "hdr")
        img[m] = val


def write_png16(path, img):
    """Minimal 16-bit RGB PNG writer (Pillow cannot write 16-bit RGB)."""
    h, w, _ = img.shape
    # ffmpeg's swscale maps 16-bit RGB as value/65280 (255*256), not /65535;
    # scaling this way makes the encoded Y codes land exactly (checked by --verify).
    a = np.clip(np.round(img * 65280), 0, 65535).astype(">u2")
    rows = a.reshape(h, w * 3).view(np.uint8)
    raw = np.zeros((h, rows.shape[1] + 1), dtype=np.uint8)
    raw[:, 1:] = rows
    data = zlib.compress(raw.tobytes(), 6)

    def chunk(t, d):
        c = struct.pack(">I", len(d)) + t + d
        return c + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)

    with open(path, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n")
        f.write(chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 16, 2, 0, 0, 0)))
        f.write(chunk(b"IDAT", data))
        f.write(chunk(b"IEND", b""))


def encode_args(kind, maxcll, crf=6):
    if kind == "hdr":
        L = int(maxcll * 10000)
        x265 = ":".join(
            [
                "colorprim=bt2020",
                "transfer=smpte2084",
                "colormatrix=bt2020nc",
                "range=limited",
                "hdr10=1",
                "hdr10-opt=0",
                "repeat-headers=1",
                f"master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L({L},50)",
                f"max-cll={maxcll},400",
                f"keyint={SEG * 24}",
                "log-level=error",
            ]
        )
        return [
            "-vf", "scale=out_color_matrix=bt2020:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p10le",
            "-c:v", "libx265", "-preset", "medium", "-crf", str(crf), "-x265-params", x265,
            "-color_primaries", "bt2020", "-color_trc", "smpte2084", "-colorspace", "bt2020nc", "-color_range", "tv",
            "-tag:v", "hvc1",
        ]
    return [
        "-vf", "scale=out_color_matrix=bt709:out_range=tv:flags=accurate_rnd+full_chroma_int,format=yuv420p",
        "-c:v", "libx264", "-preset", "slow", "-crf", str(crf), "-tune", "stillimage", "-g", str(SEG * 24),
        "-x264-params", "colorprim=bt709:transfer=bt709:colormatrix=bt709:range=tv",
        "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709", "-color_range", "tv",
    ]


def encode_segment(png, out, seconds, fps, kind, maxcll, crf=6):
    cmd = ["ffmpeg", "-y", "-v", "error", "-loop", "1", "-framerate", str(fps), "-t", str(seconds), "-i", str(png), *encode_args(kind, maxcll, crf), "-an", str(out)]
    subprocess.run(cmd, check=True)


def make_video(p, out_path, W, H, fps, hold, flash_white_pq, tmp):
    kind = p["kind"]
    maxcll = p["maxcll"] or 1000
    black = {"rgb": [0, 0, 0]} if kind == "sdr" else {"pq10": 64}
    white = {"rgb": [255, 255, 255]} if kind == "sdr" else {"pq10": flash_white_pq}
    frames = {
        "black": render({"kind": kind, "bg": black, "elements": [], "labels": []}, W, H),
        "white": render({"kind": kind, "bg": white, "elements": [], "labels": []}, W, H),
        "pattern": render(p, W, H),
    }
    segs = {}
    for name, img in frames.items():
        png = tmp / f"{p['id']}_{name}.png"
        write_png16(png, img)
        seg = tmp / f"{p['id']}_{name}.mp4"
        # near-lossless for gray measurement patches; colour-only patterns
        # (judged by hue, not exact level) can use normal quality
        crf = 14 if p["id"] in ("overscan", "colorclip") else 6
        encode_segment(png, seg, SEG if name == "pattern" else 2, fps, kind, maxcll, crf)
        segs[name] = seg
    reps = max(1, round(hold / SEG))
    order = ["black", "white", "black", "white"] + ["pattern"] * reps
    lst = tmp / f"{p['id']}_list.txt"
    lst.write_text("".join(f"file '{segs[n]}'\n" for n in order))
    cmd = ["ffmpeg", "-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", str(lst), "-c", "copy"]
    if kind == "hdr":
        cmd += ["-tag:v", "hvc1"]
    cmd += ["-movflags", "+faststart", str(out_path)]
    subprocess.run(cmd, check=True)


def verify(p, path, W, H, seconds_in=9.0):
    """Decode one pattern frame and compare luma codes with the definition."""
    # read the Y plane as stored (no range conversion)
    pix = "yuv420p10le" if p["kind"] == "hdr" else "yuv420p"
    raw = subprocess.run(
        ["ffmpeg", "-v", "error", "-ss", str(seconds_in), "-i", str(path), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", pix, "-"],
        check=True,
        capture_output=True,
    ).stdout
    dt = np.uint16 if p["kind"] == "hdr" else np.uint8
    y = np.frombuffer(raw, dtype=dt)[: W * H].reshape(H, W).astype(int)
    bad = []
    for e in p["elements"]:
        f = e["fill"]
        if f["type"] != "solid":
            continue
        rgb = f.get("rgb")
        if rgb is not None and not (rgb[0] == rgb[1] == rgb[2]):
            continue  # only check grays
        x, yy, w, h = e["rect"]
        cx, cy = jsround((x + w / 2) * W), jsround((yy + h / 2) * H)
        got = int(np.median(y[cy - 4 : cy + 4, cx - 4 : cx + 4]))
        want = f["pq10"] if p["kind"] == "hdr" else round(16 + 219 * rgb[0] / 255)
        if abs(got - want) > 1:
            bad.append((want, got))
    return bad


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--out", default=str(ROOT / "videos"))
    ap.add_argument("--res", default="3840x2160")
    ap.add_argument("--fps", type=int, default=24)
    ap.add_argument("--hold", type=int, default=180, help="seconds the pattern is held")
    ap.add_argument("--only", default="", help="comma-separated pattern ids")
    ap.add_argument("--verify", action="store_true")
    args = ap.parse_args()
    for tool in ("ffmpeg", "node"):
        if not shutil.which(tool):
            sys.exit(f"{tool} not found on PATH")
    W, H = (int(v) for v in args.res.lower().split("x"))
    data = export_patterns()
    pats = data["patterns"]
    if args.only:
        want = set(args.only.split(","))
        pats = [p for p in pats if p["id"] in want]
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as td:
        tmp = Path(td)
        for p in pats:
            path = out / f"{p['id']}.mp4"
            print(f"{p['id']:<12} {p['kind'].upper()}  {p['title']}", flush=True)
            make_video(p, path, W, H, args.fps, args.hold, data["hdrFlashWhite"], tmp)
            mb = path.stat().st_size / 1e6
            msg = f"             -> {path.relative_to(ROOT) if path.is_relative_to(ROOT) else path} ({mb:.1f} MB)"
            if args.verify:
                bad = verify(p, path, W, H)
                msg += "  verify: OK" if not bad else f"  verify: {len(bad)} patches off (want, got) {bad[:4]}"
            print(msg, flush=True)


if __name__ == "__main__":
    main()
