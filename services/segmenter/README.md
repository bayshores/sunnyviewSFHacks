# Sunnyview segmenter (Python)

This is an optional external Computer Vision service used by the Next.js route `POST /api/segment`.

The frontend calls `/api/segment` automatically after an address search. If you set `SEGMENT_SERVICE_URL`, the Next.js route forwards the request here; otherwise it falls back to an OpenStreetMap building-footprint outline.

## Quick start (no GPU / fallback mode)

Without ONNX or SAM configured the service still answers every request: a white-roof heuristic first, then the address-matched OSM footprint forwarded by Next.js (`osm_footprint_passthrough`), and finally a small centered rectangle (`fallback_rect`). This keeps the app unblocked.

Run from this directory (`services/segmenter`):

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --host 127.0.0.1 --port 8000
```

Then set in your Next app (root `.env.local`):

```bash
SEGMENT_SERVICE_URL=http://localhost:8000
```

## Security

- **Bind to localhost.** Use `--host 127.0.0.1` (as above) unless the service sits behind authentication or a private network. `--host 0.0.0.0` exposes it to everything that can reach the machine.
- **Shared secret (optional).** Set `SEGMENT_SHARED_SECRET` to require the header `x-segment-secret: <value>` on `POST /segment` (constant-time compare; `401` otherwise). `/healthz` stays open. Note: the Next.js route does **not** send this header yet, so enabling it breaks the app integration until that route is updated.
- **Input limits.** Oversized input is rejected with `413` before any heavy work:
  - request body above `SEGMENT_MAX_BODY_BYTES` (checked from `Content-Length` and while streaming),
  - data URL longer than `SEGMENT_MAX_DATA_URL_CHARS`,
  - images above `SEGMENT_MAX_PIXELS` (width × height). PNG and JPEG dimensions are read from the file header *before* decoding, so a small file declaring a huge canvas (decompression bomb) never gets allocated. Other formats are checked after decoding, and OpenCV's own `OPENCV_IO_MAX_IMAGE_PIXELS` is set to the same limit at startup (unless already set).
- **Error details.** Client-facing errors are generic (`Invalid image`, `Image too large`, `SAM inference failed`); the underlying exception is logged via the `segmenter` logger. `/healthz` reports `error: "unavailable"` and `path: null` instead of raw model-load errors and absolute paths unless `SEGMENT_DEBUG=1`.

## Enable SAM (high precision)

This service can optionally use Meta's Segment Anything Model (SAM) when the deps + checkpoint are present.

1) Install extra deps (Torch + segment-anything)

```bash
pip install torch
pip install "git+https://github.com/facebookresearch/segment-anything.git"
```

2) Download a SAM checkpoint and point the service at it:

```bash
export SAM_MODEL_TYPE=vit_h
export SAM_CHECKPOINT=/absolute/path/to/sam_vit_h_4b8939.pth
```

3) Restart `uvicorn`.

Health check:

```bash
curl -sS http://localhost:8000/healthz | jq
```

## Enable RoofSat-trained ONNX model (fully automatic)

This option runs a lightweight segmentation model trained on RoofSat `building_masks`.

1) Install ONNX runtime deps:

```bash
pip install -r requirements-onnx.txt
```

2) Train + export an ONNX model (see `train_roofsat/README.md`), then point the service at it:

```bash
export ROOFSEG_ONNX_PATH=/absolute/path/to/roofsat_unet.onnx
export ROOFSEG_INPUT_SIZE=512
export ROOFSEG_THRESHOLD=0.5
# Optional: tiled inference for large urban scenes (apartments/condos)
# Values: 0|1|auto
export ROOFSEG_TILED=auto
export ROOFSEG_TILE_OVERLAP=0.25
```

3) Restart `uvicorn`.

Notes:
- ONNX is tried before SAM (roof/building modes only).
- The Next.js API route forwards an address-matched `osmFootprint` polygon; the segmenter uses it to keep only the roof for the requested address.

## Environment variables

| Variable | Default | Purpose |
| --- | --- | --- |
| `SAM_CHECKPOINT` | unset | Path to a SAM checkpoint; SAM is disabled when unset. |
| `SAM_MODEL_TYPE` | `vit_h` | SAM registry key matching the checkpoint. |
| `ROOFSEG_ONNX_PATH` | unset | Path to the RoofSat ONNX model; ONNX is disabled when unset. |
| `ROOFSEG_INPUT_SIZE` | `512` | Model input size (128..2048). |
| `ROOFSEG_ORT_THREADS` | `1` | ONNX Runtime intra-op threads. |
| `ROOFSEG_THRESHOLD` | `0.5` | Base probability threshold (clamped to 0.05..0.95). |
| `ROOFSEG_THRESHOLD_SWEEP` | on | Tries several thresholds (helps very bright roofs); set `0`/`false`/`off`/`no` to disable. |
| `ROOFSEG_WHITE_BOOST` | `0.18` | White-roof boost added to ONNX probabilities (0..0.5). |
| `ROOFSEG_WHITE_THRESHOLD` | `0.42` | White-roof heuristic threshold used when ONNX and SAM are unavailable (0.15..0.9). |
| `ROOFSEG_TILED` | `0` | Tiled ONNX inference: `0`, `1` or `auto`. |
| `ROOFSEG_TILE_OVERLAP` | `0.25` | Tile overlap fraction (0..0.75). |
| `SEGMENT_SHARED_SECRET` | unset | When set, `POST /segment` requires a matching `x-segment-secret` header. |
| `SEGMENT_MAX_DATA_URL_CHARS` | `12000000` | Max data URL length (~9 MB decoded; Next.js caps images at 8 MB). |
| `SEGMENT_MAX_PIXELS` | `40000000` | Max image width × height; also the default for `OPENCV_IO_MAX_IMAGE_PIXELS`. |
| `SEGMENT_MAX_BODY_BYTES` | data URL limit + 4000000 | Max request body size. |
| `SEGMENT_DEBUG` | off | `1` shows raw model errors and model paths in `/healthz`. |

Invalid numeric values fall back to the default.

## API

`GET /healthz`: model readiness (`onnx.ready`, `onnx.inputSize`, `sam.ready`, `sam.modelType`, `sam.device`).

`POST /segment`

Request (JSON):
- `imageDataUrl` or `imageRef`: data URL (`data:image/png;base64,...`)
- `mode`: optional, default `roof` (`roof`/`building`; `plane`/`roof_plane` split a gable roof into one plane)
- `clicks[]`: optional prompts (`{x, y, type: "pos" | "neg"}` in pixels)
- `roi`: optional `{x,y,w,h}`
- `meta`: forwarded from Next.js. When available it includes:
  - `osmFootprint`: normalized GeoJSON Polygon for the address-matched building footprint

Response (JSON):
- `roofPolygon`: GeoJSON Polygon (normalized coords 0..1)
- `confidence`: 0..1
- `source`: string (e.g. `roofsat_onnx`, `sam`, `sam_plane_split`, `white_roof_heuristic`, `osm_footprint_passthrough`, `fallback_rect`)
- `suggestedOrientationDeg`, `suggestedAzimuthDeg`, `candidates`, `debug`: optional extras depending on the stage

Errors: `400` invalid input, `401` missing/wrong shared secret, `413` input too large, `422` schema validation, `502` SAM failed with no footprint fallback.
