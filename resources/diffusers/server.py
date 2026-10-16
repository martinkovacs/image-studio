#!/usr/bin/env python3
"""Hugging Face ``diffusers`` behind the stable-diffusion.cpp ``sd-server`` HTTP API.

The Electron app's client (``src/main/sdcpp/server.ts``) drives a local HTTP
server that answers:

    GET  /sdcpp/v1/capabilities      engine info; the app treats the first
                                     successful answer as "model is ready"
    POST /sdcpp/v1/img_gen           submit a generation -> {"id": "..."}
    GET  /sdcpp/v1/jobs/{id}         poll status/result
    POST /sdcpp/v1/jobs/{id}/cancel  cancel a queued/generating job
    POST /sdcpp/v1/upscale           501 (not supported by this backend)

Progress is printed on stdout in sd.cpp's exact format so the app's existing
``parseProgressLine()``/``parseStageLine()`` regexes keep working unchanged.

Security notes:
  - only loopback interfaces are accepted (``--listen-ip``);
  - only the pipeline classes in ``PIPELINES`` may ever be instantiated
    (resolved via ``getattr(diffusers, name)`` for names in that dict only);
  - models load with ``local_files_only=True`` and ``use_safetensors=True``
    and never ``trust_remote_code`` (``model_index.json`` component libraries
    are allow-listed to diffusers/transformers).

torch/diffusers/PIL are imported lazily inside the load/generate paths so this
module (and ``test_server.py``) imports and runs on machines without torch.
"""

from __future__ import annotations

import argparse
import base64
import binascii
import json
import math
import random
import re
import sys
import threading
import time
import traceback
import urllib.parse
import uuid
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol, Sequence

# ---------------------------------------------------------------------------
# Limits and constants (mirrored in the capabilities answer)

MAX_BODY_BYTES = 256 * 1024 * 1024  # reject img_gen bodies larger than 256 MiB
MAX_QUEUE_SIZE = 8
JOB_TTL_SECONDS = 10 * 60  # finished jobs are kept for 10 minutes, then dropped
SWEEP_INTERVAL_SECONDS = 15.0  # how often the idle worker drops expired jobs

MIN_DIM, MAX_DIM = 256, 2048
DIM_MULTIPLE = 16  # dimensions are rounded DOWN to a multiple of 16
DEFAULT_WIDTH, DEFAULT_HEIGHT = 1024, 1024
MAX_BATCH_COUNT = 4
MAX_STEPS = 200
MAX_CFG = 30.0
MAX_PROMPT_CHARS = 10_000
MAX_REF_IMAGES = 10
SEED_LIMIT = 2**31  # random seeds are drawn from 0..2**31-1 (sd.cpp convention)

PROGRESS_BAR_WIDTH = 20
LOOPBACK_HOSTS = ('127.0.0.1', 'localhost')

OUTPUT_FORMATS = ('png', 'jpeg', 'webp')
_PIL_FORMAT = {'png': 'PNG', 'jpeg': 'JPEG', 'webp': 'WEBP'}

# Allow-list of component libraries in model_index.json: anything else could
# pull in custom Python code at load time.
ALLOWED_LIBRARIES = frozenset({'diffusers', 'transformers'})

# ---------------------------------------------------------------------------
# Pipeline allow-list
#
# The only diffusers classes this server may ever instantiate. `cfg_kwarg` is
# the classifier-free-guidance keyword of the pipeline __call__ (None for
# distilled pipelines that ignore guidance); `supports` lists the request
# fields the pipeline honours (surfaced via capabilities so the UI can hide
# controls).


@dataclass(frozen=True)
class PipelineSpec:
    """Per-pipeline behaviour of one entry in ``PIPELINES``."""

    name: str
    transformer_cls: str
    cfg_kwarg: str | None
    negative_prompt: bool
    default_steps: int
    default_cfg: float
    supports: tuple[str, ...]


PIPELINES: dict[str, PipelineSpec] = {
    'QwenImage21Pipeline': PipelineSpec(
        name='QwenImage21Pipeline',
        transformer_cls='QwenImage21Transformer2DModel',
        cfg_kwarg='true_cfg_scale',
        negative_prompt=True,
        default_steps=40,
        default_cfg=1.0,
        supports=('negative_prompt', 'txt_cfg', 'ref_images', 'custom_sigmas', 'steps', 'seed', 'batch_count'),
    ),
    'Flux2Pipeline': PipelineSpec(
        name='Flux2Pipeline',
        transformer_cls='Flux2Transformer2DModel',
        cfg_kwarg='guidance_scale',
        negative_prompt=False,
        default_steps=28,
        default_cfg=4.0,
        supports=('txt_cfg', 'ref_images', 'custom_sigmas', 'steps', 'seed', 'batch_count'),
    ),
    'Flux2KleinPipeline': PipelineSpec(
        name='Flux2KleinPipeline',
        transformer_cls='Flux2Transformer2DModel',
        cfg_kwarg=None,  # distilled: guidance is ignored, never passed
        negative_prompt=False,
        default_steps=4,
        default_cfg=1.0,
        supports=('ref_images', 'custom_sigmas', 'steps', 'seed', 'batch_count'),
    ),
}

# ---------------------------------------------------------------------------
# Small shared helpers

StepCallback = Callable[[int, int, float], None]  # (done_steps, total_steps, seconds_per_iter)


class ValidationError(ValueError):
    """A request value the HTTP layer answers with 400."""


