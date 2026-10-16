"""Unit tests for server.py — stdlib only, runs on machines without torch.

Run with (both forms pass):

    python3 -I -m unittest discover -s . -v   # fully isolated: discover puts this
                                              # directory on sys.path itself
    python3 -m unittest test_server -v

Naming the module directly under -I (`python3 -I -m unittest test_server`) does
not resolve on current interpreters: isolated mode drops the cwd that `-m
unittest` would normally prepend before this file even loads. The explicit
sys.path insert below is what makes `import server` work once the file is found.
"""

from __future__ import annotations

import base64
import http.client
import json
import re
import sys
import threading
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import server  # noqa: E402  (path inserted above on purpose)

# A 1x1 PNG (the FakeEngine's "generated" image; encode_images passes bytes through).
PNG_1PX = base64.b64decode(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
)

# Mirror of PROGRESS_RE in src/main/sdcpp/server.ts: the server's progress lines
# must keep matching it.
PROGRESS_RE = re.compile(r'[|=>#\s]*(\d+)/(\d+)\s+-\s+([0-9.]+\s?(?:s/it|it/s|[kmgt]?b/s))[^0-9]*$', re.IGNORECASE)
DECODING_RE = re.compile(r'decoding \d+ latents|tiled vae|vae_tiling', re.IGNORECASE)
SAMPLING_RE = re.compile(r'generating image: \d+/\d+', re.IGNORECASE)

BASE_ARGS = ['--pipeline', 'Flux2Pipeline', '--model', '/models/x', '--listen-port', '7860']


def write_model_index(root: Path, index: dict) -> Path:
    root.mkdir(parents=True, exist_ok=True)
    (root / 'model_index.json').write_text(json.dumps(index), encoding='utf-8')
    return root


class ValidateModelDirTest(unittest.TestCase):
    def setUp(self):
        self._tmp = TemporaryDirectory()
        self.addCleanup(self._tmp.cleanup)
        self.root = Path(self._tmp.name)

    def test_good_dir(self):
        model = write_model_index(
            self.root / 'm',
            {
                '_class_name': 'Flux2Pipeline',
                'transformer': ['diffusers', 'Flux2Transformer2DModel'],
                'vae': ['diffusers', 'AutoencoderKL'],
                'text_encoder': ['transformers', 'Qwen3Model'],
            },
        )
        self.assertEqual(server.validate_model_dir(str(model), 'Flux2Pipeline'), model)

    def test_wrong_class_name(self):
        model = write_model_index(self.root / 'm', {'_class_name': 'StableDiffusionXLPipeline'})
        with self.assertRaises(ValueError) as ctx:
            server.validate_model_dir(str(model), 'Flux2Pipeline')
        self.assertIn('_class_name', str(ctx.exception))

    def test_custom_library_entry_is_refused(self):
        model = write_model_index(
            self.root / 'm',
            {'_class_name': 'Flux2Pipeline', 'transformer': ['my_custom_library', 'EvilModel']},
        )
        with self.assertRaises(ValueError) as ctx:
            server.validate_model_dir(str(model), 'Flux2Pipeline')
        self.assertIn('my_custom_library', str(ctx.exception))

    def test_non_component_entries_are_allowed(self):
        """Scalars, dicts, numeric schedules and [null, null] are not components."""
        model = write_model_index(
            self.root / 'm',
            {
                '_class_name': 'QwenImage21Pipeline',
                'transformer': ['diffusers', 'QwenImage21Transformer2DModel'],
                'vae': [None, None],  # optional component left unloaded
                # Qwen-Image-2.1-Turbo ships a sigma schedule in model_index.json.
                'sample_sigmas': [1.0, 0.978453, 0.95418, 0.0],
                'some_config': {'key': 'value'},
                'num_layers': 42,
            },
        )
        self.assertEqual(server.validate_model_dir(str(model), 'QwenImage21Pipeline'), model)

    def test_component_shaped_entries_are_still_checked(self):
        # Exactly ["library", "ClassName"] strings -> allow-list applies.
        model = write_model_index(
            self.root / 'm',
            {'_class_name': 'Flux2Pipeline', 'transformer': ['my_module', 'MyPipe']},
        )
        with self.assertRaises(ValueError) as ctx:
            server.validate_model_dir(str(model), 'Flux2Pipeline')
        self.assertIn('my_module', str(ctx.exception))

    def test_missing_model_index(self):
        model = self.root / 'empty'
        model.mkdir()
        with self.assertRaises(ValueError) as ctx:
            server.validate_model_dir(str(model), 'Flux2Pipeline')
        self.assertIn('model_index.json', str(ctx.exception))

    def test_missing_directory(self):
        with self.assertRaises(ValueError):
            server.validate_model_dir(str(self.root / 'nope'), 'Flux2Pipeline')


