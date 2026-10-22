"""Lazy-loaded Segment Anything (SAM) predictor wrapper."""

import os
import threading
from typing import Any, Optional, Tuple

import numpy as np


class SamState:
    def __init__(self) -> None:
        self.ready = False
        self.error: Optional[str] = None
        self.model_type: Optional[str] = None
        self.checkpoint: Optional[str] = None
        self.device: Optional[str] = None
        self._predictor: Any = None
        self._lock = threading.Lock()

    def ensure_loaded(self) -> bool:
        if self.ready:
            return True

        ckpt = os.getenv("SAM_CHECKPOINT")
        model_type = os.getenv("SAM_MODEL_TYPE", "vit_h")
        if not ckpt:
            self.error = "SAM_CHECKPOINT not set"
            return False
        if not os.path.exists(ckpt):
            self.error = f"SAM checkpoint not found: {ckpt}"
            return False

        try:
            import torch  # type: ignore
            from segment_anything import SamPredictor, sam_model_registry  # type: ignore

            sam = sam_model_registry[model_type](checkpoint=ckpt)
            device = "cuda" if torch.cuda.is_available() else "cpu"
            sam.to(device=device)
            predictor = SamPredictor(sam)

            self._predictor = predictor
            self.ready = True
            self.error = None
            self.model_type = model_type
            self.checkpoint = ckpt
            self.device = device
            return True
        except Exception as e:
            self.error = f"SAM load failed: {e}"
            return False

    def predict(
        self,
        image_rgb: np.ndarray,
        point_coords: Optional[np.ndarray],
        point_labels: Optional[np.ndarray],
        box: Optional[np.ndarray],
    ) -> Tuple[np.ndarray, np.ndarray]:
        if not self.ensure_loaded() or self._predictor is None:
            raise RuntimeError(self.error or "SAM unavailable")

        with self._lock:
            self._predictor.set_image(image_rgb)
            masks, scores, _ = self._predictor.predict(
                point_coords=point_coords,
                point_labels=point_labels,
                box=box,
                multimask_output=True,
            )
            return masks, scores
