# The tools for making the demo drives: the manager image (its MP4 and
# telemetry code, ffmpeg, xz) plus Python, onnxruntime, OpenCV and a
# license-plate model for blur.py.
#
#   docker build -t sentry-demo-tools tools/blur

FROM ghcr.io/skittles-fivem/sentry-manager:latest
USER root
RUN set -eux; export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; apt-get install -y --no-install-recommends python3 python3-venv curl; \
    rm -rf /var/lib/apt/lists/*; \
    python3 -m venv /opt/venv; \
    /opt/venv/bin/pip install --no-cache-dir onnxruntime opencv-python-headless numpy
# YOLOv11n fine-tuned for license plates (morsetechlab, AGPL-3.0)
ARG PLATE_MODEL=https://huggingface.co/morsetechlab/yolov11-license-plate-detection/resolve/main/license-plate-finetune-v1s.onnx
RUN mkdir -p /tools/blur && curl -fsSL -o /tools/blur/plates.onnx "$PLATE_MODEL"
COPY blur.py transplant.js /tools/blur/
ENV PATH=/opt/venv/bin:$PATH
ENTRYPOINT []
WORKDIR /work