class ParseArgsTest(unittest.TestCase):
    def test_rejects_non_loopback_listen_ip(self):
        for bad in ('0.0.0.0', '::1', '192.168.1.10', 'example.com'):
            with self.subTest(listen_ip=bad):
                with self.assertRaises(SystemExit) as ctx:
                    server.parse_args(BASE_ARGS + ['--listen-ip', bad])
                self.assertEqual(ctx.exception.code, 2)

    def test_accepts_loopback_and_defaults(self):
        args = server.parse_args(BASE_ARGS + ['--listen-ip', 'localhost'])
        self.assertEqual(args.listen_ip, 'localhost')
        args = server.parse_args(BASE_ARGS)
        self.assertEqual(args.listen_ip, '127.0.0.1')
        self.assertEqual(args.pipeline, 'Flux2Pipeline')
        self.assertEqual(args.offload, 'model')
        self.assertEqual(args.text_encoder_quant, 'none')
        self.assertEqual(args.lora_scale, 1.0)
        self.assertEqual(args.device, 'cuda')
        self.assertEqual(args.dtype, 'bfloat16')
        self.assertFalse(args.vae_tiling)
        self.assertIsNone(args.transformer_gguf)
        self.assertIsNone(args.lora)


class BuildCallKwargsTest(unittest.TestCase):
    """build_call_kwargs for each pipeline: cfg mapping, sigmas, clamps, seed, images."""

    QWEN_TURBO_SIGMAS = [1.0, 0.978453, 0.95418, 0.926626, 0.89508, 0.845148, 0.704534, 0.414568, 0.0]
    FLUX_TURBO_SIGMAS = [1.0, 0.6509, 0.4374, 0.2932, 0.1893, 0.1108, 0.0495, 0.00031]

    def build(self, pipeline, body, defaults=None, images=None):
        spec = server.PIPELINES[pipeline]
        return server.build_call_kwargs(spec, body, defaults or {'steps': spec.default_steps, 'cfg': spec.default_cfg}, images)

    def test_qwen_uses_true_cfg_scale_and_negative_prompt(self):
        kwargs = self.build('QwenImage21Pipeline', {
            'prompt': 'a cat',
            'negative_prompt': 'blurry',
            'sample_params': {'sample_steps': 40, 'guidance': {'txt_cfg': 1.0}},
        })
        self.assertEqual(kwargs['true_cfg_scale'], 1.0)
        self.assertEqual(kwargs['negative_prompt'], 'blurry')
        self.assertEqual(kwargs['num_inference_steps'], 40)

    def test_qwen_defaults(self):
        kwargs = self.build('QwenImage21Pipeline', {'prompt': 'a cat'})
        self.assertEqual(kwargs['num_inference_steps'], 40)
        self.assertEqual(kwargs['true_cfg_scale'], 1.0)
        self.assertNotIn('negative_prompt', kwargs)
        self.assertNotIn('image', kwargs)

    def test_flux2_uses_guidance_scale_and_drops_negative_prompt(self):
        kwargs = self.build('Flux2Pipeline', {
            'prompt': 'a cat',
            'negative_prompt': 'blurry',
            'sample_params': {'sample_steps': 28, 'guidance': {'txt_cfg': 4.0}},
        })
        self.assertEqual(kwargs['guidance_scale'], 4.0)
        self.assertNotIn('true_cfg_scale', kwargs)
        self.assertNotIn('negative_prompt', kwargs)

    def test_klein_pins_guidance_scale_to_one(self):
        kwargs = self.build('Flux2KleinPipeline', {
            'prompt': 'a cat',
            'sample_params': {'sample_steps': 4, 'guidance': {'txt_cfg': 4.0}},
        })
        self.assertEqual(kwargs['num_inference_steps'], 4)
        self.assertNotIn('true_cfg_scale', kwargs)
        # FLUX.2 klein's CFG turns on whenever guidance_scale > 1 (the repo
        # config lacks is_distilled=true, class default 4.0), so it is pinned
        # to 1.0 regardless of the request.
        self.assertEqual(kwargs['guidance_scale'], 1.0)

    def test_sigmas_with_trailing_zero_terminator_are_trimmed(self):
        # sd.cpp turbo preset: steps + 1 entries ending in 0.0 → drop the zero.
        kwargs = self.build('QwenImage21Pipeline', {
            'prompt': 'a cat',
            'sample_params': {'sample_steps': 8, 'custom_sigmas': self.QWEN_TURBO_SIGMAS},
        })
        self.assertEqual(kwargs['num_inference_steps'], 8)
        self.assertEqual(len(kwargs['sigmas']), 8)
        self.assertNotEqual(kwargs['sigmas'][-1], 0.0)

    def test_sigmas_without_terminator_are_kept(self):
        # fal's pre-shifted schedule ends in 0.00031 and has exactly `steps` entries.
        kwargs = self.build('Flux2Pipeline', {
            'prompt': 'a cat',
            'sample_params': {'sample_steps': 8, 'custom_sigmas': self.FLUX_TURBO_SIGMAS},
        })
        self.assertEqual(kwargs['num_inference_steps'], 8)
        self.assertEqual(kwargs['sigmas'], self.FLUX_TURBO_SIGMAS)

    def test_sigmas_terminator_kept_when_length_does_not_match_steps(self):
        sigmas = [0.9, 0.5, 0.0]
        kwargs = self.build('QwenImage21Pipeline', {
            'prompt': 'a cat',
            'sample_params': {'sample_steps': 20, 'custom_sigmas': sigmas},
        })
        self.assertEqual(kwargs['num_inference_steps'], 3)
        self.assertEqual(kwargs['sigmas'], sigmas)

    def test_clamping_and_rounding(self):
        kwargs = self.build('Flux2Pipeline', {
            'prompt': 'a cat',
            'width': 9999,
            'height': 250,
            'batch_count': 99,
            'sample_params': {'sample_steps': 500, 'guidance': {'txt_cfg': 99}},
        })
        self.assertEqual(kwargs['width'], 2048)
        self.assertEqual(kwargs['height'], 256)
        self.assertEqual(kwargs['num_images_per_prompt'], 4)
        self.assertEqual(kwargs['num_inference_steps'], 200)
        self.assertEqual(kwargs['guidance_scale'], 30.0)

    def test_width_rounds_down_to_multiple_of_16(self):
        kwargs = self.build('Flux2Pipeline', {'prompt': 'a cat', 'width': 300, 'height': 513})
        self.assertEqual(kwargs['width'], 288)
        self.assertEqual(kwargs['height'], 512)

    def test_seed_fixed_and_random(self):
        self.assertEqual(self.build('Flux2Pipeline', {'prompt': 'a cat', 'seed': 123})['_seed'], 123)
        first = self.build('Flux2Pipeline', {'prompt': 'a cat', 'seed': -1})['_seed']
        second = self.build('Flux2Pipeline', {'prompt': 'a cat'})['_seed']
        for seed in (first, second):
            self.assertGreaterEqual(seed, 0)
            self.assertLess(seed, server.SEED_LIMIT)
        self.assertNotEqual(first, second)

    def test_reference_image_single_and_list(self):
        single = self.build('Flux2Pipeline', {'prompt': 'a cat'}, images=['img-a'])
        self.assertEqual(single['image'], 'img-a')
        many = self.build('Flux2Pipeline', {'prompt': 'a cat'}, images=['img-a', 'img-b'])
        self.assertEqual(many['image'], ['img-a', 'img-b'])
        none = self.build('Flux2Pipeline', {'prompt': 'a cat'}, images=[])
        self.assertNotIn('image', none)

    def test_prompt_validation(self):
        with self.assertRaises(ValueError):
            self.build('Flux2Pipeline', {})
        with self.assertRaises(ValueError):
            self.build('Flux2Pipeline', {'prompt': '   '})
        with self.assertRaises(ValueError):
            self.build('Flux2Pipeline', {'prompt': 'x' * (server.MAX_PROMPT_CHARS + 1)})

    def test_bad_value_types_raise(self):
        for body in (
            {'prompt': 'a cat', 'width': 'wide'},
            {'prompt': 'a cat', 'batch_count': 'many'},
            {'prompt': 'a cat', 'sample_params': {'sample_steps': 'lots'}},
            {'prompt': 'a cat', 'sample_params': {'guidance': {'txt_cfg': 'high'}}},
            {'prompt': 'a cat', 'sample_params': {'custom_sigmas': '1, 2, 3'}},
            {'prompt': 'a cat', 'sample_params': {'custom_sigmas': [1.0, 'x']}},
        ):
            with self.subTest(body=body):
                with self.assertRaises(ValueError):
                    self.build('Flux2Pipeline', body)


