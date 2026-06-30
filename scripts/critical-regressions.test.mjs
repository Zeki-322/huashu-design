import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deckIndexPath = path.join(repoRoot, 'assets', 'deck_index.html');
const genThumbsPath = path.join(repoRoot, 'scripts', 'gen_deck_thumbs.mjs');

async function makeTempDeck(manifest) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-deck-'));
  const slidesDir = path.join(dir, 'slides');
  await fs.mkdir(slidesDir);
  for (const item of manifest) {
    const slidePath = path.join(dir, item.file);
    await fs.mkdir(path.dirname(slidePath), { recursive: true });
    await fs.writeFile(slidePath, '<!doctype html><html><body style="width:1920px;height:1080px">slide</body></html>');
  }
  const html = await fs.readFile(deckIndexPath, 'utf8');
  const patched = html.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  await fs.writeFile(path.join(dir, 'index.html'), patched);
  return dir;
}

test('deck_index forces grid when gallery is requested without complete thumbnails', async () => {
  const manifest = Array.from({ length: 12 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    label: `Slide ${i + 1}`,
  }));
  const dir = await makeTempDeck(manifest);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('file://' + path.join(dir, 'index.html') + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ov === 'grid');

    const state = await page.evaluate(() => ({
      overview: document.body.dataset.ov,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    }));
    assert.equal(state.overview, 'grid');
    assert.equal(state.galleryIframes, 0);
    assert.equal(state.gridIframes, manifest.length);
  } finally {
    await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('deck_index uses image-only gallery when every slide has a thumbnail', async () => {
  const manifest = Array.from({ length: 4 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    thumb: `thumbs/${String(i + 1).padStart(2, '0')}.jpg`,
    label: `Slide ${i + 1}`,
  }));
  const dir = await makeTempDeck(manifest);
  await fs.mkdir(path.join(dir, 'thumbs'));
  for (let i = 0; i < manifest.length; i++) {
    await fs.writeFile(path.join(dir, manifest[i].thumb), '');
  }

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('file://' + path.join(dir, 'index.html') + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ov === 'gallery' && document.querySelectorAll('#gallery .card').length > 0);

    const state = await page.evaluate(() => ({
      overview: document.body.dataset.ov,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      galleryImages: document.querySelectorAll('#ov-gallery img.thumb-img').length,
    }));
    assert.equal(state.overview, 'gallery');
    assert.equal(state.galleryIframes, 0);
    assert.ok(state.galleryImages >= manifest.length);
  } finally {
    await browser.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('gen_deck_thumbs exits non-zero instead of silently accepting failed thumbnails', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-thumbs-'));
  try {
    const slidesDir = path.join(dir, 'slides');
    const outDir = path.join(dir, 'thumbs');
    await fs.mkdir(slidesDir);
    await fs.writeFile(path.join(slidesDir, '01.html'), '<!doctype html><html><body>slide</body></html>');

    const result = spawnSync(process.execPath, [
      genThumbsPath,
      '--slides', slidesDir,
      '--out', outDir,
      '--width', '0',
    ], {
      cwd: repoRoot,
      encoding: 'utf8',
      timeout: 30000,
    });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /缩略图生成失败|Expected positive integer|Invalid/);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
