import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const templatePath = path.join(repoRoot, 'assets', 'deck_index.html');

function withManifest(template, manifest) {
  const replacement = 'window.DECK_MANIFEST = ' + JSON.stringify(manifest, null, 2) + ';';
  const html = template.replace(/window\.DECK_MANIFEST\s*=\s*\[[\s\S]*?\];/, replacement);
  assert.notEqual(html, template, 'test fixture should replace the deck manifest');
  return html;
}

async function writeDeck(manifest) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'deck-index-regression-'));
  const slidesDir = path.join(root, 'slides');
  await mkdir(slidesDir);
  for (const item of manifest) {
    await writeFile(path.join(root, item.file), '<!doctype html><title>' + item.label + '</title><h1>' + item.label + '</h1>');
  }
  const template = await readFile(templatePath, 'utf8');
  await writeFile(path.join(root, 'index.html'), withManifest(template, manifest));
  return root;
}

test('deck gallery falls back to grid when any slide is missing a thumbnail', async (t) => {
  const manifest = Array.from({ length: 24 }, (_, i) => ({
    file: 'slides/' + String(i + 1).padStart(2, '0') + '.html',
    label: 'Slide ' + (i + 1),
  }));
  const root = await writeDeck(manifest);
  t.after(() => rm(root, { recursive: true, force: true }));

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?ov=gallery', { waitUntil: 'load' });
  await page.waitForFunction((count) => document.querySelectorAll('#wall .card').length === count, manifest.length);

  const state = await page.evaluate(() => ({
    overview: document.body.getAttribute('data-ov'),
    gridCards: document.querySelectorAll('#wall .card').length,
    galleryCards: document.querySelectorAll('#gallery .card').length,
    galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
  }));

  assert.deepEqual(state, {
    overview: 'grid',
    gridCards: manifest.length,
    galleryCards: 0,
    galleryIframes: 0,
  });
});

test('deck gallery uses thumbnails without creating iframe tiles when thumbnails are complete', async (t) => {
  const manifest = Array.from({ length: 6 }, (_, i) => ({
    file: 'slides/' + String(i + 1).padStart(2, '0') + '.html',
    label: 'Slide ' + (i + 1),
    thumb: 'thumbs/' + String(i + 1).padStart(2, '0') + '.jpg',
  }));
  const root = await writeDeck(manifest);
  t.after(() => rm(root, { recursive: true, force: true }));

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  await page.goto(pathToFileURL(path.join(root, 'index.html')).href + '?ov=gallery', { waitUntil: 'load' });
  await page.waitForFunction((count) => document.querySelectorAll('#gallery .card').length > count, manifest.length);

  const state = await page.evaluate(() => ({
    overview: document.body.getAttribute('data-ov'),
    gridCards: document.querySelectorAll('#wall .card').length,
    galleryCards: document.querySelectorAll('#gallery .card').length,
    galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    galleryImages: document.querySelectorAll('#ov-gallery img.thumb-img').length,
  }));

  assert.equal(state.overview, 'gallery');
  assert.equal(state.gridCards, 0);
  assert.equal(state.galleryIframes, 0);
  assert.ok(state.galleryCards > manifest.length, 'gallery should repeat thumbnail cards for seamless drift');
  assert.equal(state.galleryImages, state.galleryCards);
});