class DataUrlAndEncodeTest(unittest.TestCase):
    def test_decode_data_url(self):
        raw = b'\x89PNG fake bytes'
        url = 'data:image/png;base64,' + base64.b64encode(raw).decode()
        self.assertEqual(server.decode_data_url(url), raw)

    def test_decode_data_url_rejects_garbage(self):
        for bad in ('http://x/y.png', 'text/plain;base64,AAAA', 'data:image/png;base64,!!!', 'data:image/png;base64,'):
            with self.subTest(url=bad):
                with self.assertRaises(ValueError):
                    server.decode_data_url(bad)

    def test_encode_images_passthrough_bytes(self):
        encoded = server.encode_images([PNG_1PX], 'png')
        self.assertEqual(base64.b64decode(encoded[0]), PNG_1PX)

    def test_encode_images_rejects_unknown_format(self):
        with self.assertRaises(ValueError):
            server.encode_images([PNG_1PX], 'gif')

    def test_progress_lines_match_the_client_regexes(self):
        line = server.format_progress_line(5, 20, 1.234)
        match = PROGRESS_RE.search(line)
        self.assertIsNotNone(match, line)
        self.assertEqual((match.group(1), match.group(2)), ('5', '20'))
        self.assertTrue(match.group(3).startswith('1.23'))
        full = PROGRESS_RE.search(server.format_progress_line(20, 20, 0.98))
        self.assertIsNotNone(full)
        # The stage lines must NOT look like progress lines (parseStageLine owns them).
        self.assertFalse(PROGRESS_RE.search('generating image: 1/1'))
        self.assertTrue(SAMPLING_RE.search('generating image: 1/1'))
        self.assertTrue(DECODING_RE.search('decoding 1 latents'))
        self.assertFalse(PROGRESS_RE.search('decoding 1 latents'))
        self.assertFalse(PROGRESS_RE.search('generated in 12.34s'))


