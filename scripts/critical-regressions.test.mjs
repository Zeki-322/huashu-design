import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deckIndex = fs.readFileSync(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');

function createDeck({ slides = 12, withThumbs = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-index-regression-'));
  fs.mkdirSync(path.join(dir, 'slides'));
  if (withThumbs) fs.mkdirSync(path.join(dir, 'thumbs'));

  const entries = [];
  for (let i = 1; i <= slides; i++) {
    const id = String(i).padStart(2, '0');
    fs.writeFileSync(
      path.join(dir, 'slides', `${id}.html`),
      `<!doctype html><html><body><h1>Slide ${i}</h1></body></html>`,
    );
    if (withThumbs) {
      fs.writeFileSync(
        path.join(dir, 'thumbs', `${id}.svg`),
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 160 90"><text x="20" y="50">Slide ${i}</text></svg>`,
      );
    }
    entries.push(
      `{ file: "slides/${id}.html", label: "Slide ${i}"${withThumbs ? `, thumb: "thumbs/${id}.svg"` : ''} }`,
    );
  }

  const html = deckIndex.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = [\n    ${entries.join(',\n    ')}\n  ];`,
  );
  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}

async function openDeck(dir) {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?ov=gallery', { waitUntil: 'load' });
  return { browser, page };
}

test('deck_index falls back to grid when gallery thumbnails are missing', async () => {
  const slideCount = 12;
  const dir = createDeck({ slides: slideCount, withThumbs: false });
  const warnings = [];
  let browser;

  try {
    const opened = await openDeck(dir);
    browser = opened.browser;
    const { page } = opened;
    page.on('console', msg => {
      if (msg.type() === 'warning') warnings.push(msg.text());
    });

    await page.waitForFunction(n => document.querySelectorAll('#ov-grid iframe').length === n, slideCount);
    const stats = await page.evaluate(() => ({
      ov: document.body.getAttribute('data-ov'),
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
      totalIframes: document.querySelectorAll('iframe').length,
    }));

    assert.equal(stats.ov, 'grid');
    assert.equal(stats.galleryIframes, 0);
    assert.equal(stats.gridIframes, slideCount);
    assert.equal(stats.totalIframes, slideCount + 1);
    assert.ok(
      warnings.some(text => text.includes('gallery overview requires thumb')),
      'missing thumbnails should emit a fallback warning',
    );
  } finally {
    if (browser) await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deck_index keeps gallery mode when every slide has a thumbnail', async () => {
  const dir = createDeck({ slides: 12, withThumbs: true });
  let browser;

  try {
    const opened = await openDeck(dir);
    browser = opened.browser;
    const { page } = opened;

    await page.waitForFunction(() => document.querySelectorAll('#ov-gallery img.thumb-img').length > 0);
    const stats = await page.evaluate(() => ({
      ov: document.body.getAttribute('data-ov'),
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
      galleryImages: document.querySelectorAll('#ov-gallery img.thumb-img').length,
      totalIframes: document.querySelectorAll('iframe').length,
    }));

    assert.equal(stats.ov, 'gallery');
    assert.equal(stats.galleryIframes, 0);
    assert.equal(stats.gridIframes, 0);
    assert.ok(stats.galleryImages > 0);
    assert.equal(stats.totalIframes, 1);
  } finally {
    if (browser) await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
