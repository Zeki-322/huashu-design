import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';

const repoRoot = path.resolve(new URL('../', import.meta.url).pathname);
const deckIndexPath = path.join(repoRoot, 'assets', 'deck_index.html');
const genThumbsPath = path.join(repoRoot, 'scripts', 'gen_deck_thumbs.mjs');

async function withTempDir(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-critical-'));
  try {
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function writeDeck(tempDir, manifest) {
  const slidesDir = path.join(tempDir, 'slides');
  await fs.mkdir(slidesDir, { recursive: true });
  for (const item of manifest) {
    await fs.writeFile(
      path.join(tempDir, item.file),
      '<!doctype html><html><body><h1>' + item.label + '</h1></body></html>',
      'utf8',
    );
  }

  const source = await fs.readFile(deckIndexPath, 'utf8');
  const html = source.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    'window.DECK_MANIFEST = ' + JSON.stringify(manifest, null, 2) + ';',
  );
  await fs.writeFile(path.join(tempDir, 'index.html'), html, 'utf8');
  return path.join(tempDir, 'index.html');
}

async function readOverviewState(indexPath) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  try {
    await page.goto('file://' + indexPath + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#wall .card, #gallery .card').length > 0);
    return await page.evaluate(() => ({
      overview: document.body.getAttribute('data-ov'),
      gridCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
    }));
  } finally {
    await browser.close();
  }
}

test('deck_index forces grid when gallery thumbs are incomplete', async () => {
  await withTempDir(async tempDir => {
    const indexPath = await writeDeck(tempDir, [
      { file: 'slides/01.html', label: 'One', thumb: 'thumbs/01.jpg' },
      { file: 'slides/02.html', label: 'Two' },
      { file: 'slides/03.html', label: 'Three', thumb: 'thumbs/03.jpg' },
    ]);

    const state = await readOverviewState(indexPath);
    assert.equal(state.overview, 'grid');
    assert.equal(state.gridCards, 3);
    assert.equal(state.galleryCards, 0);
    assert.equal(state.galleryIframes, 0);
  });
});

test('deck_index uses image-only gallery when every slide has a thumb', async () => {
  await withTempDir(async tempDir => {
    const indexPath = await writeDeck(tempDir, [
      { file: 'slides/01.html', label: 'One', thumb: 'thumbs/01.jpg' },
      { file: 'slides/02.html', label: 'Two', thumb: 'thumbs/02.jpg' },
      { file: 'slides/03.html', label: 'Three', thumb: 'thumbs/03.jpg' },
    ]);

    const state = await readOverviewState(indexPath);
    assert.equal(state.overview, 'gallery');
    assert.equal(state.gridCards, 0);
    assert.ok(state.galleryCards >= 3);
    assert.equal(state.galleryIframes, 0);
  });
});

test('gen_deck_thumbs exits non-zero when any thumbnail fails', async () => {
  await withTempDir(async tempDir => {
    const slidesDir = path.join(tempDir, 'slides');
    const outDir = path.join(tempDir, 'thumbs');
    await fs.mkdir(slidesDir, { recursive: true });
    await fs.writeFile(path.join(slidesDir, '01.html'), '<!doctype html><html><body>slide</body></html>', 'utf8');

    const result = spawnSync(process.execPath, [
      genThumbsPath,
      '--slides', slidesDir,
      '--out', outDir,
      '--canvas-w', '160',
      '--canvas-h', '90',
      '--width', '0',
    ], { cwd: repoRoot, encoding: 'utf8' });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /\[FAIL\] 01\.html/);
    assert.match(result.stderr, /缩略图生成失败/);
  });
});
