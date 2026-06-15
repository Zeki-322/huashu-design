#!/usr/bin/env node
import assert from 'assert/strict';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const templatePath = path.join(root, 'assets', 'deck_index.html');

function manifestSource(count, withThumbs) {
  return Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    const thumb = withThumbs ? `, thumb: "thumbs/${n}.jpg"` : '';
    return `    { file: "about:blank", label: "S${n}"${thumb} }`;
  }).join(',\n');
}

async function renderDeck(page, { count, withThumbs, overview = 'gallery' }) {
  const raw = await fs.readFile(templatePath, 'utf8');
  const html = raw
    .replace(
      /window\.DECK_MANIFEST = \[[\s\S]*?\n  \];/,
      `window.DECK_MANIFEST = [\n${manifestSource(count, withThumbs)}\n  ];`,
    )
    .replace(
      "// window.DECK_OVERVIEW = 'grid';",
      `window.DECK_OVERVIEW = '${overview}';`,
    );

  await page.setContent(html, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#gallery .card, #wall .card').length > 0);

  return page.evaluate(() => ({
    ov: document.body.getAttribute('data-ov'),
    galleryCards: document.querySelectorAll('#gallery .card').length,
    galleryIframes: document.querySelectorAll('#gallery iframe').length,
    galleryImgs: document.querySelectorAll('#gallery img').length,
    gridCards: document.querySelectorAll('#wall .card').length,
    gridIframes: document.querySelectorAll('#wall iframe').length,
  }));
}

const browser = await chromium.launch();
try {
  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const stats = await renderDeck(page, { count: 20, withThumbs: false });

    assert.equal(stats.ov, 'grid');
    assert.equal(stats.galleryCards, 0);
    assert.equal(stats.galleryIframes, 0);
    assert.equal(stats.galleryImgs, 0);
    assert.equal(stats.gridCards, 20);
    assert.equal(stats.gridIframes, 20);

    await page.close();
    console.log('[ok] gallery request without full thumbs falls back to grid');
  }

  {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const stats = await renderDeck(page, { count: 20, withThumbs: true });

    assert.equal(stats.ov, 'gallery');
    assert.ok(stats.galleryCards > 20);
    assert.equal(stats.galleryIframes, 0);
    assert.equal(stats.gridCards, 0);
    assert.equal(stats.gridIframes, 0);
    assert.equal(stats.galleryImgs, stats.galleryCards);

    await page.close();
    console.log('[ok] gallery with full thumbs uses image tiles only');
  }
} finally {
  await browser.close();
}
