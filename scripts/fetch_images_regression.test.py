#!/usr/bin/env python3
import importlib.util
import os
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
FETCH_IMAGES_PATH = ROOT / "scripts" / "fetch_images.py"


def load_fetch_images():
    spec = importlib.util.spec_from_file_location("fetch_images", FETCH_IMAGES_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeResponse:
    def __init__(self, body):
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return self.body


class FetchImagesRegressionTest(unittest.TestCase):
    def test_long_query_results_do_not_overwrite_each_other(self):
        mod = load_fetch_images()
        old_api_get = mod._api_get
        old_urlopen = mod.urllib.request.urlopen
        query = "Petronas Towers " * 8

        def fake_api_get(_params):
            return {
                "query": {
                    "pages": {
                        "1": {
                            "title": "File:First distinctive tower photo.jpg",
                            "imageinfo": [{
                                "thumburl": "https://example.test/one.jpg",
                                "extmetadata": {},
                            }],
                        },
                        "2": {
                            "title": "File:Second distinctive tower photo.jpg",
                            "imageinfo": [{
                                "thumburl": "https://example.test/two.jpg",
                                "extmetadata": {},
                            }],
                        },
                    }
                }
            }

        def fake_urlopen(req, timeout=60):
            url = getattr(req, "full_url", req)
            return FakeResponse(b"one" if url.endswith("/one.jpg") else b"two")

        try:
            mod._api_get = fake_api_get
            mod.urllib.request.urlopen = fake_urlopen
            with tempfile.TemporaryDirectory() as tmp:
                paths = mod.fetch(query, tmp, count=2, width=1600)
                basenames = [os.path.basename(p) for p in paths]

                self.assertEqual(len(paths), 2)
                self.assertEqual(len(set(basenames)), 2)
                self.assertEqual(len(os.listdir(tmp)), 2)
                self.assertCountEqual(
                    [Path(p).read_bytes() for p in paths],
                    [b"one", b"two"],
                )
        finally:
            mod._api_get = old_api_get
            mod.urllib.request.urlopen = old_urlopen


if __name__ == "__main__":
    unittest.main()
