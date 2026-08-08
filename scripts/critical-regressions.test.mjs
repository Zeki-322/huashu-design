import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function chromeCssFrom(source) {
  const match = source.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/);
  assert.ok(match, 'HIDE_CHROME_CSS block should exist');
  return match[1];
}

test('deck overview forced gallery fails safe without complete thumbnails', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-overview-'));
  const slidesDir = path.join(tmp, 'slides');
  fs.mkdirSync(slidesDir);
  fs.writeFileSync(path.join(slidesDir, '01.html'), '<!doctype html><html><body>one</body></html>');
  fs.writeFileSync(path.join(slidesDir, '02.html'), '<!doctype html><html><body>two</body></html>');

  const indexPath = path.join(tmp, 'index.html');
  const deckIndex = read('assets/deck_index.html').replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = [
      { file: "slides/01.html", label: "One" },
      { file: "slides/02.html", label: "Two" },
    ];`,
  );
  fs.writeFileSync(indexPath, deckIndex);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto('file://' + indexPath + '?ov=gallery');
    await page.waitForFunction(() => document.body.dataset.mode === 'overview' && document.body.dataset.ov === 'grid');
    await page.waitForFunction(() => document.querySelectorAll('#wall .card').length === 2);

    const overviewState = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      mode: document.body.dataset.mode,
      hash: location.hash,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    }));
    assert.deepEqual(overviewState, {
      ov: 'grid',
      mode: 'overview',
      hash: '',
      galleryCards: 0,
      galleryIframes: 0,
      gridIframes: 2,
    });

    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present');
    const presentState = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      hash: location.hash,
      overviewIframes: document.querySelectorAll('#ov-grid iframe, #ov-gallery iframe').length,
    }));
    assert.deepEqual(presentState, {
      mode: 'present',
      hash: '#1',
      overviewIframes: 0,
    });
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('video renderers do not hide common content class names', () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const source = read(rel);
    const css = chromeCssFrom(source);
    for (const selector of ['.title', '.kicker', '.masthead', '.footer']) {
      assert.equal(css.includes(selector), false, `${rel} should not hide ${selector}`);
    }
    assert.match(css, /\[data-record="hidden"\]/, `${rel} should keep explicit hide escape hatch`);
    assert.match(source, /page\.waitForFunction\([\s\S]*?null,\s*\{\s*timeout:/, `${rel} should pass Playwright timeout as options`);
  }
});

test('seek renderer fails closed on unsupported or incomplete deterministic capture', () => {
  const source = read('scripts/render-video-seek.js');
  assert.match(source, /window\.__seekRenderReady === true/, 'seek renderer must require frozen-clock readiness');
  assert.match(source, /Math\.max\(1,\s*Math\.ceil\(FPS \* DURATION\)\)/, 'frame count should be positive and rounded up');
  assert.match(source, /pngCount !== TOTAL_FRAMES/, 'captured frame count must be exact');
  assert.match(source, /'-start_number',\s*'0'/, 'ffmpeg image sequence should start at frame 0');
  assert.match(source, /fs\.rmSync\(MP4_OUT,\s*\{\s*force:\s*true\s*\}\)/, 'stale MP4 must be removed on failure');
});

test('deck export scripts remove stale outputs and reject partial failures by default', () => {
  const thumbs = read('scripts/gen_deck_thumbs.mjs');
  assert.match(thumbs, /let failed = 0;/, 'thumbnail export should track failures');
  assert.match(thumbs, /fs\.rmSync\(out,\s*\{\s*force:\s*true\s*\}\);/, 'stale per-slide thumbnails should be removed');
  assert.match(thumbs, /process\.exit\(1\);/, 'thumbnail export should exit non-zero on failures');

  const pptx = read('scripts/export_deck_pptx.mjs');
  assert.match(pptx, /allow-partial/, 'PPTX partial export must require an explicit flag');
  assert.match(pptx, /await fs\.rm\(outFile,\s*\{\s*force:\s*true\s*\}\);/, 'stale PPTX should be removed before conversion');
  assert.match(pptx, /避免交付缺页 PPTX/, 'default partial failures should be rejected');
});

test('audio and narration helpers keep export output audible and locally reproducible', () => {
  const mix = read('scripts/mix-voiceover.sh');
  assert.match(mix, /asplit=2\[voice_mix\]\[voice_side\]/, 'voice stream should be split for sidechain and final mix');
  assert.equal(mix.includes('afade=t=out:st=0'), false, 'ducked output must not fade out at t=0');

  const narration = read('scripts/render-narration.sh');
  assert.match(narration, /LOCAL_NODE_PATH="\$\(cd "\$SKILL_ROOT" && npm root\)"/, 'wrapper should use local node_modules');
  assert.match(narration, /if \[ -n "\$KEEP_SILENT" \]; then/, 'successful default export should not end with a failing test');
});

test('image fetcher never overwrites files after filename truncation', () => {
  const source = read('scripts/fetch_images.py');
  assert.match(source, /def _unique_path\(directory, filename\):/, 'fetcher should generate unique output paths');
  assert.match(source, /while os\.path\.exists\(candidate\):/, 'fetcher should avoid overwriting existing files');
  assert.match(source, /path = _unique_path\(out, fn\)/, 'downloads should use de-duplicated filenames');
});
