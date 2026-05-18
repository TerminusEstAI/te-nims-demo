import importlib.util
import unittest
from pathlib import Path


def _load_serve_module():
    repo_root = Path(__file__).resolve().parents[1]
    serve_path = repo_root / "web" / "serve.py"
    spec = importlib.util.spec_from_file_location("te_nims_serve", serve_path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class ProxyConfigTests(unittest.TestCase):
    def test_vision_url_env_is_trimmed(self):
        import os

        old = os.environ.get("SEVERIAN_VISION_URL")
        os.environ["SEVERIAN_VISION_URL"] = "http://te-nims-vision:8081///"
        try:
            serve = _load_serve_module()
            self.assertEqual(serve._resolve_vision_url(), "http://te-nims-vision:8081")
        finally:
            if old is None:
                os.environ.pop("SEVERIAN_VISION_URL", None)
            else:
                os.environ["SEVERIAN_VISION_URL"] = old

    def test_vision_proxy_allowlist_covers_demo_routes(self):
        serve = _load_serve_module()
        handler = serve.TileHandler
        self.assertIn("/v1/chat/completions", handler.VISION_ALLOWED_PATHS)
        self.assertIn("/health", handler.VISION_ALLOWED_PATHS)