class ClientError(Exception):
    """A request error with an HTTP status, raised inside the handler."""

    def __init__(self, status: int, message: str):
        super().__init__(message)
        self.status = status


class QueueFullError(Exception):
    """Raised by JobQueue.submit when the pending queue is at capacity."""


def log(message: str) -> None:
    """Human log line on stdout (the app shows these in its server log)."""
    print(message, flush=True)


def format_progress_line(step: int, total: int, seconds_per_iter: float) -> str:
    """sd.cpp-style sampling progress line.

    Must keep matching PROGRESS_RE in src/main/sdcpp/server.ts:
    ``  |=====>          | 5/20 - 1.23s/it``
    """
    filled = int(PROGRESS_BAR_WIDTH * step / total) if total > 0 else PROGRESS_BAR_WIDTH
    filled = max(0, min(PROGRESS_BAR_WIDTH, filled))
    if filled <= 0:
        bar = ' ' * PROGRESS_BAR_WIDTH
    elif filled >= PROGRESS_BAR_WIDTH:
        bar = '=' * PROGRESS_BAR_WIDTH
    else:
        bar = '=' * (filled - 1) + '>' + ' ' * (PROGRESS_BAR_WIDTH - filled)
    return f'  |{bar}| {step}/{total} - {seconds_per_iter:.2f}s/it'


def decode_data_url(url: str) -> bytes:
    """Decode a ``data:image/...;base64,...`` URL into raw image bytes (stdlib only)."""
    if not isinstance(url, str):
        raise ValidationError('ref_images entries must be data URL strings')
    match = re.match(r'^data:image/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$', url.strip())
    if match is None:
        raise ValidationError('ref_images entries must look like "data:image/png;base64,..."')
    try:
        return base64.b64decode(match.group(1), validate=True)
    except (binascii.Error, ValueError) as err:
        raise ValidationError(f'ref_images contains invalid base64: {err}') from err


def encode_images(images: Sequence[Any], output_format: str = 'png', output_compression: int = 90) -> list[str]:
    """Encode generated images as base64 strings for the JSON result.

    Accepts already-encoded bytes (passed through unchanged — used by tests)
    or PIL images (lazy PIL import; saved as ``output_format`` with
    ``output_compression`` as the JPEG/WEBP quality).
    """
    pil_format = _PIL_FORMAT.get(output_format)
    if pil_format is None:
        raise ValidationError(f'unsupported output_format {output_format!r}')
    encoded: list[str] = []
    for image in images:
        if isinstance(image, (bytes, bytearray)):
            encoded.append(base64.b64encode(bytes(image)).decode('ascii'))
            continue
        from io import BytesIO

        from PIL import Image as PilImage  # lazy: keep the module torch/PIL-free

        if not isinstance(image, PilImage.Image):
            raise ValidationError(f'cannot encode image of type {type(image).__name__}')
        buffer = BytesIO()
        save_kwargs: dict[str, Any] = {}
        if pil_format == 'JPEG' and image.mode not in ('RGB', 'L'):
            image = image.convert('RGB')
        if pil_format in ('JPEG', 'WEBP'):
            save_kwargs['quality'] = int(output_compression)
        image.save(buffer, format=pil_format, **save_kwargs)
        encoded.append(base64.b64encode(buffer.getvalue()).decode('ascii'))
    return encoded


# ---------------------------------------------------------------------------
# Request validation / pipeline call building (pure, no torch or I/O)


def _coerce_int(value: Any, name: str) -> int:
    """Strictly an integer (JSON numbers; integral floats accepted, bools not)."""
    if isinstance(value, bool) or value is None:
        raise ValidationError(f'{name} must be an integer')
    if isinstance(value, int):
        return value
    if isinstance(value, float) and math.isfinite(value) and value.is_integer():
        return int(value)
    raise ValidationError(f'{name} must be an integer')


