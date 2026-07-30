import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => fs.readFileSync(path.join(root, ...parts), 'utf8');

test('deck gallery requires complete thumbnails and releases overview DOM in present mode', () => {
  const src = read('assets', 'deck_index.html');
  assert.match(src, /const HAS_COMPLETE_THUMBS = deck\.length > 0 && deck\.every\(item => item && item\.thumb\);/);
  assert.match(src, /const OVERVIEW = \(REQUESTED_OVERVIEW === 'gallery' && HAS_COMPLETE_THUMBS\) \? 'gallery' : 'grid';/);
  assert.match(src, /if \(!item\.thumb\) throw new Error\('Gallery card requires a thumb/);
  assert.match(src, /wall\.innerHTML = '';\s+gallery\.innerHTML = '';/);
  assert.match(src, /const hasValidHash = hashIndex >= 0 && hashIndex < deck\.length;/);
});

test('thumbnail generation fails closed and removes stale failed outputs', () => {
  const src = read('scripts', 'gen_deck_thumbs.mjs');
  assert.match(src, /fs\.rmSync\(out, \{ force: true \}\);/);
  assert.match(src, /if \(ok !== files\.length\) \{/);
  assert.match(src, /process\.exit\(1\);/);
});

test('fetch_images does not overwrite colliding truncated file names', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fetch-images-'));
  const code = String.raw`
import importlib.util
import os
import sys

script = sys.argv[1]
out = sys.argv[2]
spec = importlib.util.spec_from_file_location("fetch_images", script)
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)

mod._api_get = lambda params: {
    "query": {
        "pages": {
            "1": {"title": "File:Alpha.jpg", "imageinfo": [{"thumburl": "https://example.invalid/a.jpg", "extmetadata": {}}]},
            "2": {"title": "File:Beta.jpg", "imageinfo": [{"thumburl": "https://example.invalid/b.jpg", "extmetadata": {}}]},
        }
    }
}

class Response:
    def __init__(self, payload):
        self.payload = payload
    def __enter__(self):
        return self
    def __exit__(self, exc_type, exc, tb):
        return False
    def read(self):
        return self.payload

def fake_urlopen(req, timeout=60):
    fake_urlopen.calls += 1
    return Response(f"payload-{fake_urlopen.calls}".encode())
fake_urlopen.calls = 0
mod.urllib.request.urlopen = fake_urlopen

paths = mod.fetch("Q" * 80, out, 2, 1600, set())
assert len(paths) == 2, paths
assert paths[0] != paths[1], paths
assert sorted(os.listdir(out)) == sorted(os.path.basename(p) for p in paths)
assert open(paths[0], "rb").read() == b"payload-1"
assert open(paths[1], "rb").read() == b"payload-2"
`;
  const result = spawnSync('python3', ['-c', code, path.join(root, 'scripts', 'fetch_images.py'), tmp], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('PPTX export removes stale output on failed slides unless partial output is explicit', () => {
  const src = read('scripts', 'export_deck_pptx.mjs');
  assert.match(src, /allow-partial/);
  assert.match(src, /await fs\.rm\(outFile, \{ force: true \}\);/);
  assert.match(src, /默认不生成缺页 PPTX/);
});

test('video chrome hiding does not hide common content class names', () => {
  for (const script of ['render-video.js', 'render-video-seek.js']) {
    const src = read('scripts', script);
    const css = src.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/)?.[1] || '';
    assert.doesNotMatch(css, /\.title\b/);
    assert.doesNotMatch(css, /\.kicker\b/);
    assert.doesNotMatch(css, /\.masthead\b/);
    assert.doesNotMatch(css, /\.footer\b/);
  }
});

test('seek renderer requires frozen-clock handshake and exact frame output', () => {
  const src = read('scripts', 'render-video-seek.js');
  assert.match(src, /const TOTAL_FRAMES = Math\.max\(1, Math\.ceil\(FPS \* DURATION\)\);/);
  assert.match(src, /window\.__seekRenderReady === true/);
  assert.match(src, /page\.waitForFunction\([\s\S]*?\n\s+null,\n\s+\{ timeout: READY_TIMEOUT \* 1000 \}/);
  assert.match(src, /if \(pngCount !== TOTAL_FRAMES\)/);
  assert.match(src, /'-start_number', '0'/);
  assert.match(src, /fs\.rmSync\(MP4_OUT, \{ force: true \}\);/);
});

test('Stage runtimes publish seek-render readiness only on frozen seek path', () => {
  const animations = read('assets', 'animations.jsx');
  const narration = read('assets', 'narration_stage.jsx');
  assert.match(animations, /window\.__seekRenderReady = true;/);
  assert.match(narration, /window\.__seekRenderReady = true;/);
});

test('voiceover ducking splits voice stream and does not fade out from t=0', () => {
  const src = read('scripts', 'mix-voiceover.sh');
  assert.match(src, /asplit=2\[voice_sc\]\[voice_mix\]/);
  assert.doesNotMatch(src, /afade=t=out:st=0/);
});
