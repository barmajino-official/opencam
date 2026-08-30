"""Build-time model fetcher.

Runs inside the Docker build (never on the host). Downloads the OpenCV Zoo ONNX
models used by the face / emotion / OCR stages.

Note on git-lfs: opencv_zoo stores its .onnx files via git-lfs, so
`raw.githubusercontent.com` returns a small text *pointer* rather than the
model. `media.githubusercontent.com/media/...` resolves LFS content properly, so
that host is tried first and every download is validated against the pointer
signature before being accepted.
"""

from __future__ import annotations

import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ZOO_LFS = "https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models"
ZOO_RAW = "https://raw.githubusercontent.com/opencv/opencv_zoo/main/models"

# (destination filename, repo-relative path, minimum plausible size in bytes)
ASSETS: list[tuple[str, str, int]] = [
    (
        "face_detection_yunet_2023mar.onnx",
        "face_detection_yunet/face_detection_yunet_2023mar.onnx",
        50_000,
    ),
    (
        "face_recognition_sface_2021dec.onnx",
        "face_recognition_sface/face_recognition_sface_2021dec.onnx",
        1_000_000,
    ),
    (
        "facial_expression_recognition_mobilefacenet_2022july.onnx",
        "facial_expression_recognition/facial_expression_recognition_mobilefacenet_2022july.onnx",
        500_000,
    ),
    (
        "text_detection_en_ppocrv3_2023may.onnx",
        "text_detection_ppocr/text_detection_en_ppocrv3_2023may.onnx",
        500_000,
    ),
    (
        "text_recognition_CRNN_EN_2021sep.onnx",
        "text_recognition_crnn/text_recognition_CRNN_EN_2021sep.onnx",
        1_000_000,
    ),
]

# CRNN_EN is a 36-symbol model. Upstream no longer ships a charset *file* — the
# symbols are inlined in opencv_zoo's crnn.py as CHARSET_EN_36. This is that
# exact string, in that exact order; CTC decoding indexes into it directly, so
# the order is load-bearing and must not be "tidied" into alphabetical form.
CHARSET_EN_36 = "0123456789abcdefghijklmnopqrstuvwxyz"

LFS_POINTER_PREFIX = b"version https://git-lfs"


def _download(url: str, timeout: int = 120) -> bytes:
    request = urllib.request.Request(url, headers={"User-Agent": "opencam-model-fetcher"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return response.read()


def _fetch_one(dest: Path, rel_path: str, min_size: int, retries: int = 3) -> bool:
    if dest.exists() and dest.stat().st_size >= min_size:
        print(f"  [skip] {dest.name} already present ({dest.stat().st_size:,} B)")
        return True

    for attempt in range(1, retries + 1):
        for base in (ZOO_LFS, ZOO_RAW):
            url = f"{base}/{rel_path}"
            try:
                payload = _download(url)
            except (urllib.error.URLError, TimeoutError, OSError) as exc:
                print(f"  [warn] {url} -> {exc}")
                continue

            if payload.startswith(LFS_POINTER_PREFIX):
                print(f"  [warn] {url} returned a git-lfs pointer, not the model")
                continue
            if len(payload) < min_size:
                print(f"  [warn] {url} returned {len(payload):,} B (< {min_size:,} B expected)")
                continue

            dest.write_bytes(payload)
            print(f"  [ok]   {dest.name} ({len(payload):,} B) from {base.split('/')[2]}")
            return True

        if attempt < retries:
            backoff = 2**attempt
            print(f"  [retry] {rel_path} in {backoff}s (attempt {attempt}/{retries})")
            time.sleep(backoff)

    return False


def main() -> int:
    model_dir = Path(os.environ.get("MODEL_DIR", "/models"))
    model_dir.mkdir(parents=True, exist_ok=True)
    print(f"Fetching OpenCV Zoo models into {model_dir}")

    failures: list[str] = []
    for filename, rel_path, min_size in ASSETS:
        if not _fetch_one(model_dir / filename, rel_path, min_size):
            failures.append(filename)

    charset = model_dir / "charset_36_EN.txt"
    charset.write_text("\n".join(CHARSET_EN_36), encoding="utf-8")
    print(f"  [ok]   charset_36_EN.txt written ({len(CHARSET_EN_36)} symbols)")

    if failures:
        # Not fatal: every engine degrades to `available = False` at runtime and
        # the rest of the pipeline keeps working. Surfaced loudly in the log.
        print(f"\n!! {len(failures)} model(s) could not be fetched: {', '.join(failures)}")
        print("!! The matching pipeline stage will start DISABLED.")
        print("!! Mount the file into MODEL_DIR or rebuild with network access to enable it.")
    else:
        print("\nAll OpenCV Zoo models fetched successfully.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