try:  # Pillow is optional for these tests; the PIL branch of encode_images is lazy.
    from PIL import Image  # noqa: F401

    HAVE_PIL = True
except ImportError:
    HAVE_PIL = False


@unittest.skipUnless(HAVE_PIL, 'Pillow is not installed')
class EncodePilImageTest(unittest.TestCase):
    def test_encodes_pil_image_as_jpeg_and_png(self):
        from io import BytesIO

        image = Image.new('RGB', (2, 2), (250, 10, 10))
        jpeg = base64.b64decode(server.encode_images([image], 'jpeg', 85)[0])
        with Image.open(BytesIO(jpeg)) as decoded:
            self.assertEqual(decoded.format, 'JPEG')
        png = base64.b64decode(server.encode_images([image], 'png')[0])
        with Image.open(BytesIO(png)) as decoded:
            self.assertEqual(decoded.format, 'PNG')


# ---------------------------------------------------------------------------
# HTTP round trips against a FakeEngine


class FakeEngine:
    """Engine double: capabilities from the real builder; generate blocks until released."""

    def __init__(self, pipeline: str = 'Flux2Pipeline'):
        self.spec = server.PIPELINES[pipeline]
        self.defaults = {'steps': self.spec.default_steps, 'cfg': self.spec.default_cfg}
        self.started = threading.Event()
        self.release = threading.Event()
        self.fail = False
        self.calls: list[dict] = []

    def capabilities(self):
        return server.build_capabilities(self.spec, 'Test Model', 'Test+Model', '/models/test', 'cuda', 'bfloat16')

    def generate(self, kwargs, on_step, should_cancel):
        self.calls.append(dict(kwargs))
        self.started.set()
        while not self.release.is_set():
            if should_cancel():
                return []
            time.sleep(0.005)
        if self.fail:
            raise RuntimeError('engine exploded')
        on_step(1, 2, 0.5)
        on_step(2, 2, 0.5)
        return [bytes(PNG_1PX)]


