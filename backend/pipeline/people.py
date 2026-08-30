"""Fuse `person` detections with face records into one tracked "people" list.

Two stages produce overlapping evidence about the same human: YOLO emits a
whole-body `person` box, YuNet/SFace emit a face box with an identity and an
emotion. The SDK wants one object per human, so this module pairs them and
assigns an id that survives across frames.

Why containment rather than IoU for the pairing: a face box sits *inside* a
person box and is perhaps 5% of its area, so their IoU is near zero even for a
perfect match. The useful question is "what fraction of this face lies inside
that person", which is containment.

Why a tracker at all: without stable ids, "person entered / left" is impossible
to express and every frame looks like a brand-new crowd. This is deliberately a
simple IoU + centroid tracker with a miss budget, not a Kalman/ReID stack — it
is enough to keep ids stable through the frame drops the pipeline is built to
tolerate, and it costs microseconds.

STATE WARNING: `PeopleTracker` is per-session mutable state. It must live on
`VisionEngine` (one per session), never on `ModelBundle` (pooled and shared
across every session). Mutating it from the worker thread is safe only because
the single-slot register guarantees one `_infer` per session at a time.
"""

from __future__ import annotations

import time
from typing import Any

Box = list[float]

# A face must be at least this contained within a person box to be paired.
FACE_CONTAINMENT_MIN = 0.55
# Track association threshold. Generous, because inference runs at ~1/3 of
# capture rate and subjects move meaningfully between passes.
TRACK_IOU_MIN = 0.25


def _iou(a: Box, b: Box) -> float:
    ax1, ay1, aw, ah = a
    bx1, by1, bw, bh = b
    ax2, ay2 = ax1 + aw, ay1 + ah
    bx2, by2 = bx1 + bw, by1 + bh

    ix1, iy1 = max(ax1, bx1), max(ay1, by1)
    ix2, iy2 = min(ax2, bx2), min(ay2, by2)
    iw, ih = ix2 - ix1, iy2 - iy1
    if iw <= 0 or ih <= 0:
        return 0.0

    intersection = iw * ih
    union = aw * ah + bw * bh - intersection
    return intersection / union if union > 0 else 0.0


def _containment(inner: Box, outer: Box) -> float:
    """Fraction of `inner`'s area that falls inside `outer`."""
    ix1, iy1, iw, ih = inner
    ox1, oy1, ow, oh = outer
    if iw <= 0 or ih <= 0:
        return 0.0

    x1, y1 = max(ix1, ox1), max(iy1, oy1)
    x2, y2 = min(ix1 + iw, ox1 + ow), min(iy1 + ih, oy1 + oh)
    if x2 <= x1 or y2 <= y1:
        return 0.0
    return ((x2 - x1) * (y2 - y1)) / (iw * ih)


