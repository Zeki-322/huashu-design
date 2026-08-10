import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-critical-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function withBrowser(fn) {
  const browser = await chromium.launch();
  try {
    return await fn(browser);
  } finally {
    await browser.close();
  }
}

test('deck overview falls back to grid when gallery is forced without thumbs', async () => {
  await withBrowser(async (browser) => {
    const page = await browser.newPage();
    await page.goto(pathToFileURL(path.join(root, 'assets/deck_index.html')).href + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview' && document.querySelectorAll('#wall .card').length === window.DECK_MANIFEST.length);

    const state = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      overview: document.body.dataset.ov,
      hash: location.hash,
      gridCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    }));

    assert.deepEqual(state, {
      mode: 'overview',
      overview: 'grid',
      hash: '',
      gridCards: 1,
      galleryCards: 0,
      galleryIframes: 0,
    });
  });
});

test('deck gallery uses image thumbnails only when every manifest item has a thumb', async () => {
  await withTempDir(async (dir) => {
    const slidesDir = path.join(dir, 'slides');
    const thumbsDir = path.join(dir, 'thumbs');
    await fs.mkdir(slidesDir);
    await fs.mkdir(thumbsDir);
    await fs.writeFile(path.join(slidesDir, '01.html'), '<!doctype html><title>one</title>');
    await fs.writeFile(path.join(slidesDir, '02.html'), '<!doctype html><title>two</title>');
    await fs.writeFile(path.join(thumbsDir, '01.jpg'), '');
    await fs.writeFile(path.join(thumbsDir, '02.jpg'), '');

    const source = await fs.readFile(path.join(root, 'assets/deck_index.html'), 'utf8');
    const index = source.replace(
      /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
      `window.DECK_MANIFEST = [
    { file: "slides/01.html", label: "One", thumb: "thumbs/01.jpg" },
    { file: "slides/02.html", label: "Two", thumb: "thumbs/02.jpg" },
  ];`
    );
    await fs.writeFile(path.join(dir, 'index.html'), index);

    await withBrowser(async (browser) => {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?ov=gallery', { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.ov === 'gallery' && document.querySelectorAll('#gallery .card').length > window.DECK_MANIFEST.length);

      const state = await page.evaluate(() => ({
        overview: document.body.dataset.ov,
        galleryCards: document.querySelectorAll('#gallery .card').length,
        galleryImages: document.querySelectorAll('#gallery img.thumb-img').length,
        galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      }));

      assert.equal(state.overview, 'gallery');
      assert.equal(state.galleryCards, state.galleryImages);
      assert.equal(state.galleryIframes, 0);
    });
  });
});

test('gen_deck_thumbs exits non-zero for invalid dimensions', async () => {
  await withTempDir(async (dir) => {
    const slidesDir = path.join(dir, 'slides');
    const outDir = path.join(dir, 'thumbs');
    await fs.mkdir(slidesDir);
    await fs.writeFile(path.join(slidesDir, '01.html'), '<!doctype html><title>slide</title>');

    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts/gen_deck_thumbs.mjs'),
      '--slides', slidesDir,
      '--out', outDir,
      '--width', '0',
    ], { cwd: root, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /--width/);
  });
});

test('export_deck_pptx fails closed and removes stale output on partial slide failure', async () => {
  await withTempDir(async (dir) => {
    const slidesDir = path.join(dir, 'slides');
    const outFile = path.join(dir, 'deck.pptx');
    await fs.mkdir(slidesDir);
    await fs.writeFile(path.join(outFile), 'stale pptx');
    await fs.writeFile(path.join(slidesDir, '01-valid.html'), `<!doctype html>
<html><head><style>
html,body{margin:0;width:1280px;height:720px;font-family:Arial,sans-serif;}
p{position:absolute;left:120px;top:120px;width:600px;height:80px;font-size:36px;color:#111;}
</style></head><body><p>Valid slide</p></body></html>`);
    await fs.writeFile(path.join(slidesDir, '02-invalid.html'), `<!doctype html>
<html><head><style>
html,body{margin:0;width:1280px;height:720px;font-family:Arial,sans-serif;}
p{position:absolute;left:120px;top:120px;width:600px;height:80px;font-size:36px;border:2px solid red;}
</style></head><body><p>Invalid slide</p></body></html>`);

    const result = spawnSync(process.execPath, [
      path.join(root, 'scripts/export_deck_pptx.mjs'),
      '--slides', slidesDir,
      '--out', outFile,
    ], { cwd: root, encoding: 'utf8', timeout: 60000 });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /未生成 PPTX/);
    await assert.rejects(fs.access(outFile));
  });
});
