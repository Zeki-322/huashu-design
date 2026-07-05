import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const deckIndexPath = path.join(repoRoot, 'assets', 'deck_index.html');
const exportPptxPath = path.join(repoRoot, 'scripts', 'export_deck_pptx.mjs');

async function makeTempDir(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-critical-'));
  t.after(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });
  return dir;
}

async function writeSlideDeck(t, { withThumbs }) {
  const dir = await makeTempDir(t);
  const slidesDir = path.join(dir, 'slides');
  await fs.mkdir(slidesDir);

  const manifest = [];
  for (let i = 1; i <= 12; i++) {
    const name = String(i).padStart(2, '0') + '.html';
    await fs.writeFile(
      path.join(slidesDir, name),
      `<!doctype html><html><body><h1>Slide ${i}</h1></body></html>`
    );
    const item = { file: `slides/${name}`, label: `Slide ${i}` };
    if (withThumbs) item.thumb = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    manifest.push(item);
  }

  const deckIndex = await fs.readFile(deckIndexPath, 'utf8');
  const indexHtml = deckIndex.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`
  );
  await fs.writeFile(path.join(dir, 'index.html'), indexHtml);
  return path.join(dir, 'index.html');
}

test('deck gallery falls back to grid when manifest thumbs are incomplete', { timeout: 30000 }, async (t) => {
  const indexPath = await writeSlideDeck(t, { withThumbs: false });
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(indexPath).href + '?ov=gallery', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.mode === 'overview');

  const overview = await page.evaluate(() => ({
    ov: document.body.dataset.ov,
    galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    galleryImages: document.querySelectorAll('#ov-gallery img').length,
    gridIframes: document.querySelectorAll('#ov-grid iframe').length
  }));

  assert.equal(overview.ov, 'grid');
  assert.equal(overview.galleryIframes, 0);
  assert.equal(overview.galleryImages, 0);
  assert.equal(overview.gridIframes, 12);
});

test('deck gallery uses only thumbnail images when every manifest item has a thumb', { timeout: 30000 }, async (t) => {
  const indexPath = await writeSlideDeck(t, { withThumbs: true });
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
  });

  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(pathToFileURL(indexPath).href + '?ov=gallery', { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.body.dataset.mode === 'overview');

  const overview = await page.evaluate(() => ({
    ov: document.body.dataset.ov,
    galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    galleryImages: document.querySelectorAll('#ov-gallery img').length
  }));

  assert.equal(overview.ov, 'gallery');
  assert.equal(overview.galleryIframes, 0);
  assert.ok(overview.galleryImages >= 12);
});

async function writePptxSlides(t) {
  const dir = await makeTempDir(t);
  const slidesDir = path.join(dir, 'slides');
  await fs.mkdir(slidesDir);
  await fs.writeFile(
    path.join(slidesDir, '01-valid.html'),
    `<!doctype html>
<html><head><style>
html,body{margin:0;width:1280px;height:720px;overflow:hidden;font-family:Arial,sans-serif;}
p{position:absolute;left:96px;top:96px;font-size:28px;line-height:1.2;color:#111;}
</style></head><body><p>Valid editable slide</p></body></html>`
  );
  await fs.writeFile(
    path.join(slidesDir, '02-invalid.html'),
    `<!doctype html>
<html><head><style>
html,body{margin:0;width:960px;height:540px;overflow:hidden;font-family:Arial,sans-serif;}
p{position:absolute;left:72px;top:72px;font-size:24px;}
</style></head><body><p>Wrong canvas size</p></body></html>`
  );
  return { dir, slidesDir, outFile: path.join(dir, 'deck.pptx') };
}

test('PPTX export fails closed and removes stale output when any slide fails', { timeout: 90000 }, async (t) => {
  const { slidesDir, outFile } = await writePptxSlides(t);
  await fs.writeFile(outFile, 'stale pptx');

  const result = spawnSync(process.execPath, [exportPptxPath, '--slides', slidesDir, '--out', outFile], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 90000
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  await assert.rejects(fs.access(outFile));
  assert.match(result.stderr, /默认不生成部分 PPTX/);
});

test('PPTX export writes partial output only with explicit allow-partial', { timeout: 90000 }, async (t) => {
  const { slidesDir, outFile } = await writePptxSlides(t);

  const result = spawnSync(
    process.execPath,
    [exportPptxPath, '--slides', slidesDir, '--out', outFile, '--allow-partial'],
    { cwd: repoRoot, encoding: 'utf8', timeout: 90000 }
  );

  assert.equal(result.status, 0, result.stdout + result.stderr);
  await fs.access(outFile);
  assert.match(result.stdout, /1\/2 slides/);
  assert.match(result.stderr, /已显式允许部分导出/);
});
