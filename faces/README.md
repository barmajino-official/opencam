# Reference faces

Drop labelled photos here. This directory is mounted read-only into the backend
at `/faces` and is re-scanned every `FACE_RELOAD_INTERVAL_S` seconds, so new
people can be added **without restarting anything**.

## Naming

The filename becomes the displayed identity:

| Path                        | Identity resolved |
| --------------------------- | ----------------- |
| `Ali_Jaafar.png`            | `Ali Jaafar`      |
| `Ali_Jaafar_2.jpg`          | `Ali Jaafar`      |
| `Sara-Khoury.jpeg`          | `Sara Khoury`     |
| `Sara_Khoury/profile.png`   | `Sara Khoury`     |

Underscores and hyphens become spaces; a trailing `_<number>` is stripped so one
person can have several reference photos. A per-person subdirectory works too —
every image inside it maps to the directory name.

Accepted extensions: `.png`, `.jpg`, `.jpeg`, `.bmp`, `.webp`.

## What makes a good reference photo

The embedding is only as good as the crop it came from:

- **One face per image.** If several are present the largest is used.
- **Frontal, eyes open, unobstructed.** YuNet needs its five landmarks (eyes,
  nose, mouth corners) to align the crop; heavy occlusion degrades the embedding.
- **At least ~112 px across the face.** Bigger is fine — SFace aligns and
  resizes internally.
- **Even lighting, no heavy filters.** Strong colour casts shift the embedding.
- **2–4 photos per person** across normal lighting and angles noticeably improves
  matching: every image becomes its own gallery entry and the best match wins.

Images with no detectable face are skipped with a warning in the backend log —
check `docker compose logs backend` if someone never gets recognised.

## Tuning matches

Matching is cosine similarity against SFace embeddings, thresholded by
`FACE_MATCH_THRESHOLD` (default `0.363`, OpenCV's reference value).

- Wrong person matched → raise it (`0.40`–`0.45`).
- Known person shows as `Unknown` → lower it (`0.30`–`0.33`), or add more photos.

The live similarity score is printed next to every recognised name in the
overlay and in the detection log, which makes picking a threshold empirical
rather than guesswork.

## Applying changes immediately

The periodic rescan picks up new files on its own. To force it now:

```bash
curl -X POST http://localhost:8080/api/faces/reload
```

or press **↻ faces** in the dashboard header.
