import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const rootUrl = new URL('../', import.meta.url);
const read = (file) => readFileSync(new URL(file, rootUrl), 'utf8');

function writeDeck(manifest) {
  const dir = mkdtempSync(path.join(tmpdir(), 'deck-regression-'));
  const slidesDir = path.join(dir, 'slides');
  const thumbsDir = path.join(dir, 'thumbs');
  mkdirSync(slidesDir);
  mkdirSync(thumbsDir);
  writeFileSync(path.join(slidesDir, '01.html'), '<!doctype html><title>One</title><h1>One</h1>');
  writeFileSync(path.join(slidesDir, '02.html'), '<!doctype html><title>Two</title><h1>Two</h1>');
  writeFileSync(path.join(thumbsDir, '01.jpg'), '');
  writeFileSync(path.join(thumbsDir, '02.jpg'), '');

  const html = read('assets/deck_index.html').replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  const index = path.join(dir, 'index.html');
  writeFileSync(index, html);
  return { dir, index };
}

async function inspectDeck(manifest, query, waitFor) {
  const { dir, index } = writeDeck(manifest);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pageErrors = [];
  page.on('pageerror', err => pageErrors.push(err.message));
  try {
    await page.goto(pathToFileURL(index).href + query, { waitUntil: 'load' });
    await page.waitForFunction(waitFor, null, { timeout: 5000 });
    return await page.evaluate(() => ({
      hash: location.hash,
      mode: document.body.dataset.mode,
      overview: document.body.dataset.ov,
      gridIframes: document.querySelectorAll('#wall iframe').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      galleryImages: document.querySelectorAll('#ov-gallery img.thumb-img').length,
      errors: window.__errors || [],
    }));
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(pageErrors, []);
  }
}

test('deck gallery falls back to grid when thumbnails are incomplete', async () => {
  const state = await inspectDeck(
    [
      { file: 'slides/01.html', label: 'One' },
      { file: 'slides/02.html', label: 'Two' },
    ],
    '?ov=gallery',
    () => document.body.dataset.mode === 'overview' &&
      document.body.dataset.ov === 'grid' &&
      document.querySelectorAll('#wall iframe').length === 2,
  );

  assert.equal(state.overview, 'grid');
  assert.equal(state.galleryIframes, 0);
  assert.equal(state.galleryImages, 0);
});

test('deck gallery uses only image thumbnails when coverage is complete', async () => {
  const state = await inspectDeck(
    [
      { file: 'slides/01.html', thumb: 'thumbs/01.jpg', label: 'One' },
      { file: 'slides/02.html', thumb: 'thumbs/02.jpg', label: 'Two' },
    ],
    '?ov=gallery',
    () => document.body.dataset.mode === 'overview' &&
      document.body.dataset.ov === 'gallery' &&
      document.querySelectorAll('#ov-gallery img.thumb-img').length > 0,
  );

  assert.equal(state.overview, 'gallery');
  assert.equal(state.gridIframes, 0);
  assert.equal(state.galleryIframes, 0);
  assert.ok(state.galleryImages > 0);
});

test('opening deck overview without a hash does not rewrite the URL to slide 1', async () => {
  const state = await inspectDeck(
    [
      { file: 'slides/01.html', label: 'One' },
      { file: 'slides/02.html', label: 'Two' },
    ],
    '?ov=grid',
    () => document.body.dataset.mode === 'overview' &&
      document.querySelectorAll('#wall iframe').length === 2,
  );

  assert.equal(state.mode, 'overview');
  assert.equal(state.hash, '');
});

test('thumbnail generation removes stale output and exits non-zero on any failure', () => {
  const src = read('scripts/gen_deck_thumbs.mjs');
  assert.match(src, /let failed = 0;/);
  assert.match(src, /fs\.rmSync\(out, \{ force: true \}\);/);
  assert.match(src, /if \(failed\)[\s\S]*process\.exit\(1\);/);
});

test('editable PPTX export fails closed unless partial output is explicit', () => {
  const src = read('scripts/export_deck_pptx.mjs');
  assert.match(src, /allowPartial: false/);
  assert.match(src, /--allow-partial/);
  assert.match(src, /await fs\.rm\(outFile, \{ force: true \}\);/);
  assert.match(src, /if \(!allowPartial\)[\s\S]*process\.exit\(1\);/);
});

test('video chrome hiding does not hide common content class names', () => {
  for (const file of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const css = read(file).match(/const HIDE_CHROME_CSS = `([\s\S]*?)`/)?.[1] ?? '';
    for (const selector of ['.title', '.kicker', '.masthead', '.footer']) {
      assert.equal(css.includes(selector), false, `${file} should not hide ${selector}`);
    }
  }
});

test('seek renderer requires frozen-clock handshake and fails closed', () => {
  const src = read('scripts/render-video-seek.js');
  assert.match(src, /window\.__seekRenderReady === true/);
  assert.match(src, /page\.waitForFunction\([\s\S]*\n\s*null,\n\s*\{ timeout: READY_TIMEOUT \* 1000 \}/);
  assert.match(src, /Math\.max\(1, Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(src, /pngCount !== TOTAL_FRAMES/);
  assert.match(src, /'-start_number', '0'/);
  assert.match(src, /fs\.rmSync\(MP4_OUT, \{ force: true \}\);/);
});

test('Stage libraries expose seek readiness only in frozen seek mode', () => {
  for (const file of ['assets/animations.jsx', 'assets/narration_stage.jsx']) {
    const src = read(file);
    assert.match(src, /window\.__seekRender\)[\s\S]*window\.__seekRenderReady = true;/);
  }
});
