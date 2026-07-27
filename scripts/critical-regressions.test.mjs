import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repoRoot = path.resolve(import.meta.dirname, '..');

test('deck gallery requires complete thumbnails and fails safe to grid', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');

  assert.match(html, /const hasCompleteThumbs = deck\.length > 0 && deck\.every\(item => item && item\.thumb\);/);
  assert.match(html, /const OVERVIEW = \(requestedOverview === 'gallery' && hasCompleteThumbs\) \? 'gallery' : 'grid';/);
  assert.match(html, /if \(useImg\) \{\s+if \(!item\.thumb\) throw new Error\('gallery overview requires thumb/);
  assert.match(html, /function clearOverview\(\) \{\s+wall\.innerHTML = '';\s+gallery\.innerHTML = '';\s+\}/);
  assert.match(html, /fit\(\); show\(current, hasValidHash\);/);
});

test('thumbnail generator removes stale outputs and exits non-zero on partial failure', () => {
  const script = fs.readFileSync(path.join(repoRoot, 'scripts/gen_deck_thumbs.mjs'), 'utf8');

  assert.match(script, /const failures = \[\];/);
  assert.match(script, /fs\.rmSync\(out, \{ force: true \}\);/);
  assert.match(script, /failures\.push\(f\);/);
  assert.match(script, /process\.exit\(1\);/);
});

test('fetch_images keeps distinct files when truncated names collide', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huashu-fetch-images-'));
  const code = String.raw`
import importlib.util
import os
import sys

script_path, out_dir = sys.argv[1], sys.argv[2]
spec = importlib.util.spec_from_file_location("fetch_images", script_path)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

long_prefix = "Kuala Lumpur Petronas Towers view from the south with sunset "
titles = [
    "File:" + long_prefix + "version one.jpg",
    "File:" + long_prefix + "version two.jpg",
]
pages = {
    str(i): {
        "title": title,
        "imageinfo": [{
            "thumburl": f"https://example.invalid/{i}.jpg",
            "extmetadata": {
                "LicenseShortName": {"value": "CC"},
                "Artist": {"value": "Tester"},
            },
            "descriptionurl": f"https://example.invalid/page/{i}",
        }],
    }
    for i, title in enumerate(titles, 1)
}

def fake_api_get(params):
    return {"query": {"pages": pages}}

class FakeResponse:
    def __init__(self, payload):
        self.payload = payload
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return self.payload

def fake_urlopen(req, timeout=0):
    url = getattr(req, "full_url", str(req))
    return FakeResponse(url.encode("utf-8"))

mod._api_get = fake_api_get
mod.urllib.request.urlopen = fake_urlopen
got = mod.fetch("Malaysia", out_dir, 2, 1600, set())
assert len(got) == 2, got
assert len({os.path.basename(p) for p in got}) == 2, got
for p in got:
    assert os.path.exists(p), p
`;

  const result = spawnSync('python3', ['-c', code, path.join(repoRoot, 'scripts/fetch_images.py'), tmp], {
    encoding: 'utf8',
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
