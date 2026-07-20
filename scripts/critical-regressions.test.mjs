import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DECK_INDEX = path.join(ROOT, 'assets', 'deck_index.html');
const SOURCE_HTML = await readFile(DECK_INDEX, 'utf8');

let browser;

before(async () => {
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
});

async function makeDeck(manifest) {
  const dir = await mkdtemp(path.join(tmpdir(), 'deck-index-'));
  await mkdir(path.join(dir, 'slides'), { recursive: true });
  await mkdir(path.join(dir, 'thumbs'), { recursive: true });

  for (let i = 1; i <= manifest.length; i++) {
    const n = String(i).padStart(2, '0');
    await writeFile(
      path.join(dir, 'slides', `${n}.html`),
      `<!doctype html><meta charset="utf-8"><title>Slide ${n}</title><h1>Slide ${n}</h1>`
    );
    await writeFile(path.join(dir, 'thumbs', `${n}.jpg`), 'fake-thumb');
  }

  const html = SOURCE_HTML.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`
  );
  await writeFile(path.join(dir, 'index.html'), html);
  return { dir, url: pathToFileURL(path.join(dir, 'index.html')).href };
}

test('gallery overview without complete thumbs falls back to grid and does not create gallery iframes', async () => {
  const fixture = await makeDeck([
    { file: 'slides/01.html', label: 'One' },
    { file: 'slides/02.html', label: 'Two' },
    { file: 'slides/03.html', label: 'Three' },
    { file: 'slides/04.html', label: 'Four' },
  ]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(`${fixture.url}?ov=gallery`);
    await page.waitForFunction(() => document.body.dataset.mode === 'overview' && document.body.dataset.ov === 'grid');

    const state = await page.evaluate(() => ({
      mode: document.body.dataset.mode,
      overview: document.body.dataset.ov,
      hash: location.hash,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    }));

    assert.deepEqual(state, {
      mode: 'overview',
      overview: 'grid',
      hash: '',
      galleryIframes: 0,
      gridIframes: 4,
    });
  } finally {
    await page.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('gallery overview with complete thumbs uses images instead of iframes', async () => {
  const fixture = await makeDeck([
    { file: 'slides/01.html', label: 'One', thumb: 'thumbs/01.jpg' },
    { file: 'slides/02.html', label: 'Two', thumb: 'thumbs/02.jpg' },
    { file: 'slides/03.html', label: 'Three', thumb: 'thumbs/03.jpg' },
  ]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(`${fixture.url}?ov=gallery`);
    await page.waitForFunction(() => document.body.dataset.mode === 'overview' && document.body.dataset.ov === 'gallery');

    const state = await page.evaluate(() => ({
      overview: document.body.dataset.ov,
      galleryImages: document.querySelectorAll('#ov-gallery img.thumb-img').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    }));

    assert.equal(state.overview, 'gallery');
    assert.ok(state.galleryImages > 0);
    assert.equal(state.galleryIframes, 0);
    assert.equal(state.gridIframes, 0);
  } finally {
    await page.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});

test('initial overview load without hash does not write a slide hash', async () => {
  const fixture = await makeDeck([
    { file: 'slides/01.html', label: 'One' },
    { file: 'slides/02.html', label: 'Two' },
  ]);
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(`${fixture.url}?ov=grid`);
    await page.waitForFunction(() => document.body.dataset.mode === 'overview' && document.querySelectorAll('#ov-grid iframe').length === 2);

    assert.equal(await page.evaluate(() => location.hash), '');
  } finally {
    await page.close();
    await rm(fixture.dir, { recursive: true, force: true });
  }
});
