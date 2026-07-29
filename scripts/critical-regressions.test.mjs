import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const root = path.resolve(new URL('..', import.meta.url).pathname, '..');
const deckIndexPath = path.join(root, 'assets', 'deck_index.html');
const genThumbsPath = path.join(root, 'scripts', 'gen_deck_thumbs.mjs');
const fetchImagesPath = path.join(root, 'scripts', 'fetch_images.py');

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
}

function writeDeck(dir, manifest) {
  const slidesDir = path.join(dir, 'slides');
  fs.mkdirSync(slidesDir, { recursive: true });
  for (const item of manifest) {
    const slidePath = path.join(dir, item.file);
    fs.mkdirSync(path.dirname(slidePath), { recursive: true });
    fs.writeFileSync(slidePath, '<!doctype html><html><body><h1>Slide</h1></body></html>');
  }

  const html = fs.readFileSync(deckIndexPath, 'utf8').replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return path.join(dir, 'index.html');
}

test('deck gallery falls back to grid when any manifest thumb is missing', async () => {
  const dir = tempDir('deck-gallery-missing-thumbs');
  const manifest = Array.from({ length: 24 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    label: `Slide ${i + 1}`,
  }));
  const indexPath = writeDeck(dir, manifest);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${pathToFileURL(indexPath).href}?ov=gallery`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction((n) => document.querySelectorAll('#wall .card').length === n, manifest.length);
    const state = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      mode: document.body.dataset.mode,
      hash: location.hash,
      gridCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    }));
    assert.deepEqual(state, {
      ov: 'grid',
      mode: 'overview',
      hash: '',
      gridCards: 24,
      galleryCards: 0,
      galleryIframes: 0,
    });
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deck gallery uses only image cards when every manifest item has a thumb', async () => {
  const dir = tempDir('deck-gallery-complete-thumbs');
  const manifest = Array.from({ length: 4 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    thumb: `thumbs/${String(i + 1).padStart(2, '0')}.jpg`,
    label: `Slide ${i + 1}`,
  }));
  const indexPath = writeDeck(dir, manifest);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${pathToFileURL(indexPath).href}?ov=gallery`, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.querySelectorAll('#gallery .card').length > 0);
    const state = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      mode: document.body.dataset.mode,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryImages: document.querySelectorAll('#gallery img.thumb-img').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    }));
    assert.equal(state.ov, 'gallery');
    assert.equal(state.mode, 'overview');
    assert.ok(state.galleryCards > manifest.length);
    assert.equal(state.galleryImages, state.galleryCards);
    assert.equal(state.galleryIframes, 0);
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gen_deck_thumbs exits non-zero and removes stale thumb on per-slide failure', () => {
  const dir = tempDir('deck-thumbs-failure');
  const slidesDir = path.join(dir, 'slides');
  const outDir = path.join(dir, 'thumbs');
  fs.mkdirSync(slidesDir, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(slidesDir, '01.html'), '<!doctype html><html><body>slide</body></html>');
  fs.writeFileSync(path.join(outDir, '01.jpg'), 'stale');

  const result = spawnSync(process.execPath, [
    genThumbsPath,
    '--slides', slidesDir,
    '--out', outDir,
    '--width', '0',
  ], { encoding: 'utf8', timeout: 30_000 });

  try {
    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(outDir, '01.jpg')), false);
    assert.match(result.stderr, /缩略图生成不完整|Expected positive integer/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('fetch_images allocates suffixes instead of overwriting colliding filenames', () => {
  const dir = tempDir('fetch-images-unique');
  fs.writeFileSync(path.join(dir, 'image.jpg'), 'first');
  fs.writeFileSync(path.join(dir, 'image_2.jpg'), 'second');

  const code = `
import importlib.util
import pathlib
spec = importlib.util.spec_from_file_location("fetch_images", ${JSON.stringify(fetchImagesPath)})
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
print(pathlib.Path(mod._unique_path(${JSON.stringify(dir)}, "image.jpg")).name)
`;
  const result = spawnSync('python3', ['-c', code], { encoding: 'utf8', timeout: 10_000 });

  try {
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), 'image_3.jpg');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
