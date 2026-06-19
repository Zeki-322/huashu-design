import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test('export_deck_pptx fails closed instead of writing a truncated deck', () => {
  const dir = tempDir('pptx-partial-');
  const slides = path.join(dir, 'slides');
  fs.mkdirSync(slides);
  fs.writeFileSync(path.join(slides, '01-valid.html'), `<!doctype html>
<html><head><style>
body{width:1280px;height:720px;margin:0;overflow:hidden;font-family:Arial}
.box{position:absolute;left:100px;top:100px;width:400px;height:120px;background:#eee}
</style></head><body><div class="box"><p>Hello</p></div></body></html>`);
  fs.writeFileSync(path.join(slides, '02-invalid.html'), `<!doctype html>
<html><head><style>
body{width:1280px;height:720px;margin:0;overflow:hidden;font-family:Arial}
.bad{position:absolute;left:100px;top:100px;width:400px;height:120px}
</style></head><body><div class="bad">This direct text violates html2pptx constraints</div></body></html>`);

  const out = path.join(dir, 'out.pptx');
  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/export_deck_pptx.mjs'),
    '--slides', slides,
    '--out', out,
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 90000 });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(out), false, 'partial PPTX output should be removed');
  assert.match(result.stderr, /不生成缺页 PPTX/);
});

test('deck_index forces grid when gallery thumbnails are missing', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto('file://' + path.join(repoRoot, 'assets/deck_index.html') + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForTimeout(300);
    const result = await page.evaluate(() => ({
      ov: document.body.getAttribute('data-ov'),
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    }));
    assert.equal(result.ov, 'grid');
    assert.equal(result.galleryIframes, 0);
    assert.ok(result.gridIframes > 0, 'grid overview should still render iframe cards');
  } finally {
    await browser.close();
  }
});

test('render-video-seek rejects pages that expose __seek without a frozen clock', () => {
  const dir = tempDir('seek-false-positive-');
  const html = path.join(dir, 'bad-seek.html');
  fs.writeFileSync(html, `<!doctype html>
<html><body style="margin:0;width:160px;height:90px;background:#fff">
<div id="box" style="width:160px;height:90px;background:#f00"></div>
<script>
let start = performance.now();
function paint(t){ document.getElementById('box').style.background = t < 0.5 ? '#f00' : '#00f'; }
function tick(now){ paint((now - start) / 1000); requestAnimationFrame(tick); }
window.__seek = function(t){ start = performance.now() - t * 1000; paint(t); };
window.__ready = true;
requestAnimationFrame(tick);
</script></body></html>`);

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/render-video-seek.js'),
    html,
    '--duration=1',
    '--fps=2',
    '--width=160',
    '--height=90',
    '--concurrency=1',
    '--readytimeout=1',
  ], { cwd: repoRoot, encoding: 'utf8', timeout: 30000 });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(path.join(dir, 'bad-seek.mp4')), false, 'failed seek render should not leave an MP4');
  assert.match(result.stderr, /冻结时钟|__seekRenderReady/);
});

test('critical export safeguards stay wired', () => {
  const seek = fs.readFileSync(path.join(repoRoot, 'scripts/render-video-seek.js'), 'utf8');
  const record = fs.readFileSync(path.join(repoRoot, 'scripts/render-video.js'), 'utf8');
  const thumbs = fs.readFileSync(path.join(repoRoot, 'scripts/gen_deck_thumbs.mjs'), 'utf8');
  const stage = fs.readFileSync(path.join(repoRoot, 'assets/animations.jsx'), 'utf8');
  const narration = fs.readFileSync(path.join(repoRoot, 'assets/narration_stage.jsx'), 'utf8');

  assert.match(seek, /window\.__seekRenderReady === true/);
  assert.match(seek, /pngCount !== TOTAL_FRAMES/);
  assert.match(seek, /'-start_number', '0'/);
  assert.doesNotMatch(seek, /\.kicker|\.title/);
  assert.doesNotMatch(record, /\.kicker|\.title/);
  assert.match(thumbs, /ok !== files\.length/);
  assert.match(stage, /window\.__seekRenderReady = true/);
  assert.match(narration, /window\.__seekRenderReady = true/);
});
