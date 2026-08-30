# syntax=docker/dockerfile:1.6
# ---------------------------------------------------------------------------
# Stage 1 - models
# Everything model-related happens at build time so the runtime container never
# needs network access and never depends on anything from the host.
# ---------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS models

ENV MODEL_DIR=/models \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    YOLO_CONFIG_DIR=/tmp/ultralytics

WORKDIR /build
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# YOLOv8n first, and deliberately so: this layer pulls ~195 MB of CPU Torch, and
# putting it *before* the COPY below means editing the fetch script never
# invalidates it. Torch exists only in this stage and is discarded with it.
#
# torchvision MUST be pinned from the CPU index alongside torch. Installing only
# torch here and letting ultralytics resolve torchvision from PyPI makes pip pick
# the newest torchvision, which pins a *CUDA* torch and silently re-downloads
# ~4 GB of nvidia-* wheels. Pinning both keeps this stage around 200 MB.
ARG YOLO_MODEL=yolov8n

# Torch gets a layer of its own so that editing anything below never triggers
# another 195 MB download.
RUN pip install --no-cache-dir --index-url https://download.pytorch.org/whl/cpu \
      torch==2.4.1 torchvision==0.19.1

# Ultralytics depends on `opencv-python` — the GUI wheel, which links libGL and
# libxcb and fails to import on a slim base. Swapping it for the headless wheel
# removes that dependency outright rather than installing an X11 stack that
# exists purely to satisfy an import during a one-shot model export.
RUN mkdir -p /models \
 && pip install --no-cache-dir "ultralytics==8.3.40" "onnx==1.17.0" \
 && pip uninstall -y opencv-python \
 && pip install --no-cache-dir "opencv-python-headless==4.10.0.84" \
 && python -c "from ultralytics import YOLO; YOLO('${YOLO_MODEL}.pt').export(format='onnx', opset=12, imgsz=640, simplify=False, dynamic=False)" \
 && cp ${YOLO_MODEL}.onnx /models/yolov8n.onnx

# OpenCV Zoo models (YuNet, SFace, FER, PP-OCR det, CRNN). Pure-stdlib script,
# so this layer stays cheap to rebuild.
COPY utils/fetch_models.py /build/fetch_models.py
RUN python /build/fetch_models.py && ls -lh /models

# ---------------------------------------------------------------------------
# Stage 2 - runtime
# ---------------------------------------------------------------------------
FROM python:3.11-slim-bookworm AS runtime

# Swap to `onnxruntime-gpu` (and a CUDA base image) for GPU acceleration:
#   docker compose build --build-arg ONNXRUNTIME_PACKAGE=onnxruntime-gpu backend
ARG ONNXRUNTIME_PACKAGE=onnxruntime

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    MODEL_DIR=/models \
    FACES_DIR=/faces \
    BACKEND_PORT=8080

# Runtime shared objects:
#   libglib2.0-0 -> opencv-headless    libgomp1 -> onnxruntime/opencv threading
#   libopus0 / libvpx7 / libsrtp2-1 -> aiortc codecs + SRTP
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl libglib2.0-0 libgomp1 libopus0 libvpx7 libsrtp2-1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt /app/requirements.txt

# Build deps are installed and removed inside a single layer so aiortc can fall
# back to a source build if no matching wheel exists, without bloating the image.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      build-essential pkg-config libopus-dev libvpx-dev libsrtp2-dev libffi-dev libssl-dev \
 && pip install --no-cache-dir -r requirements.txt \
 && if [ "$ONNXRUNTIME_PACKAGE" != "onnxruntime" ]; then \
        pip uninstall -y onnxruntime && pip install --no-cache-dir "$ONNXRUNTIME_PACKAGE"; \
    fi \
 && apt-get purge -y --auto-remove build-essential pkg-config libopus-dev libvpx-dev \
      libsrtp2-dev libffi-dev libssl-dev \
 && rm -rf /var/lib/apt/lists/*

COPY --from=models /models /models
COPY . /app

RUN useradd --create-home --uid 10001 opencam \
 && mkdir -p /faces \
 && chown -R opencam:opencam /app /models /faces
USER opencam

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=4s --start-period=45s --retries=4 \
  CMD curl -fsS "http://127.0.0.1:${BACKEND_PORT}/api/health" || exit 1

CMD ["python", "main.py"]