def _coerce_float(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ValidationError(f'{name} must be a number')
    return float(value)


def _clamp_dim(value: Any, name: str) -> int:
    """Clamp to 256..2048 and round DOWN to a multiple of 16."""
    v = _coerce_int(value, name)
    v = max(MIN_DIM, min(MAX_DIM, v))
    return v - (v % DIM_MULTIPLE)


def _sample_params(body: Mapping[str, Any]) -> Mapping[str, Any]:
    sample = body.get('sample_params')
    if sample is None:
        return {}
    if not isinstance(sample, dict):
        raise ValidationError('sample_params must be an object')
    return sample


def _guidance(sample: Mapping[str, Any]) -> Mapping[str, Any]:
    guidance = sample.get('guidance')
    if guidance is None:
        return {}
    if not isinstance(guidance, dict):
        raise ValidationError('sample_params.guidance must be an object')
    return guidance


def attach_reference_images(kwargs: dict[str, Any], images: Sequence[Any]) -> None:
    """Attach decoded reference images as the pipeline ``image=`` kwarg.

    One image is passed as a single object, several as a list, none as absent.
    """
    if not images:
        return
    kwargs['image'] = images[0] if len(images) == 1 else list(images)


def build_call_kwargs(
    spec: PipelineSpec,
    body: Mapping[str, Any],
    defaults: Mapping[str, Any],
    images: Sequence[Any] | None = None,
) -> dict[str, Any]:
    """Validate an img_gen request body and build the pipeline ``__call__`` kwargs.

    Pure function: raises ValidationError on malformed values, clamps numeric
    ranges and applies the pipeline-specific rules from ``spec`` (cfg kwarg
    name, negative-prompt support, custom sigmas). ``defaults`` supplies the
    fallback ``steps``/``cfg`` values; ``images``, when given, are
    already-decoded reference images attached as ``image=``.

    The resolved seed travels in the returned dict under ``_seed`` and is
    popped by the engine when it builds the torch.Generator.
    """
    if not isinstance(body, dict):
        raise ValidationError('request body must be a JSON object')

    prompt = body.get('prompt')
    if not isinstance(prompt, str) or not prompt.strip():
        raise ValidationError('prompt is required and must be a non-empty string')
    if len(prompt) > MAX_PROMPT_CHARS:
        raise ValidationError(f'prompt must be at most {MAX_PROMPT_CHARS} characters')
    kwargs: dict[str, Any] = {'prompt': prompt}

    negative = body.get('negative_prompt')
    if negative is not None:
        if not isinstance(negative, str):
            raise ValidationError('negative_prompt must be a string')
        if spec.negative_prompt and negative.strip():
            kwargs['negative_prompt'] = negative

    sample = _sample_params(body)
    guidance = _guidance(sample)

    kwargs['width'] = _clamp_dim(body.get('width', DEFAULT_WIDTH), 'width')
    kwargs['height'] = _clamp_dim(body.get('height', DEFAULT_HEIGHT), 'height')

    batch = body.get('batch_count')
    batch = _coerce_int(1 if batch is None else batch, 'batch_count')
    kwargs['num_images_per_prompt'] = max(1, min(MAX_BATCH_COUNT, batch))

    steps_default = _coerce_int(defaults.get('steps', spec.default_steps), 'steps')
    steps_raw = sample.get('sample_steps')
    steps = _coerce_int(steps_default if steps_raw is None else steps_raw, 'sample_params.sample_steps')
    steps = max(1, min(MAX_STEPS, steps))
    kwargs['num_inference_steps'] = steps

    if spec.cfg_kwarg is not None:
        cfg_default = _coerce_float(defaults.get('cfg', spec.default_cfg), 'cfg')
        cfg_raw = guidance.get('txt_cfg')
        cfg = _coerce_float(cfg_default if cfg_raw is None else cfg_raw, 'sample_params.guidance.txt_cfg')
        kwargs[spec.cfg_kwarg] = max(0.0, min(MAX_CFG, cfg))

    sigmas_raw = sample.get('custom_sigmas')
    if sigmas_raw is not None:
        if not isinstance(sigmas_raw, list) or not sigmas_raw:
            raise ValidationError('sample_params.custom_sigmas must be a non-empty list of numbers')
        sigmas = [_coerce_float(s, 'sample_params.custom_sigmas') for s in sigmas_raw]
        # A schedule written as `steps + 1` entries with a trailing terminator
        # 0.0 (sd.cpp convention, e.g. the Qwen turbo preset) loses that zero;
        # otherwise it is taken literally and len(sigmas) becomes the step count.
        if len(sigmas) == steps + 1 and sigmas[-1] == 0.0:
            sigmas = sigmas[:-1]
        kwargs['sigmas'] = sigmas
        kwargs['num_inference_steps'] = len(sigmas)

    seed_raw = body.get('seed')
    if seed_raw is None or not isinstance(seed_raw, int) or isinstance(seed_raw, bool) or seed_raw < 0:
        seed = random.randrange(0, SEED_LIMIT)
    else:
        seed = seed_raw % SEED_LIMIT
    kwargs['_seed'] = seed

    attach_reference_images(kwargs, images or [])
    return kwargs


def parse_output_options(raw: Mapping[str, Any]) -> tuple[str, int]:
    """Validate ``output_format``/``output_compression`` -> (format, quality)."""
    fmt = raw.get('output_format')
    fmt = 'png' if fmt is None else fmt
    if not isinstance(fmt, str) or fmt not in OUTPUT_FORMATS:
        raise ValidationError(f'output_format must be one of {", ".join(OUTPUT_FORMATS)}')
    compression_raw = raw.get('output_compression')
    compression = _coerce_int(90 if compression_raw is None else compression_raw, 'output_compression')
    return fmt, max(0, min(100, compression))


def decode_ref_images(raw: Mapping[str, Any]) -> list[bytes]:
    """Validate + decode the ``ref_images`` data URLs into raw bytes (no PIL yet)."""
    refs = raw.get('ref_images')
    if refs is None:
        return []
    if not isinstance(refs, list):
        raise ValidationError('ref_images must be a list of data URLs')
    if len(refs) > MAX_REF_IMAGES:
        raise ValidationError(f'too many ref_images ({len(refs)}; the maximum is {MAX_REF_IMAGES})')
    return [decode_data_url(url) for url in refs]


# ---------------------------------------------------------------------------
# Model directory validation (load-time security checks)


def validate_model_dir(model_dir: str, pipeline_name: str) -> Path:
    """Validate --model against model_index.json and return its resolved Path.

    Refuses anything that would let a model run arbitrary code: the directory
    must contain a model_index.json whose ``_class_name`` matches --pipeline
    and whose component entries all name diffusers/transformers classes.
    """
    path = Path(model_dir)
    if not path.is_dir():
        raise ValueError(f'--model is not a directory: {model_dir}')
    index_path = path / 'model_index.json'
    if not index_path.is_file():
        raise ValueError(f'--model does not contain model_index.json: {model_dir}')
    try:
        index = json.loads(index_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError) as err:
        raise ValueError(f'cannot read {index_path}: {err}') from err
    if not isinstance(index, dict):
        raise ValueError(f'{index_path} must contain a JSON object')
    class_name = index.get('_class_name')
    if class_name != pipeline_name:
        raise ValueError(
            f'model_index.json _class_name is {class_name!r} but --pipeline is {pipeline_name!r}'
        )
    for key, entry in index.items():
        if key.startswith('_'):
            continue
        if not isinstance(entry, list) or len(entry) < 2 or not isinstance(entry[0], str):
            raise ValueError(f'model_index.json entry {key!r} is malformed; expected ["library", "ClassName"]')
        if entry[0] not in ALLOWED_LIBRARIES:
            raise ValueError(
                f'model_index.json component {key!r} uses library {entry[0]!r}; '
                f'only {sorted(ALLOWED_LIBRARIES)} are allowed (custom code is not supported)'
            )
    return path


def validate_arg_paths(args: argparse.Namespace) -> None:
    """Refuse --transformer-gguf / --lora values with the wrong extension or a missing file."""
    if args.transformer_gguf:
        p = Path(args.transformer_gguf)
        if p.suffix.lower() != '.gguf':
            raise ValueError(f'--transformer-gguf must point to a .gguf file: {p}')
        if not p.is_file():
            raise ValueError(f'--transformer-gguf not found: {p}')
    if args.lora:
        p = Path(args.lora)
        if p.suffix.lower() != '.safetensors':
            raise ValueError(f'--lora must point to a .safetensors file: {p}')
        if not p.is_file():
            raise ValueError(f'--lora not found: {p}')


# ---------------------------------------------------------------------------
# Jobs


QUEUED, GENERATING, COMPLETED, FAILED, CANCELLED = 'queued', 'generating', 'completed', 'failed', 'cancelled'
_TERMINAL = frozenset({COMPLETED, FAILED, CANCELLED})


@dataclass
class Job:
    """One generation request; mutated only under the JobQueue lock."""

    id: str
    kwargs: dict[str, Any]
    ref_images: list[bytes] = field(default_factory=list)
    output_format: str = 'png'
    output_compression: int = 90
    status: str = QUEUED
    result: dict[str, Any] | None = None
    error: str | None = None
    cancel_event: threading.Event = field(default_factory=threading.Event)
    finished_at: float | None = None

    def snapshot(self, queue_position: int) -> dict[str, Any]:
        """The JSON shape the client's poll loop expects (JobJson in server.ts)."""
        return {
            'id': self.id,
            'status': self.status,
            'queue_position': queue_position,
            'result': self.result,
            'error': {'message': self.error} if self.status == FAILED and self.error else None,
        }


def job_error_message(err: BaseException) -> str:
    """Human message for a failed job; OOM gets a dedicated, actionable text."""
    try:
        import torch  # lazy

        oom = getattr(torch.cuda, 'OutOfMemoryError', None)
        if oom is not None and isinstance(err, oom):
            return 'Out of GPU memory — try CPU offload, a smaller quant or a smaller size'
    except Exception:
        pass
    return str(err).strip() or err.__class__.__name__


def release_gpu_memory() -> None:
    """Best-effort torch.cuda.empty_cache() after a failed generation."""
    try:
        import torch  # lazy

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


class JobQueue:
    """FIFO generation queue processed by a single worker thread.

    The queue owns job bookkeeping (status, queue positions, cancel flags and
    the 10-minute TTL of finished jobs) and calls the engine's generate() one
    job at a time, which keeps GPU usage serialized.
    """

    def __init__(self, engine: Engine, max_queue_size: int = MAX_QUEUE_SIZE, job_ttl: float = JOB_TTL_SECONDS):
        self.engine = engine
        self.max_queue_size = max(1, max_queue_size)
        self.job_ttl = job_ttl
        self._jobs: dict[str, Job] = {}
        self._pending: list[Job] = []  # FIFO, QUEUED jobs only
        self._lock = threading.Lock()
        self._wake = threading.Event()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None

    # -- lifecycle ----------------------------------------------------------

    def start(self) -> None:
        if self._thread is None:
            self._thread = threading.Thread(target=self._worker_loop, name='diffusers-job-worker', daemon=True)
            self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        self._wake.set()
        # Unblock a running generation (the engine polls should_cancel) so the
        # worker loop can actually exit instead of waiting out the join timeout.
        with self._lock:
            for job in self._jobs.values():
                if job.status in (QUEUED, GENERATING):
                    job.cancel_event.set()
        if self._thread is not None:
            self._thread.join(timeout=5)
            self._thread = None

    # -- API used by the HTTP handler ---------------------------------------

    def submit(self, job: Job) -> None:
        """Queue a job; raises QueueFullError when at capacity."""
        with self._lock:
            if len(self._pending) >= self.max_queue_size:
                raise QueueFullError(f'the job queue is full ({self.max_queue_size} pending generations)')
            self._jobs[job.id] = job
            self._pending.append(job)
        self._wake.set()

    def get(self, job_id: str) -> dict[str, Any] | None:
        """Snapshot of one job (or None once unknown/expired); drops expired jobs."""
        self._sweep()
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            position = 0
            if job.status == QUEUED:
                position = next((i for i, j in enumerate(self._pending) if j is job), 0)
            return job.snapshot(position)

    def cancel(self, job_id: str) -> str | None:
        """Cancel semantics of POST /jobs/{id}/cancel.

        Returns None when the job is unknown, 'cancelled' when a queued job was
        removed, 'cancelling' when a generating job's cancel flag was set, or
        the (unchanged) status of an already finished job — a no-op.
        """
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.status == QUEUED:
                self._pending = [j for j in self._pending if j is not job]
                job.status = CANCELLED
                job.finished_at = time.monotonic()
                return CANCELLED
            if job.status == GENERATING:
                job.cancel_event.set()
                return 'cancelling'
            return job.status

    # -- worker -------------------------------------------------------------

    def _worker_loop(self) -> None:
        while not self._stop.is_set():
            job = None
            with self._lock:
                if self._pending:
                    job = self._pending.pop(0)
            if job is None:
                if self._wake.wait(timeout=SWEEP_INTERVAL_SECONDS):
                    self._wake.clear()
                self._sweep()
                continue
            self._execute(job)

    def _execute(self, job: Job) -> None:
        with self._lock:
            job.status = GENERATING
        log('generating image: 1/1')
        started = time.perf_counter()

        def on_step(step: int, total: int, seconds_per_iter: float) -> None:
            print(format_progress_line(step, total, seconds_per_iter), flush=True)
            if total > 0 and step >= total:
                # Last sampler step done; the pipeline is about to run the VAE.
                log('decoding 1 latents')

        try:
            images = [self._decode_image(data) for data in job.ref_images]
            attach_reference_images(job.kwargs, images)
            generated = self.engine.generate(job.kwargs, on_step, job.cancel_event.is_set)
            if job.cancel_event.is_set():
                with self._lock:
                    job.status = CANCELLED  # images discarded
            else:
                # Encode outside the lock; publish result+status atomically.
                encoded = encode_images(generated, job.output_format, job.output_compression)
                result = {
                    'output_format': job.output_format,
                    'images': [{'b64_json': b64} for b64 in encoded],
                }
                with self._lock:
                    job.result = result
                    job.status = COMPLETED
                log(f'generated in {time.perf_counter() - started:.2f}s')
        except Exception as err:
            traceback.print_exc()
            with self._lock:
                if job.cancel_event.is_set():
                    job.status = CANCELLED
                else:
                    job.status = FAILED
                    job.error = job_error_message(err)
            release_gpu_memory()
        finally:
            with self._lock:
                job.finished_at = time.monotonic()

    @staticmethod
    def _decode_image(data: bytes) -> Any:
        """bytes -> PIL RGB image (lazy import; corrupt data fails the job)."""
        from io import BytesIO

        from PIL import Image  # lazy

        with Image.open(BytesIO(data)) as image:
            return image.convert('RGB')

    def _sweep(self) -> None:
        cutoff = time.monotonic() - self.job_ttl
        with self._lock:
            expired = [
                job_id
                for job_id, job in self._jobs.items()
                if job.status in _TERMINAL and job.finished_at is not None and job.finished_at < cutoff
            ]
            for job_id in expired:
                del self._jobs[job_id]


# ---------------------------------------------------------------------------
# Engine


class Engine(Protocol):
    """What the HTTP layer needs from a backend (real: DiffusersEngine)."""

    spec: PipelineSpec
    defaults: Mapping[str, Any]  # {'steps': int, 'cfg': float} fallbacks for build_call_kwargs

    def capabilities(self) -> dict[str, Any]: ...

    def generate(
        self,
        kwargs: Mapping[str, Any],
        on_step: StepCallback,
        should_cancel: Callable[[], bool],
    ) -> list[Any]:
        """Run one generation; kwargs comes from build_call_kwargs (has '_seed')."""


def build_capabilities(
    spec: PipelineSpec,
    model_name: str,
    model_stem: str,
    model_path: str,
    device: str,
    dtype: str,
) -> dict[str, Any]:
    """The capabilities object: an SdCapabilities-compatible answer (types.ts)."""
    return {
        'backend': 'diffusers',
        'diffusers': {
            'pipeline': spec.name,
            'supports': list(spec.supports),
            'device': device,
            'dtype': dtype,
        },
        'model': {'name': model_name, 'stem': model_stem, 'path': model_path},
        'supported_modes': ['img_gen'],
        'defaults_by_mode': {
            'img_gen': {
                'width': DEFAULT_WIDTH,
                'height': DEFAULT_HEIGHT,
                'seed': -1,
                'batch_count': 1,
                'sample_params': {
                    'sample_steps': spec.default_steps,
                    'guidance': {'txt_cfg': spec.default_cfg},
                },
            }
        },
        'output_formats_by_mode': {'img_gen': list(OUTPUT_FORMATS)},
        'features_by_mode': {
            'img_gen': {
                'negative_prompt': spec.negative_prompt,
                'ref_images': True,
                'init_image': False,
                'mask_image': False,
                'control_image': False,
                'lora': False,
                'hires': False,
                'vae_tiling': False,
                'cache': False,
            }
        },
        'samplers': [],
        'schedulers': [],
        'loras': [],
        'upscalers': [],
        'upscale': False,
        'limits': {
            'min_width': MIN_DIM,
            'max_width': MAX_DIM,
            'min_height': MIN_DIM,
            'max_height': MAX_DIM,
            'max_batch_count': MAX_BATCH_COUNT,
            'max_queue_size': MAX_QUEUE_SIZE,
            'max_upscale_width': 0,
            'max_upscale_height': 0,
        },
    }


class DiffusersEngine:
    """Loads a diffusers pipeline and runs generations on it.

    torch/diffusers/PIL are imported inside load()/generate() (and the encode
    path of JobQueue) so importing this module stays free of heavy deps.
    """

    def __init__(self, args: argparse.Namespace, spec: PipelineSpec) -> None:
        self.spec = spec
        self.defaults: dict[str, Any] = {'steps': spec.default_steps, 'cfg': spec.default_cfg}
        self.model_dir = Path(args.model)
        self.model_name = self.model_dir.name
        # The app stores per-model parameter overrides keyed by this stem:
        # "<model>+<gguf-stem>+lora-<lora-stem>".
        stem = self.model_name
        if args.transformer_gguf:
            stem += f'+{Path(args.transformer_gguf).stem}'
        if args.lora:
            stem += f'+lora-{Path(args.lora).stem}'
        self.stem = stem
        self.model_path = str(self.model_dir)
        self.device = args.device
        self.dtype_name = args.dtype
        self._args = args
        self._pipe: Any = None

    # -- capabilities ---------------------------------------------------------

    def capabilities(self) -> dict[str, Any]:
        return build_capabilities(
            self.spec, self.model_name, self.stem, self.model_path, self.device, self.dtype_name
        )

    # -- loading ---------------------------------------------------------------

    def load(self) -> None:
        """Import torch/diffusers and build the pipeline. Called before listening."""
        started = time.perf_counter()
        log('importing torch and diffusers ...')
        import torch  # lazy: heavy
        import diffusers  # lazy

        pipeline_cls = self._require(diffusers, self.spec.name)
        transformer_cls = self._require(diffusers, self.spec.transformer_cls)
        dtype = {'bfloat16': torch.bfloat16, 'float16': torch.float16}[self.dtype_name]

        log(
            f'loading {self.spec.name} from {self.model_dir} '
            f'(device={self.device}, dtype={self.dtype_name}, offload={self._args.offload})'
        )
        load_kwargs: dict[str, Any] = {
            # Newer diffusers renames torch_dtype -> dtype; torch_dtype keeps
            # working there via a deprecation shim.
            'torch_dtype': dtype,
            'use_safetensors': True,
            'local_files_only': True,
        }
        if self._args.transformer_gguf:
            load_kwargs['transformer'] = self._load_gguf_transformer(diffusers, transformer_cls, dtype)
        quantization = self._text_encoder_quantization(diffusers, dtype)
        if quantization is not None:
            load_kwargs['quantization_config'] = quantization

        pipe = pipeline_cls.from_pretrained(str(self.model_dir), **load_kwargs)

        if self._args.lora:
            lora = Path(self._args.lora)
            log(f'loading LoRA {lora.name} (scale {self._args.lora_scale:g}) ...')
            # Attached as a named adapter, never fused, so the scale stays adjustable.
            pipe.load_lora_weights(str(lora.parent), weight_name=lora.name, adapter_name='lora')
            pipe.set_adapters(['lora'], adapter_weights=[float(self._args.lora_scale)])

        if self._args.offload == 'none':
            pipe.to(self.device)
        elif self._args.offload == 'model':
            log(f'enabling model CPU offload (device={self.device})')
            pipe.enable_model_cpu_offload(device=self.device)
        else:
            log(f'enabling sequential CPU offload (device={self.device})')
            pipe.enable_sequential_cpu_offload(device=self.device)

        vae = getattr(pipe, 'vae', None)
        if self._args.vae_tiling and vae is not None and hasattr(vae, 'enable_tiling'):
            log('enabling VAE tiling')
            vae.enable_tiling()
        if hasattr(pipe, 'set_progress_bar_config'):
            # We print our own sd.cpp-shaped progress lines on stdout.
            pipe.set_progress_bar_config(disable=True)

        self._pipe = pipe
        log(f'model loaded in {time.perf_counter() - started:.1f}s')

    @staticmethod
    def _require(module: Any, name: str) -> Any:
        """getattr against an allow-listed class name, with a readable error."""
        cls = getattr(module, name, None)
        if cls is None:
            raise ValueError(f'the installed diffusers does not provide {name}; update the runtime')
        return cls

    def _load_gguf_transformer(self, diffusers_module: Any, transformer_cls: Any, dtype: Any) -> Any:
        """Load a GGUF transformer, keeping the pipeline folder's transformer/config.json."""
        path = Path(self._args.transformer_gguf)
        log(f'loading transformer from GGUF {path} ...')
        gguf_quantization = self._require(diffusers_module, 'GGUFQuantizationConfig')
        return transformer_cls.from_single_file(
            str(path),
            quantization_config=gguf_quantization(compute_dtype=dtype),
            torch_dtype=dtype,
            config=str(self.model_dir),  # transformer/config.json lives in the model folder
            subfolder='transformer',
            local_files_only=True,
        )

    def _text_encoder_quantization(self, diffusers_module: Any, dtype: Any) -> Any | None:
        """PipelineQuantizationConfig for --text-encoder-quant, or None when not applicable."""
        mode = self._args.text_encoder_quant
        if mode == 'none':
            return None
        config_path = self.model_dir / 'text_encoder' / 'config.json'
        if config_path.is_file():
            try:
                config = json.loads(config_path.read_text(encoding='utf-8'))
            except (OSError, json.JSONDecodeError):
                config = {}
            if isinstance(config, dict) and config.get('quantization_config'):
                log('text encoder is already quantized; ignoring --text-encoder-quant')
                return None
        pipeline_quantization = self._require(diffusers_module, 'PipelineQuantizationConfig')
        if mode == '4bit':
            log('quantizing text encoder with bitsandbytes (4-bit, nf4)')
            return pipeline_quantization(
                quant_backend='bitsandbytes_4bit',
                quant_kwargs={
                    'load_in_4bit': True,
                    'bnb_4bit_quant_type': 'nf4',
                    'bnb_4bit_compute_dtype': dtype,
                },
                components_to_quantize=['text_encoder'],
            )
        log('quantizing text encoder with bitsandbytes (8-bit)')
        return pipeline_quantization(
            quant_backend='bitsandbytes_8bit',
            quant_kwargs={'load_in_8bit': True},
            components_to_quantize=['text_encoder'],
        )

    # -- generation --------------------------------------------------------------

    def generate(
        self,
        kwargs: Mapping[str, Any],
        on_step: StepCallback,
        should_cancel: Callable[[], bool],
    ) -> list[Any]:
        """Run one pipeline call; returns PIL images (empty on cancellation)."""
        import torch  # lazy

        if self._pipe is None:
            raise RuntimeError('engine is not loaded')
        call = dict(kwargs)
        seed = int(call.pop('_seed', 0))
        generator = torch.Generator(device='cpu').manual_seed(seed)
        total = int(call.get('num_inference_steps') or 0)
        started = time.perf_counter()

        def callback(pipe: Any, step_index: int, _timestep: Any, callback_kwargs: dict[str, Any]) -> dict[str, Any]:
            # The sanctioned diffusers cancellation hook: the pipeline checks
            # _interrupt at the top of every denoising step.
            if should_cancel():
                setattr(pipe, '_interrupt', True)
            else:
                done = step_index + 1
                on_step(done, total, (time.perf_counter() - started) / done)
            return callback_kwargs

        with torch.inference_mode():
            output = self._pipe(generator=generator, callback_on_step_end=callback, **call)
        return list(getattr(output, 'images', None) or [])


# ---------------------------------------------------------------------------
# HTTP layer


@dataclass
class ServerState:
    engine: Engine
    queue: JobQueue


class SdHTTPServer(ThreadingHTTPServer):
    """ThreadingHTTPServer carrying the engine + queue in ``.state``."""

    daemon_threads = True

    def __init__(self, address: tuple[str, int], handler: type[BaseHTTPRequestHandler], state: ServerState) -> None:
        self.state = state
        super().__init__(address, handler)


class SdRequestHandler(BaseHTTPRequestHandler):
    """Routes of the sd-server API. All answers are JSON with Content-Length."""

    protocol_version = 'HTTP/1.1'
    state: ServerState  # actually per-server: self.server.state

    # -- plumbing ------------------------------------------------------------

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002 - stdlib signature
        pass  # silence per-request stderr spam (the app logs on its own)

    def _send_json(self, status: int, payload: Mapping[str, Any]) -> None:
        if getattr(self, '_response_started', False):
            return
        self._response_started = True
        data = json.dumps(payload).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        header = self.headers.get('Content-Length')
        if header is None:
            raise ClientError(400, 'missing Content-Length')
        try:
            length = int(header)
        except ValueError as err:
            raise ClientError(400, 'invalid Content-Length') from err
        if length < 0:
            raise ClientError(400, 'invalid Content-Length')
        if length > MAX_BODY_BYTES:
            # Cannot drain 256+ MiB reliably: answer and close the connection.
            self.close_connection = True
            raise ClientError(413, f'request body too large ({length} bytes; the limit is {MAX_BODY_BYTES})')
        if length == 0:
            return b''
        body = self.rfile.read(length)
        if len(body) < length:
            self.close_connection = True
            raise ClientError(400, 'request body was truncated')
        return body

    def _read_json_body(self) -> dict[str, Any]:
        body = self._read_body()
        try:
            parsed = json.loads(body.decode('utf-8'))
        except (UnicodeDecodeError, json.JSONDecodeError) as err:
            raise ClientError(400, f'request body is not valid JSON: {err}') from err
        if not isinstance(parsed, dict):
            raise ClientError(400, 'request body must be a JSON object')
        return parsed

    def _safe_dispatch(self, handler: Callable[[str], None]) -> None:
        path = urllib.parse.urlsplit(self.path).path
        try:
            handler(path)
        except ClientError as err:
            self._send_json(err.status, {'error': str(err)})
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True
        except Exception:
            traceback.print_exc()
            self._send_json(500, {'error': 'internal server error'})

    # -- routes ----------------------------------------------------------------

    def do_GET(self) -> None:  # noqa: N802 - stdlib naming
        self._safe_dispatch(self._handle_get)

    def do_POST(self) -> None:  # noqa: N802 - stdlib naming
        self._safe_dispatch(self._handle_post)

    def _handle_get(self, path: str) -> None:
        if path == '/sdcpp/v1/capabilities':
            self._send_json(200, self.server.state.engine.capabilities())  # type: ignore[attr-defined]
            return
        match = re.match(r'^/sdcpp/v1/jobs/([^/]+)$', path)
        if match:
            snapshot = self.server.state.queue.get(match.group(1))  # type: ignore[attr-defined]
            if snapshot is None:
                self._send_json(404, {'error': f'job {match.group(1)!r} not found'})
            else:
                self._send_json(200, snapshot)
            return
        self._send_json(404, {'error': 'not found'})

    def _handle_post(self, path: str) -> None:
        state = self.server.state  # type: ignore[attr-defined]
        if path == '/sdcpp/v1/img_gen':
            self._handle_img_gen(state)
            return
        if path == '/sdcpp/v1/upscale':
            self._send_json(501, {'error': 'Upscaling is not available with the diffusers backend'})
            return
        match = re.match(r'^/sdcpp/v1/jobs/([^/]+)/cancel$', path)
        if match:
            action = state.queue.cancel(match.group(1))
            if action is None:
                self._send_json(404, {'error': f'job {match.group(1)!r} not found'})
            else:
                self._send_json(200, {'status': action})
            return
        self._send_json(404, {'error': 'not found'})

    def _handle_img_gen(self, state: ServerState) -> None:
        try:
            raw = self._read_json_body()
            kwargs = build_call_kwargs(state.engine.spec, raw, state.engine.defaults)
            ref_images = decode_ref_images(raw)
            output_format, compression = parse_output_options(raw)
        except ValidationError as err:
            self._send_json(400, {'error': str(err)})
            return
        except ClientError as err:
            self._send_json(err.status, {'error': str(err)})
            return
        job = Job(
            id=uuid.uuid4().hex,
            kwargs=kwargs,
            ref_images=ref_images,
            output_format=output_format,
            output_compression=compression,
        )
        try:
            state.queue.submit(job)
        except QueueFullError as err:
            self._send_json(429, {'error': str(err)})
            return
        self._send_json(200, {'id': job.id})


def make_server(
    engine: Engine,
    host: str,
    port: int,
    *,
    max_queue_size: int = MAX_QUEUE_SIZE,
    job_ttl: float = JOB_TTL_SECONDS,
) -> SdHTTPServer:
    """Wire engine + job queue into a (bound, not yet serving) HTTP server."""
    queue = JobQueue(engine, max_queue_size=max_queue_size, job_ttl=job_ttl)
    server = SdHTTPServer((host, port), SdRequestHandler, ServerState(engine=engine, queue=queue))
    queue.start()
    return server


# ---------------------------------------------------------------------------
# CLI


def parse_args(argv: Sequence[str] | None = None) -> argparse.Namespace:
    """CLI flags — exactly DIFFUSERS_LAUNCH_FLAGS (src/shared/diffusersFlags.ts) + listen flags."""
    parser = argparse.ArgumentParser(
        prog='server.py',
        description='Diffusers-backed drop-in replacement for stable-diffusion.cpp sd-server.',
    )
    parser.add_argument('--pipeline', required=True, choices=sorted(PIPELINES), help='diffusers pipeline class to load')
    parser.add_argument('--model', required=True, help='local diffusers-format model directory (contains model_index.json)')
    parser.add_argument('--transformer-gguf', default=None, help='optional GGUF transformer replacing the folder transformer weights')
    parser.add_argument('--lora', default=None, help='LoRA .safetensors attached at load time')
    parser.add_argument('--lora-scale', type=float, default=1.0, help='LoRA strength (default 1.0)')
    parser.add_argument('--offload', choices=('none', 'model', 'sequential'), default='model', help='CPU offload strategy (default model)')
    parser.add_argument('--text-encoder-quant', choices=('none', '8bit', '4bit'), default='none', help='quantize the text encoder with bitsandbytes')
    parser.add_argument('--vae-tiling', action='store_true', help='decode with VAE tiling')
    parser.add_argument('--device', default='cuda', help='torch device, e.g. cuda or cuda:1 (default cuda)')
    parser.add_argument('--dtype', choices=('bfloat16', 'float16'), default='bfloat16', help='compute dtype (default bfloat16)')
    parser.add_argument('--listen-ip', default='127.0.0.1', help='must be 127.0.0.1 or localhost (loopback only)')
    parser.add_argument('--listen-port', type=int, required=True, help='TCP port to listen on')
    args = parser.parse_args(argv)
    if args.listen_ip not in LOOPBACK_HOSTS:
        # The app polls this port from itself only; never bind a public interface.
        parser.error(f'--listen-ip must be 127.0.0.1 or localhost (got {args.listen_ip!r})')
    return args


def main(argv: Sequence[str] | None = None) -> None:
    args = parse_args(argv)
    spec = PIPELINES[args.pipeline]
    try:
        validate_model_dir(args.model, args.pipeline)
        validate_arg_paths(args)
    except ValueError as err:
        print(f'error: {err}', file=sys.stderr)
        sys.exit(2)

    engine = DiffusersEngine(args, spec)
    try:
        engine.load()  # before the listener: a capabilities answer means "ready"
    except Exception:
        traceback.print_exc()
        print('error: failed to load the model, exiting', file=sys.stderr)
        sys.exit(1)

    host = '127.0.0.1' if args.listen_ip == 'localhost' else args.listen_ip
    try:
        server = make_server(engine, host, args.listen_port)
    except OSError as err:
        print(f'error: cannot listen on {host}:{args.listen_port}: {err}', file=sys.stderr)
        sys.exit(1)
    bound_host, bound_port = server.server_address[:2]
    log(f'diffusers server ready: http://{bound_host}:{bound_port} (model {engine.stem})')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        log('shutting down')
    finally:
        server.state.queue.stop()
        server.server_close()


if __name__ == '__main__':
    main()
