import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function makeDeck({ slides = 18, withThumbs = false } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'huashu-deck-'));
  const slidesDir = path.join(dir, 'slides');
  await import('node:fs/promises').then(fs => fs.mkdir(slidesDir));

  const manifest = [];
  for (let i = 1; i <= slides; i++) {
    const name = String(i).padStart(2, '0') + '.html';
    await writeFile(
      path.join(slidesDir, name),
      `<!doctype html><html><body style="width:1920px;height:1080px;margin:0"><h1>Slide ${i}</h1></body></html>`,
    );
    manifest.push({
      file: 'slides/' + name,
      label: 'Slide ' + i,
      ...(withThumbs ? { thumb: 'thumbs/' + String(i).padStart(2, '0') + '.jpg' } : {}),
    });
  }

  const source = await readFile(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');
  const html = source.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    'window.DECK_MANIFEST = ' + JSON.stringify(manifest, null, 2) + ';',
  );
  await writeFile(path.join(dir, 'index.html'), html);
  return dir;
}

async function withPage(deckDir, query, fn) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.goto('file://' + path.join(deckDir, 'index.html') + query, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test('forced gallery without complete thumbnails falls back to grid without gallery iframes', async () => {
  const deckDir = await makeDeck({ slides: 24, withThumbs: false });
  try {
    const state = await withPage(deckDir, '?ov=gallery', page => page.evaluate(() => ({
      ov: document.body.dataset.ov,
      hash: location.hash,
      gridCards: document.querySelectorAll('#wall .card').length,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    })));

    assert.equal(state.ov, 'grid');
    assert.equal(state.hash, '');
    assert.equal(state.gridCards, 24);
    assert.equal(state.galleryCards, 0);
    assert.equal(state.galleryIframes, 0);
  } finally {
    await rm(deckDir, { recursive: true, force: true });
  }
});

test('gallery with complete thumbnails uses image cards only', async () => {
  const deckDir = await makeDeck({ slides: 12, withThumbs: true });
  try {
    const state = await withPage(deckDir, '?ov=gallery', page => page.evaluate(() => ({
      ov: document.body.dataset.ov,
      galleryCards: document.querySelectorAll('#gallery .card').length,
      galleryImages: document.querySelectorAll('#gallery img.thumb-img').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    })));

    assert.equal(state.ov, 'gallery');
    assert.ok(state.galleryCards > 12);
    assert.equal(state.galleryImages, state.galleryCards);
    assert.equal(state.galleryIframes, 0);
  } finally {
    await rm(deckDir, { recursive: true, force: true });
  }
});

test('entering present mode tears down overview cards', async () => {
  const deckDir = await makeDeck({ slides: 12, withThumbs: true });
  try {
    const state = await withPage(deckDir, '?ov=gallery', async page => {
      await page.click('#startBtn');
      await page.waitForFunction(() => document.body.dataset.mode === 'present');
      return page.evaluate(() => ({
        mode: document.body.dataset.mode,
        wallCards: document.querySelectorAll('#wall .card').length,
        galleryCards: document.querySelectorAll('#gallery .card').length,
        stageSrc: document.querySelector('#frame').getAttribute('src'),
      }));
    });

    assert.equal(state.mode, 'present');
    assert.equal(state.wallCards, 0);
    assert.equal(state.galleryCards, 0);
    assert.equal(state.stageSrc, 'slides/01.html');
  } finally {
    await rm(deckDir, { recursive: true, force: true });
  }
});
