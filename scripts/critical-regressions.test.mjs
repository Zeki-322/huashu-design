import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function readRepoFile(relativePath) {
  return readFile(path.join(root, relativePath), 'utf8');
}

function extractChromeCss(source) {
  const match = source.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/);
  assert.ok(match, 'HIDE_CHROME_CSS template literal should exist');
  return match[1];
}

test('deck gallery without complete thumbs falls back to grid and clears overview iframes in present mode', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 960, height: 640 } });
    await page.goto('file://' + path.join(root, 'assets/deck_index.html') + '?ov=gallery');
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');

    const overviewState = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    }));
    assert.equal(overviewState.ov, 'grid');
    assert.equal(overviewState.galleryIframes, 0);
    assert.equal(overviewState.gridIframes, 1);

    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present');
    const presentState = await page.evaluate(() => ({
      wallIframes: document.querySelectorAll('#wall iframe').length,
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
      stageIframes: document.querySelectorAll('#stage iframe').length,
    }));
    assert.equal(presentState.wallIframes, 0);
    assert.equal(presentState.galleryIframes, 0);
    assert.equal(presentState.stageIframes, 1);
  } finally {
    await browser.close();
  }
});

test('video chrome hiding does not target common content class names', async () => {
  for (const relativePath of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const source = await readRepoFile(relativePath);
    const css = extractChromeCss(source);
    assert.doesNotMatch(css, /\.(masthead|kicker|title|footer)\b/);
    assert.match(css, /\.no-record/);
    assert.match(css, /\[data-record="hidden"\]/);
  }
});

test('seek renderer requires frozen-clock handshake and removes stale output on failure', async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), 'huashu-seek-regression-'));
  try {
    const htmlPath = path.join(tmp, 'bad-handshake.html');
    const mp4Path = path.join(tmp, 'bad-handshake.mp4');
    await writeFile(htmlPath, `<!doctype html>
<html><body><script>
window.__ready = true;
window.__seek = function () {};
</script></body></html>`);
    await writeFile(mp4Path, 'stale mp4');

    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts/render-video-seek.js'),
      htmlPath,
      '--duration=0.1',
      '--fps=1',
      '--width=64',
      '--height=64',
      '--readytimeout=0.25',
      '--concurrency=1',
    ], {
      cwd: root,
      encoding: 'utf8',
      timeout: 20000,
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stdout + result.stderr, /__seekRenderReady/);
    assert.equal(fs.existsSync(mp4Path), false);
    assert.equal(fs.readdirSync(tmp).some(name => name.startsWith('.seek-tmp-')), false);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});

test('seek renderer keeps exact-frame and cleanup safeguards', async () => {
  const seekSource = await readRepoFile('scripts/render-video-seek.js');
  assert.match(seekSource, /Math\.max\(1,\s*Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(seekSource, /window\.__seekRenderReady === true/);
  assert.match(seekSource, /pngCount !== TOTAL_FRAMES/);
  assert.match(seekSource, /'-start_number', '0'/);
  assert.match(seekSource, /cleanupPartial\(\)/);

  const animations = await readRepoFile('assets/animations.jsx');
  const narration = await readRepoFile('assets/narration_stage.jsx');
  assert.match(animations, /window\.__seekRenderReady = true/);
  assert.match(narration, /window\.__seekRenderReady = true/);
});

test('deck thumb and pptx exports fail closed instead of leaving stale partial outputs', async () => {
  const thumbs = await readRepoFile('scripts/gen_deck_thumbs.mjs');
  assert.match(thumbs, /const failures = \[\]/);
  assert.match(thumbs, /fs\.rmSync\(out, \{ force: true \}\)/);
  assert.match(thumbs, /process\.exit\(1\)/);

  const pptx = await readRepoFile('scripts/export_deck_pptx.mjs');
  assert.match(pptx, /allow-partial/);
  assert.match(pptx, /errors\.length === files\.length \|\| !allowPartial/);
  assert.match(pptx, /await removeOutput\(\)/);
  assert.match(pptx, /await pres\.writeFile/);
});