class PeopleTracker:
    """Assigns stable ids to people across inference passes."""

    def __init__(self, *, max_misses: int = 8) -> None:
        self.max_misses = max_misses
        self._next_id = 1
        # id -> {box, misses, first_seen, last_seen, name}
        self._tracks: dict[int, dict[str, Any]] = {}

    def reset(self) -> None:
        self._tracks.clear()
        self._next_id = 1

    def _new_track(self, box: Box, now: float) -> int:
        track_id = self._next_id
        self._next_id += 1
        self._tracks[track_id] = {
            "box": box,
            "misses": 0,
            "first_seen": now,
            "last_seen": now,
            "name": None,
        }
        return track_id

    def assign(self, boxes: list[Box], names: list[str | None]) -> list[dict[str, Any]]:
        """Match `boxes` to existing tracks; return per-box track metadata.

        Greedy nearest-match by IoU. With the handful of people a webcam sees,
        greedy and Hungarian give the same answer for a fraction of the cost.
        Identity is a *strong* hint: a recognised name overrides geometry, which
        keeps ids stable when someone walks behind a chair and reappears.
        """
        now = time.monotonic()
        assignments: list[int] = [-1] * len(boxes)
        claimed: set[int] = set()

        # Pass 1 - identity wins outright.
        for index, name in enumerate(names):
            if not name or name == "Unknown":
                continue
            for track_id, track in self._tracks.items():
                if track_id in claimed:
                    continue
                if track.get("name") == name:
                    assignments[index] = track_id
                    claimed.add(track_id)
                    break

        # Pass 2 - geometry for whatever is left.
        candidates: list[tuple[float, int, int]] = []
        for index, box in enumerate(boxes):
            if assignments[index] != -1:
                continue
            for track_id, track in self._tracks.items():
                if track_id in claimed:
                    continue
                overlap = _iou(box, track["box"])
                if overlap >= TRACK_IOU_MIN:
                    candidates.append((overlap, index, track_id))

        for _, index, track_id in sorted(candidates, key=lambda c: -c[0]):
            if assignments[index] != -1 or track_id in claimed:
                continue
            assignments[index] = track_id
            claimed.add(track_id)

        # Pass 3 - anything still unmatched is genuinely new.
        results: list[dict[str, Any]] = []
        for index, box in enumerate(boxes):
            track_id = assignments[index]
            if track_id == -1:
                track_id = self._new_track(box, now)
                claimed.add(track_id)

            track = self._tracks[track_id]
            track["box"] = box
            track["misses"] = 0
            track["last_seen"] = now
            if names[index] and names[index] != "Unknown":
                track["name"] = names[index]

            results.append(
                {
                    "id": track_id,
                    "age_s": round(now - track["first_seen"], 2),
                    "is_new": track["first_seen"] == now,
                }
            )

        # Age out tracks that were not seen this pass.
        for track_id in list(self._tracks):
            if track_id in claimed:
                continue
            self._tracks[track_id]["misses"] += 1
            if self._tracks[track_id]["misses"] > self.max_misses:
                del self._tracks[track_id]

        return results


def build_people(
    objects: list[dict[str, Any]],
    faces: list[dict[str, Any]],
    tracker: PeopleTracker,
) -> list[dict[str, Any]]:
    """One record per human, merging body box, face, identity and emotion.

    A person with no detected face still counts (they may be turned away); a
    face with no body box also counts (torso occluded, or the detector is
    disabled entirely). Neither stage is required for the other to work.
    """
    bodies = [o for o in objects if o.get("label") == "person"]
    unmatched_faces = list(range(len(faces)))
    merged: list[dict[str, Any]] = []

    for body in bodies:
        best_index, best_score = -1, 0.0
        for face_index in unmatched_faces:
            score = _containment(faces[face_index]["box"], body["box"])
            if score > best_score:
                best_index, best_score = face_index, score

        face = None
        if best_index != -1 and best_score >= FACE_CONTAINMENT_MIN:
            face = faces[best_index]
            unmatched_faces.remove(best_index)

        merged.append({"body": body, "face": face})

    # Faces with no body box of their own still represent a person.
    for face_index in unmatched_faces:
        merged.append({"body": None, "face": faces[face_index]})

    boxes = [
        (item["body"] or item["face"])["box"] for item in merged  # type: ignore[index]
    ]
    names = [
        (item["face"] or {}).get("name") if item["face"] else None for item in merged
    ]
    tracks = tracker.assign(boxes, names)

    people: list[dict[str, Any]] = []
    for item, track in zip(merged, tracks):
        body, face = item["body"], item["face"]
        # Distance from the face is IPD-based and far more trustworthy than the
        # body-height prior, so it wins whenever both exist.
        distance = None
        distance_method = None
        if face and face.get("distance_m") is not None:
            distance = face["distance_m"]
            distance_method = face.get("distance_method")
        elif body and body.get("distance_m") is not None:
            distance = body["distance_m"]
            distance_method = body.get("distance_method")

        people.append(
            {
                "id": track["id"],
                "age_s": track["age_s"],
                "box": (body or face)["box"],
                "body_box": body["box"] if body else None,
                "face_box": face["box"] if face else None,
                "name": (face or {}).get("name") if face else None,
                "similarity": (face or {}).get("similarity") if face else None,
                "emotion": (face or {}).get("emotion") if face else None,
                "distance_m": distance,
                "distance_method": distance_method,
                "confidence": round(
                    float(body["conf"]) if body else float((face or {}).get("score", 0.0)), 3
                ),
                "has_face": face is not None,
            }
        )

    # Nearest first: the subject in front of the camera is almost always the one
    # the caller means by "the user".
    people.sort(key=lambda p: (p["distance_m"] is None, p["distance_m"] or 0.0))
    return people
