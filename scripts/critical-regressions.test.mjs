import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deckIndexPath = path.join(repoRoot, 'assets', 'deck_index.html');

function createDeck(t, slideCount) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-index-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const slidesDir = path.join(root, 'slides');
  fs.mkdirSync(slidesDir);
  for (let i = 1; i <= slideCount; i++) {
    const name = String(i).padStart(2, '0');
    fs.writeFileSync(
      path.join(slidesDir, `${name}.html`),
      `<!doctype html><html><body><h1>Slide ${i}</h1></body></html>`
    );
  }

  const manifest = Array.from({ length: slideCount }, (_, i) => {
    const name = String(i + 1).padStart(2, '0');
    return `{ file: "slides/${name}.html", label: "S${i + 1}" }`;
  }).join(',\n    ');
  const source = fs.readFileSync(deckIndexPath, 'utf8');
  const html = source.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = [\n    ${manifest}\n  ];`
  );
  const indexPath = path.join(root, 'index.html');
  fs.writeFileSync(indexPath, html);
  return { indexPath, root };
}

test('deck gallery without complete thumbs falls back to grid instead of iframe tiles', { timeout: 15000 }, async (t) => {
  const { indexPath } = createDeck(t, 13);
  const browser = await chromium.launch();
  t.after(() => browser.close());

  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${pathToFileURL(indexPath).href}?ov=gallery`, { waitUntil: 'load' });
  await page.waitForFunction(
    (slideCount) => document.body.dataset.ov === 'grid' && document.querySelectorAll('#ov-grid iframe').length === slideCount,
    13,
    { timeout: 5000 }
  );

  const counts = await page.evaluate(() => ({
    overview: document.body.dataset.ov,
    galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    galleryCards: document.querySelectorAll('#ov-gallery .card').length,
    gridIframes: document.querySelectorAll('#ov-grid iframe').length,
  }));
  assert.deepEqual(counts, {
    overview: 'grid',
    galleryIframes: 0,
    galleryCards: 0,
    gridIframes: 13,
  });
});

test('deck hash navigation clamps out-of-range slide numbers', { timeout: 15000 }, async (t) => {
  const { indexPath } = createDeck(t, 5);
  const browser = await chromium.launch();
  t.after(() => browser.close());

  const page = await browser.newPage();
  await page.goto(`${pathToFileURL(indexPath).href}#99`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelector('#counter')?.textContent?.startsWith('5 / 5'), null, { timeout: 5000 });

  let state = await page.evaluate(() => ({
    mode: document.body.dataset.mode,
    counter: document.querySelector('#counter').textContent.trim(),
    frameSrc: document.querySelector('#frame').getAttribute('src'),
  }));
  assert.equal(state.mode, 'present');
  assert.match(state.counter, /^5 \/ 5/);
  assert.equal(state.frameSrc, 'slides/05.html');

  await page.evaluate(() => { location.hash = '#0'; });
  await page.waitForFunction(() => document.querySelector('#counter')?.textContent?.startsWith('1 / 5'), null, { timeout: 5000 });
  state = await page.evaluate(() => ({
    counter: document.querySelector('#counter').textContent.trim(),
    frameSrc: document.querySelector('#frame').getAttribute('src'),
  }));
  assert.match(state.counter, /^1 \/ 5/);
  assert.equal(state.frameSrc, 'slides/01.html');
});

test('gen_deck_thumbs exits non-zero when thumbnail generation fails', { timeout: 30000 }, (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-thumbs-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const slidesDir = path.join(root, 'slides');
  const outDir = path.join(root, 'thumbs');
  fs.mkdirSync(slidesDir);
  fs.writeFileSync(path.join(slidesDir, '01.html'), '<!doctype html><html><body>slide</body></html>');

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'gen_deck_thumbs.mjs'),
    '--slides', slidesDir,
    '--out', outDir,
    '--width', '0',
  ], { cwd: root, encoding: 'utf8' });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /\[FAIL\]|缩略图生成失败/);
});
