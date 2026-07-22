import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

test('deck gallery fails safe when thumbnails are incomplete', () => {
  const src = read('assets/deck_index.html');
  assert.match(src, /hasCompleteThumbs\s*=\s*deck\.length > 0 && deck\.every/);
  assert.match(src, /requestedOverview === 'gallery' && hasCompleteThumbs \? 'gallery' : 'grid'/);
  assert.match(src, /if \(!item\.thumb\) throw new Error\('Gallery overview requires complete thumb coverage\.'\)/);
  assert.match(src, /function clearOverview\(\)[\s\S]*wall\.innerHTML = '';[\s\S]*gallery\.innerHTML = '';/);
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
    const css = read(file).match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/)?.[1] ?? '';
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
