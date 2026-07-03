import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const deckIndexPath = path.join(repoRoot, 'assets', 'deck_index.html');

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

function fileUrl(filePath) {
  return 'file://' + filePath;
}

async function writeDeckIndex(dir, manifest) {
  const source = await fs.readFile(deckIndexPath, 'utf8');
  const indexHtml = source.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    'window.DECK_MANIFEST = ' + JSON.stringify(manifest, null, 2) + ';'
  );
  const indexPath = path.join(dir, 'index.html');
  await fs.writeFile(indexPath, indexHtml);
  return indexPath;
}

async function writeSlides(dir, count) {
  const slidesDir = path.join(dir, 'slides');
  await fs.mkdir(slidesDir, { recursive: true });
  const manifest = [];
  for (let i = 1; i <= count; i++) {
    const name = String(i).padStart(2, '0') + '.html';
    await fs.writeFile(path.join(slidesDir, name), `<!doctype html><body>Slide ${i}</body>`);
    manifest.push({ file: 'slides/' + name, label: 'Slide ' + i });
  }
  return manifest;
}

test('deck gallery falls back to grid when manifest thumbs are incomplete', async () => {
  const dir = await makeTempDir('deck-gallery-missing-thumbs-');
  const manifest = await writeSlides(dir, 12);
  const indexPath = await writeDeckIndex(dir, manifest);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  const warnings = [];
  page.on('console', msg => {
    if (msg.type() === 'warning') warnings.push(msg.text());
  });

  try {
    await page.goto(fileUrl(indexPath) + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForSelector('body[data-ov="grid"]');
    const counts = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      wallIframes: document.querySelectorAll('#wall iframe').length,
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
      galleryImages: document.querySelectorAll('#gallery img').length
    }));

    assert.equal(counts.ov, 'grid');
    assert.equal(counts.wallIframes, manifest.length);
    assert.equal(counts.galleryIframes, 0);
    assert.equal(counts.galleryImages, 0);
    assert.match(warnings.join('\n'), /requires every MANIFEST item to include thumb/);
  } finally {
    await browser.close();
  }
});

test('deck gallery with complete thumbs uses images and no iframes', async () => {
  const dir = await makeTempDir('deck-gallery-complete-thumbs-');
  const manifest = (await writeSlides(dir, 4)).map(item => ({
    ...item,
    thumb: item.file.replace(/^slides\//, 'thumbs/').replace(/\.html$/, '.jpg')
  }));
  const indexPath = await writeDeckIndex(dir, manifest);
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });

  try {
    await page.goto(fileUrl(indexPath) + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForSelector('body[data-ov="gallery"]');
    await page.waitForSelector('#gallery img');
    const counts = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
      galleryImages: document.querySelectorAll('#gallery img').length
    }));

    assert.equal(counts.ov, 'gallery');
    assert.equal(counts.galleryIframes, 0);
    assert.ok(counts.galleryImages >= manifest.length);
  } finally {
    await browser.close();
  }
});

test('gen_deck_thumbs exits non-zero when any slide thumbnail fails', async () => {
  const dir = await makeTempDir('thumbs-partial-failure-');
  const slidesDir = path.join(dir, 'slides');
  const outDir = path.join(dir, 'thumbs');
  await fs.mkdir(slidesDir);
  await fs.writeFile(path.join(slidesDir, '01-good.html'), '<!doctype html><body style="margin:0;width:1920px;height:1080px;background:#fff">good</body>');
  await fs.writeFile(path.join(slidesDir, '02-timeout.html'), '<!doctype html><script>while (true) {}</script>');

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'gen_deck_thumbs.mjs'),
    '--slides', slidesDir,
    '--out', outDir,
    '--width', '320',
    '--timeout', '1000'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 20000
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /\[FAIL\] 02-timeout\.html/);
  assert.match(result.stdout + result.stderr, /1\/2/);
  await assert.doesNotReject(fs.access(path.join(outDir, '01-good.jpg')));
});

test('export_deck_pptx fails closed and removes stale output on partial conversion failure', async () => {
  const dir = await makeTempDir('pptx-partial-failure-');
  const slidesDir = path.join(dir, 'slides');
  const outFile = path.join(dir, 'deck.pptx');
  await fs.mkdir(slidesDir);
  await fs.writeFile(path.join(slidesDir, '01-good.html'), `<!doctype html>
<html><head><style>
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; font-family: Arial, sans-serif; }
h1 { position: absolute; left: 96px; top: 80px; font-size: 48px; color: #111; }
</style></head><body><h1>Good slide</h1></body></html>`);
  await fs.writeFile(path.join(slidesDir, '02-bad.html'), `<!doctype html>
<html><head><style>
html, body { margin: 0; width: 1000px; height: 720px; overflow: hidden; font-family: Arial, sans-serif; }
h1 { position: absolute; left: 96px; top: 80px; font-size: 48px; color: #111; }
</style></head><body><h1>Bad slide</h1></body></html>`);
  await fs.writeFile(outFile, 'stale pptx');

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts', 'export_deck_pptx.mjs'),
    '--slides', slidesDir,
    '--out', outFile
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 30000
  });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /01-good\.html ✓/);
  assert.match(result.stderr, /02-bad\.html ✗/);
  assert.match(result.stderr, /默认不生成缺页 PPTX/);
  await assert.rejects(fs.access(outFile), { code: 'ENOENT' });
});
