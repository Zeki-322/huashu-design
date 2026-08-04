import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempDir(prefix, fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    return await fn(dir);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

test('deck_index forced gallery falls back to grid when thumbs are incomplete', async () => {
  await withTempDir('deck-index-regression-', async dir => {
    const slidesDir = path.join(dir, 'slides');
    await fsp.mkdir(slidesDir, { recursive: true });
    const slide = '<!doctype html><meta charset="utf-8"><body style="margin:0;width:1920px;height:1080px;background:white"><h1>Slide</h1></body>';
    await fsp.writeFile(path.join(slidesDir, '01.html'), slide);
    await fsp.writeFile(path.join(slidesDir, '02.html'), slide);

    const src = await fsp.readFile(path.join(ROOT, 'assets/deck_index.html'), 'utf8');
    const manifest = `window.DECK_MANIFEST = [
    { file: "slides/01.html", label: "One" },
    { file: "slides/02.html", label: "Two" },
  ];`;
    await fsp.writeFile(
      path.join(dir, 'index.html'),
      src.replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, manifest),
    );

    const browser = await chromium.launch();
    try {
      const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
      await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?ov=gallery');
      await page.waitForFunction(() => document.body.dataset.mode === 'overview');
      await page.waitForFunction(() => document.querySelectorAll('#ov-grid iframe').length === 2);

      const overview = await page.evaluate(() => ({
        ov: document.body.dataset.ov,
        hash: location.hash,
        galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
        gridIframes: document.querySelectorAll('#ov-grid iframe').length,
      }));
      assert.deepEqual(overview, { ov: 'grid', hash: '', galleryIframes: 0, gridIframes: 2 });

      await page.click('#startBtn');
      await page.waitForFunction(() => document.body.dataset.mode === 'present');
      const present = await page.evaluate(() => ({
        hash: location.hash,
        overviewIframes: document.querySelectorAll('#ov-grid iframe, #ov-gallery iframe').length,
      }));
      assert.deepEqual(present, { hash: '#1', overviewIframes: 0 });
    } finally {
      await browser.close();
    }
  });
});

test('seek renderer fails closed unless the frozen-clock handshake is present', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'scripts/render-video-seek.js'), 'utf8');
  assert.match(src, /window\.__seekRenderReady === true/);
  assert.match(src, /page\.waitForFunction\([\s\S]*?\n\s*null,\n\s*\{ timeout: READY_TIMEOUT \* 1000 \}/);
  assert.match(src, /Math\.max\(1, Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(src, /'-start_number', '0'/);
  assert.match(src, /fs\.rmSync\(MP4_OUT, \{ force: true \}\)/);
});

test('video chrome hiding does not hide common content selectors', async () => {
  const regular = await fsp.readFile(path.join(ROOT, 'scripts/render-video.js'), 'utf8');
  const seek = await fsp.readFile(path.join(ROOT, 'scripts/render-video-seek.js'), 'utf8');
  for (const src of [regular, seek]) {
    assert.doesNotMatch(src, /\.masthead,\s*\.kicker,\s*\.title/);
    assert.doesNotMatch(src, /\.footer,\s*\n\s*\[data-role="chrome"\]/);
    assert.match(src, /\[data-role="chrome"\], \[data-record="hidden"\]/);
  }
});

test('gen_deck_thumbs removes stale thumbnail and exits non-zero on page failure', async () => {
  await withTempDir('thumb-fail-regression-', async dir => {
    const slidesDir = path.join(dir, 'slides');
    const thumbsDir = path.join(dir, 'thumbs');
    await fsp.mkdir(slidesDir, { recursive: true });
    await fsp.mkdir(thumbsDir, { recursive: true });
    await fsp.writeFile(
      path.join(slidesDir, '01.html'),
      '<!doctype html><meta charset="utf-8"><body style="margin:0;width:1920px;height:1080px;background:#fff">ok</body>',
    );
    const stale = path.join(thumbsDir, '01.jpg');
    await fsp.writeFile(stale, 'stale');

    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/gen_deck_thumbs.mjs'),
      '--slides', slidesDir,
      '--out', thumbsDir,
      '--width', '0',
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(stale), false);
  });
});

test('export_deck_pptx removes stale output and exits non-zero on conversion failure', async () => {
  await withTempDir('pptx-fail-regression-', async dir => {
    const slidesDir = path.join(dir, 'slides');
    await fsp.mkdir(slidesDir, { recursive: true });
    await fsp.writeFile(
      path.join(slidesDir, '01-bad.html'),
      '<!doctype html><meta charset="utf-8"><body style="margin:0;width:960px;height:540px"><div>unwrapped text fails validation</div></body>',
    );
    const out = path.join(dir, 'deck.pptx');
    await fsp.writeFile(out, 'stale');

    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/export_deck_pptx.mjs'),
      '--slides', slidesDir,
      '--out', out,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(out), false);
  });
});

test('fetch_images allocates unique paths before writing downloads', async () => {
  const src = await fsp.readFile(path.join(ROOT, 'scripts/fetch_images.py'), 'utf8');
  assert.match(src, /def _unique_path/);
  assert.match(src, /key not in used_paths and not os\.path\.exists\(path\)/);
  assert.match(src, /used_paths\.add\(key\)/);
});
