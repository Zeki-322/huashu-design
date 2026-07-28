import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

test('deck gallery without complete thumbnails falls back to grid', async () => {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const url = pathToFileURL(path.join(ROOT, 'assets/deck_index.html')).href + '?ov=gallery';
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    const state = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      hash: location.hash,
      galleryCards: document.querySelectorAll('#ov-gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    }));
    assert.deepEqual(state, {
      ov: 'grid',
      hash: '',
      galleryCards: 0,
      galleryIframes: 0,
      gridIframes: 1,
    });
  } finally {
    await browser.close();
  }
});

test('video chrome hiding does not target generic content class names', () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const src = read(rel);
    assert.doesNotMatch(src, /\.masthead\b/);
    assert.doesNotMatch(src, /\.kicker\b/);
    assert.doesNotMatch(src, /\.title\b/);
    assert.doesNotMatch(src, /\.footer\b/);
  }
});

test('seek renderer fails closed on non-frozen handshakes and incomplete frames', () => {
  const src = read('scripts/render-video-seek.js');
  assert.match(src, /window\.__seekRenderReady\s*===\s*true/);
  assert.match(src, /Math\.max\(1,\s*Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(src, /pngCount !== TOTAL_FRAMES/);
  assert.match(src, /'-start_number', '0'/);
  assert.match(src, /fs\.rmSync\(MP4_OUT,\s*\{\s*force:\s*true\s*\}\)/);
});

test('Stage libraries only mark seek readiness inside frozen seek mode', () => {
  for (const rel of ['assets/animations.jsx', 'assets/narration_stage.jsx']) {
    const src = read(rel);
    assert.match(src, /window\.__seekRenderReady\s*=\s*true/);
    assert.match(src, /window\.__seekRender/);
  }
});

test('thumbnail generation exits non-zero and removes stale thumb on failure', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huashu-thumbs-'));
  const slides = path.join(tmp, 'slides');
  const thumbs = path.join(tmp, 'thumbs');
  fs.mkdirSync(slides);
  fs.mkdirSync(thumbs);
  fs.writeFileSync(path.join(slides, '01.html'), '<!doctype html><body style="width:64px;height:36px"></body>');
  const stale = path.join(thumbs, '01.jpg');
  fs.writeFileSync(stale, 'stale');

  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/gen_deck_thumbs.mjs'),
    '--slides', slides,
    '--out', thumbs,
    '--width', '0',
    '--canvas-w', '64',
    '--canvas-h', '36',
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
    timeout: 30000,
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(stale), false);
});

test('PPTX export removes stale output and fails without explicit partial mode', () => {
  const src = read('scripts/export_deck_pptx.mjs');
  assert.match(src, /allow-partial/);
  assert.match(src, /!allowPartial \|\| errors\.length === files\.length/);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huashu-pptx-'));
  const slides = path.join(tmp, 'slides');
  fs.mkdirSync(slides);
  const stale = path.join(tmp, 'deck.pptx');
  fs.writeFileSync(stale, 'stale');

  const result = spawnSync(process.execPath, [
    path.join(ROOT, 'scripts/export_deck_pptx.mjs'),
    '--slides', slides,
    '--out', stale,
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
    timeout: 30000,
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(stale), false);
});

test('voiceover ducking splits voice stream and does not fade at zero seconds', () => {
  const src = read('scripts/mix-voiceover.sh');
  assert.match(src, /asplit=2\[voice_mix\]\[voice_sc\]/);
  assert.doesNotMatch(src, /afade=t=out:st=0/);
});

test('image fetcher avoids silent overwrites for duplicate output names', () => {
  const src = read('scripts/fetch_images.py');
  assert.match(src, /def _unique_path/);
  assert.match(src, /os\.path\.exists\(candidate\)/);
  assert.match(src, /f"\{stem\}_\{suffix\}\{ext\}"/);
});