class WorkerSurvivesEscapingExceptionsTest(unittest.TestCase):
    """The worker's catch-all: even failing error logging must not kill it.

    An exception escaping _execute (e.g. from inside its except/finally
    handlers) would leave the job stuck in 'generating' and queue every later
    job forever, so _worker_loop marks the job failed and keeps running.
    """

    def wait_until(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return False

    def test_job_fails_and_loop_survives_when_logging_raises(self):
        raised = threading.Event()

        class FailOnceEngine(FakeEngine):
            """Raises on the first generate() call, succeeds afterwards."""

            def generate(self, kwargs, on_step, should_cancel):
                if not raised.is_set():
                    raised.set()
                    self.calls.append(dict(kwargs))
                    self.started.set()
                    while not self.release.is_set():
                        if should_cancel():
                            return []
                        time.sleep(0.005)
                    raise RuntimeError('engine exploded')
                return super().generate(kwargs, on_step, should_cancel)

        engine = FailOnceEngine()
        engine.release.set()  # the failing generate() raises immediately
        queue = server.JobQueue(engine, job_ttl=60.0)
        queue.start()
        self.addCleanup(queue.stop)

        def exploding_traceback() -> None:
            raise RuntimeError('traceback logging exploded')

        with mock.patch.object(server, 'log_traceback', exploding_traceback):
            queue.submit(server.Job(id='bad', kwargs={'prompt': 'bad'}))
            queue.submit(server.Job(id='good', kwargs={'prompt': 'good'}))
            # The follow-up job must still complete: the worker loop survived.
            self.assertTrue(
                self.wait_until(lambda: (queue.get('good') or {}).get('status') == server.COMPLETED)
            )
        snapshot = queue.get('bad')
        self.assertEqual(snapshot['status'], server.FAILED)
        self.assertIn('internal error:', snapshot['error']['message'])
        self.assertIn('traceback logging exploded', snapshot['error']['message'])
        # finished_at was set even though _execute's own finally was bypassed.
        self.assertIsNotNone(queue._jobs['bad'].finished_at)


class JobQueueCancelRaceTest(unittest.TestCase):
    """The queued-cancel race: pop + GENERATING must be atomic under the lock."""

    def setUp(self):
        self.engine = FakeEngine()  # generate blocks until released
        self.queue = server.JobQueue(self.engine, job_ttl=60.0)
        self.queue.start()
        self.addCleanup(self.queue.stop)

    def wait_until(self, predicate, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if predicate():
                return True
            time.sleep(0.01)
        return False

    def test_cancelled_queued_job_never_reaches_the_engine(self):
        first = server.Job(id='a', kwargs={'prompt': 'first'})
        second = server.Job(id='b', kwargs={'prompt': 'second'})
        self.queue.submit(first)
        # first occupies the worker: FakeEngine.generate blocks until released
        self.assertTrue(self.wait_until(lambda: len(self.engine.calls) == 1))
        self.assertEqual(first.status, server.GENERATING)
        self.queue.submit(second)
        self.assertEqual(self.queue.cancel('b'), server.CANCELLED)
        self.assertEqual(second.status, server.CANCELLED)
        self.engine.release.set()
        # The worker drains the queue; the cancelled job must never run.
        self.assertTrue(
            self.wait_until(lambda: (self.queue.get('a') or {}).get('status') == server.COMPLETED)
        )
        self.assertEqual([call['prompt'] for call in self.engine.calls], ['first'])
        self.assertEqual(self.queue.get('b')['status'], server.CANCELLED)

    def test_execute_skips_already_cancelled_jobs(self):
        job = server.Job(id='c', kwargs={'prompt': 'ghost'})
        job.status = server.CANCELLED
        self.queue._execute(job)  # must return without calling generate
        self.assertEqual(self.engine.calls, [])
        self.assertEqual(job.status, server.CANCELLED)
        self.assertIsNone(job.finished_at)


class HttpServerTest(unittest.TestCase):
    def setUp(self):
        self._servers: list = []
        self._threads: list[threading.Thread] = []

    def tearDown(self):
        for srv in self._servers:
            srv.shutdown()
            srv.state.queue.stop()
            srv.server_close()
        for thread in self._threads:
            thread.join(timeout=5)

    def start_server(self, engine, max_queue_size=server.MAX_QUEUE_SIZE, job_ttl=server.JOB_TTL_SECONDS):
        srv = server.make_server(engine, '127.0.0.1', 0, max_queue_size=max_queue_size, job_ttl=job_ttl)
        self._servers.append(srv)
        thread = threading.Thread(target=srv.serve_forever, daemon=True)
        thread.start()
        self._threads.append(thread)
        return srv, srv.server_address[1]

    def request(self, port, method, path, body=None, raw_body=None):
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            payload = raw_body if raw_body is not None else (json.dumps(body).encode() if body is not None else None)
            conn.request(method, path, body=payload)
            response = conn.getresponse()
            data = response.read()
            return response.status, (json.loads(data) if data else None)
        finally:
            conn.close()

    def submit(self, port, body):
        return self.request(port, 'POST', '/sdcpp/v1/img_gen', body)

    def wait_for(self, port, job_id, status, timeout=5.0):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            _, job = self.request(port, 'GET', f'/sdcpp/v1/jobs/{job_id}')
            if job is not None and job.get('status') == status:
                return job
            time.sleep(0.02)
        self.fail(f'job {job_id} did not reach status {status!r} within {timeout}s')

    # -- capabilities ---------------------------------------------------------

    def test_capabilities_shape(self):
        _, port = self.start_server(FakeEngine())
        status, caps = self.request(port, 'GET', '/sdcpp/v1/capabilities')
        self.assertEqual(status, 200)
        for key in (
            'backend', 'diffusers', 'model', 'supported_modes', 'defaults_by_mode',
            'output_formats_by_mode', 'features_by_mode', 'samplers', 'schedulers',
            'loras', 'upscalers', 'upscale', 'limits',
        ):
            self.assertIn(key, caps)
        self.assertEqual(caps['backend'], 'diffusers')
        self.assertEqual(caps['diffusers']['pipeline'], 'Flux2Pipeline')
        self.assertEqual(caps['diffusers']['supports'], ['txt_cfg', 'ref_images', 'custom_sigmas', 'steps', 'seed', 'batch_count'])
        self.assertEqual(caps['diffusers']['device'], 'cuda')
        self.assertEqual(caps['diffusers']['dtype'], 'bfloat16')
        self.assertEqual(caps['model'], {'name': 'Test Model', 'stem': 'Test+Model', 'path': '/models/test'})
        self.assertEqual(caps['supported_modes'], ['img_gen'])
        self.assertEqual(caps['output_formats_by_mode'], {'img_gen': ['png', 'jpeg', 'webp']})
        features = caps['features_by_mode']['img_gen']
        self.assertFalse(features['negative_prompt'])  # Flux2 has no negative prompt
        self.assertTrue(features['ref_images'])
        self.assertFalse(features['init_image'])
        defaults = caps['defaults_by_mode']['img_gen']
        self.assertEqual(defaults['width'], 1024)
        self.assertEqual(defaults['height'], 1024)
        self.assertEqual(defaults['seed'], -1)
        self.assertEqual(defaults['batch_count'], 1)
        self.assertEqual(defaults['sample_params'], {'sample_steps': 28, 'guidance': {'txt_cfg': 4.0}})
        self.assertEqual(
            caps['limits'],
            {
                'min_width': 256, 'max_width': 2048, 'min_height': 256, 'max_height': 2048,
                'max_batch_count': 4, 'max_queue_size': 8, 'max_upscale_width': 0, 'max_upscale_height': 0,
            },
        )
        self.assertFalse(caps['upscale'])
        self.assertEqual(caps['samplers'], [])
        self.assertEqual(caps['upscalers'], [])

    def test_capabilities_reflect_pipeline_support(self):
        _, port = self.start_server(FakeEngine('QwenImage21Pipeline'))
        _, caps = self.request(port, 'GET', '/sdcpp/v1/capabilities')
        self.assertTrue(caps['features_by_mode']['img_gen']['negative_prompt'])
        self.assertIn('negative_prompt', caps['diffusers']['supports'])
        self.assertEqual(caps['defaults_by_mode']['img_gen']['sample_params']['sample_steps'], 40)

    # -- keep-alive -------------------------------------------------------------
    # The Electron client's Node fetch reuses connections, so the handler must
    # reset its per-request state and consume every request body.

    def test_keep_alive_two_requests_one_connection(self):
        _, port = self.start_server(FakeEngine())
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            for _ in range(2):
                conn.request('GET', '/sdcpp/v1/capabilities')
                response = conn.getresponse()
                data = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(data['backend'], 'diffusers')
        finally:
            conn.close()

    def test_keep_alive_img_gen_and_poll_on_one_connection(self):
        engine = FakeEngine()
        engine.release.set()
        _, port = self.start_server(engine)
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            conn.request('GET', '/sdcpp/v1/capabilities')
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 200)
            conn.request('POST', '/sdcpp/v1/img_gen', body=json.dumps({'prompt': 'a cat'}).encode())
            response = conn.getresponse()
            submitted = json.loads(response.read())
            self.assertEqual(response.status, 200)
            # Poll on the SAME connection until the job finishes.
            job = None
            for _ in range(250):
                conn.request('GET', f"/sdcpp/v1/jobs/{submitted['id']}")
                response = conn.getresponse()
                job = json.loads(response.read())
                self.assertEqual(response.status, 200)
                if job['status'] == 'completed':
                    break
                time.sleep(0.02)
            self.assertEqual(job['status'], 'completed')
        finally:
            conn.close()

    def test_keep_alive_unread_post_body_then_get(self):
        # upscale / cancel / unknown POST routes ignore the body; the bytes
        # must still be drained so the next request on the connection works.
        _, port = self.start_server(FakeEngine())
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            for path in ('/sdcpp/v1/upscale', '/sdcpp/v1/jobs/abc/cancel', '/nope'):
                conn.request(
                    'POST', path,
                    body=json.dumps({'anything': 'x' * 64}).encode(),
                    headers={'Content-Type': 'application/json'},
                )
                response = conn.getresponse()
                response.read()
                self.assertIn(response.status, (200, 404, 501))
                # The next request on the SAME connection must not be corrupted.
                conn.request('GET', '/sdcpp/v1/capabilities')
                response = conn.getresponse()
                data = json.loads(response.read())
                self.assertEqual(response.status, 200)
                self.assertEqual(data['backend'], 'diffusers')
        finally:
            conn.close()

    # -- happy path -----------------------------------------------------------

    def test_submit_poll_completed(self):
        engine = FakeEngine()
        engine.release.set()
        _, port = self.start_server(engine)
        status, submitted = self.submit(port, {'prompt': 'a cat', 'width': 512, 'height': 512})
        self.assertEqual(status, 200)
        self.assertRegex(submitted['id'], r'^[0-9a-f]{32}$')

        job = self.wait_for(port, submitted['id'], 'completed')
        # queue_position is only present while queued: the Node client treats
        # a numeric value as "still waiting in queue".
        self.assertNotIn('queue_position', job)
        self.assertIsNone(job['error'])
        result = job['result']
        self.assertEqual(result['output_format'], 'png')
        self.assertEqual(len(result['images']), 1)
        self.assertEqual(base64.b64decode(result['images'][0]['b64_json']), PNG_1PX)
        # The engine received normalized pipeline kwargs.
        call = engine.calls[0]
        self.assertEqual(call['prompt'], 'a cat')
        self.assertEqual(call['width'], 512)
        self.assertIn('guidance_scale', call)
        self.assertIn('_seed', call)

    def test_unknown_fields_are_ignored(self):
        engine = FakeEngine()
        engine.release.set()
        _, port = self.start_server(engine)
        status, _ = self.submit(port, {'prompt': 'a cat', 'hires': {'enabled': True}, 'lora': [{'path': 'x'}]})
        self.assertEqual(status, 200)

    def test_queued_jobs_report_one_based_queue_position(self):
        engine = FakeEngine()  # not released: the first job keeps the worker busy
        _, port = self.start_server(engine)
        _, first = self.submit(port, {'prompt': 'first'})
        self.assertTrue(engine.started.wait(5))
        _, second = self.submit(port, {'prompt': 'second'})
        _, third = self.submit(port, {'prompt': 'third'})
        _, second_job = self.request(port, 'GET', f"/sdcpp/v1/jobs/{second['id']}")
        self.assertEqual(second_job['status'], 'queued')
        self.assertEqual(second_job['queue_position'], 1)
        _, third_job = self.request(port, 'GET', f"/sdcpp/v1/jobs/{third['id']}")
        self.assertEqual(third_job['queue_position'], 2)
        # A generating/completed job must not carry a queue_position at all.
        _, first_job = self.request(port, 'GET', f"/sdcpp/v1/jobs/{first['id']}")
        self.assertEqual(first_job['status'], 'generating')
        self.assertNotIn('queue_position', first_job)

    # -- cancellation -----------------------------------------------------------

    def test_cancel_queued_job(self):
        engine = FakeEngine()  # not released: the first job keeps the worker busy
        _, port = self.start_server(engine)
        _, first = self.submit(port, {'prompt': 'first'})
        engine.started.wait(5)
        _, second = self.submit(port, {'prompt': 'second'})
        status, payload = self.request(port, 'POST', f"/sdcpp/v1/jobs/{second['id']}/cancel")
        self.assertEqual(status, 200)
        self.assertEqual(payload['status'], 'cancelled')
        job = self.wait_for(port, second['id'], 'cancelled')
        self.assertIsNone(job['result'])

    def test_cancel_generating_job(self):
        engine = FakeEngine()
        _, port = self.start_server(engine)
        _, submitted = self.submit(port, {'prompt': 'a cat'})
        self.assertTrue(engine.started.wait(5))
        status, payload = self.request(port, 'POST', f"/sdcpp/v1/jobs/{submitted['id']}/cancel")
        self.assertEqual(status, 200)
        self.assertEqual(payload['status'], 'cancelling')
        self.wait_for(port, submitted['id'], 'cancelled')

    def test_cancel_finished_job_is_a_noop(self):
        engine = FakeEngine()
        engine.release.set()
        _, port = self.start_server(engine)
        _, submitted = self.submit(port, {'prompt': 'a cat'})
        self.wait_for(port, submitted['id'], 'completed')
        status, payload = self.request(port, 'POST', f"/sdcpp/v1/jobs/{submitted['id']}/cancel")
        self.assertEqual(status, 200)
        self.assertEqual(payload['status'], 'completed')

    def test_cancel_unknown_job_404(self):
        _, port = self.start_server(FakeEngine())
        status, payload = self.request(port, 'POST', '/sdcpp/v1/jobs/deadbeef/cancel')
        self.assertEqual(status, 404)
        self.assertIn('error', payload)

    # -- failures -----------------------------------------------------------------

    def test_failed_job_reports_error_message(self):
        engine = FakeEngine()
        engine.fail = True
        engine.release.set()
        _, port = self.start_server(engine)
        _, submitted = self.submit(port, {'prompt': 'a cat'})
        job = self.wait_for(port, submitted['id'], 'failed')
        self.assertIsNone(job['result'])
        self.assertEqual(job['error']['message'], 'engine exploded')

    def test_finished_jobs_expire_after_ttl(self):
        engine = FakeEngine()
        engine.release.set()
        _, port = self.start_server(engine, job_ttl=0.5)
        _, submitted = self.submit(port, {'prompt': 'a cat'})
        self.wait_for(port, submitted['id'], 'completed')
        # Still well inside the TTL window.
        _, job = self.request(port, 'GET', f"/sdcpp/v1/jobs/{submitted['id']}")
        self.assertEqual(job['status'], 'completed')
        time.sleep(0.8)
        status, _ = self.request(port, 'GET', f"/sdcpp/v1/jobs/{submitted['id']}")
        self.assertEqual(status, 404)

    # -- validation / status codes -------------------------------------------------

    def test_400_invalid_json(self):
        _, port = self.start_server(FakeEngine())
        status, payload = self.request(port, 'POST', '/sdcpp/v1/img_gen', raw_body=b'not json')
        self.assertEqual(status, 400)
        self.assertIn('error', payload)

    def test_400_missing_prompt(self):
        _, port = self.start_server(FakeEngine())
        status, _ = self.submit(port, {})
        self.assertEqual(status, 400)

    def test_400_bad_ref_image(self):
        _, port = self.start_server(FakeEngine())
        status, _ = self.submit(port, {'prompt': 'a cat', 'ref_images': ['not-a-data-url']})
        self.assertEqual(status, 400)

    def test_400_img2img_and_inpaint_fields_rejected(self):
        _, port = self.start_server(FakeEngine())
        message = 'The diffusers backend does not support img2img or inpainting — use reference images to edit'
        for field in ('init_image', 'mask_image', 'control_image'):
            with self.subTest(field=field):
                status, payload = self.submit(port, {'prompt': 'a cat', field: 'data:image/png;base64,AAAA'})
                self.assertEqual(status, 400)
                self.assertEqual(payload['error'], message)
        # Empty / absent values are ignored (the client sends '' for unused fields).
        status, _ = self.submit(port, {'prompt': 'a cat', 'init_image': '', 'mask_image': None})
        self.assertEqual(status, 200)

    def test_400_too_many_ref_images(self):
        _, port = self.start_server(FakeEngine())
        url = 'data:image/png;base64,' + base64.b64encode(b'x').decode()
        status, _ = self.submit(port, {'prompt': 'a cat', 'ref_images': [url] * (server.MAX_REF_IMAGES + 1)})
        self.assertEqual(status, 400)

    def test_400_bad_output_format(self):
        _, port = self.start_server(FakeEngine())
        status, _ = self.submit(port, {'prompt': 'a cat', 'output_format': 'gif'})
        self.assertEqual(status, 400)

    def test_404_unknown_paths(self):
        _, port = self.start_server(FakeEngine())
        for method, path in (('GET', '/nope'), ('GET', '/sdcpp/v1/img_gen'), ('POST', '/sdcpp/v1/capabilities')):
            with self.subTest(method=method, path=path):
                status, payload = self.request(port, method, path)
                self.assertEqual(status, 404)

    def test_404_unknown_job(self):
        _, port = self.start_server(FakeEngine())
        status, _ = self.request(port, 'GET', '/sdcpp/v1/jobs/deadbeef')
        self.assertEqual(status, 404)

    def test_413_oversized_body(self):
        _, port = self.start_server(FakeEngine())
        conn = http.client.HTTPConnection('127.0.0.1', port, timeout=10)
        try:
            conn.request('POST', '/sdcpp/v1/img_gen', headers={'Content-Length': str(server.MAX_BODY_BYTES + 1)})
            response = conn.getresponse()
            response.read()
            self.assertEqual(response.status, 413)
        finally:
            conn.close()

    def test_429_queue_full(self):
        engine = FakeEngine()  # blocked: worker busy, one pending slot, rest rejected
        _, port = self.start_server(engine, max_queue_size=1)
        _, first = self.submit(port, {'prompt': 'first'})
        self.assertTrue(engine.started.wait(5))
        status, _ = self.submit(port, {'prompt': 'second'})
        self.assertEqual(status, 200)
        status, payload = self.submit(port, {'prompt': 'third'})
        self.assertEqual(status, 429)
        self.assertIn('full', payload['error'])

    def test_501_upscale(self):
        _, port = self.start_server(FakeEngine())
        status, payload = self.request(port, 'POST', '/sdcpp/v1/upscale', body={'image': 'data:image/png;base64,AAAA'})
        self.assertEqual(status, 501)
        self.assertEqual(payload['error'], 'Upscaling is not available with the diffusers backend')


if __name__ == '__main__':
    unittest.main()
