import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const deckIndexPath = path.join(repoRoot, 'assets', 'deck_index.html');
const genThumbsPath = path.join(repoRoot, 'scripts', 'gen_deck_thumbs.mjs');

function makeTempDeck({ slideCount, withThumbs = false, instrumentAppends = false }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-index-regression-'));
  const slidesDir = path.join(dir, 'slides');
  const thumbsDir = path.join(dir, 'thumbs');
  fs.mkdirSync(slidesDir);
  if (withThumbs) fs.mkdirSync(thumbsDir);

  const manifest = [];
  for (let i = 1; i <= slideCount; i++) {
    const name = `${String(i).padStart(2, '0')}.html`;
    fs.writeFileSync(
      path.join(slidesDir, name),
      `<!doctype html><html><body style="width:1920px;height:1080px;margin:0"><h1>Slide ${i}</h1></body></html>`,
    );
    const item = { file: `slides/${name}`, label: `Slide ${i}` };
    if (withThumbs) {
      const thumb = `thumbs/${String(i).padStart(2, '0')}.jpg`;
      fs.writeFileSync(path.join(dir, thumb), '');
      item.thumb = thumb;
    }
    manifest.push(item);
  }

  let html = fs.readFileSync(deckIndexPath, 'utf8')
    .replace(
      /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
      `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
    );

  if (instrumentAppends) {
    html = html.replace(
      '<script>\n(function () {',
      `<script>
window.__appendedOverviewIframes = 0;
const __origAppendChild = Element.prototype.appendChild;
Element.prototype.appendChild = function (child) {
  if (child && child.tagName === 'IFRAME') window.__appendedOverviewIframes++;
  return __origAppendChild.call(this, child);
};
</script>
<script>
(function () {`,
    );
  }

  fs.writeFileSync(path.join(dir, 'index.html'), html);
  return dir;
}

async function withPage(fn) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test('gallery request falls back to grid when manifest lacks complete thumbs', async () => {
  const slideCount = 18;
  const dir = makeTempDeck({ slideCount, instrumentAppends: true });

  await withPage(async page => {
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?ov=gallery');
    await page.waitForFunction(count => document.querySelectorAll('#wall .card').length === count, slideCount);

    assert.equal(await page.locator('body').getAttribute('data-ov'), 'grid');
    assert.equal(await page.locator('#gallery iframe').count(), 0);
    assert.equal(await page.locator('#wall iframe').count(), slideCount);
    assert.equal(await page.evaluate(() => window.__appendedOverviewIframes), slideCount);
  });
});

test('gallery with complete thumbs uses images and no iframe fallback', async () => {
  const dir = makeTempDeck({ slideCount: 12, withThumbs: true });

  await withPage(async page => {
    await page.goto(pathToFileURL(path.join(dir, 'index.html')).href + '?ov=gallery');
    await page.waitForFunction(() => document.querySelectorAll('#gallery .card').length > 0);

    assert.equal(await page.locator('body').getAttribute('data-ov'), 'gallery');
    assert.equal(await page.locator('#gallery iframe').count(), 0);
    assert.ok(await page.locator('#gallery img.thumb-img').count() > 0);
  });
});

test('gen_deck_thumbs exits non-zero when any slide conversion fails', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-thumbs-regression-'));
  const slidesDir = path.join(dir, 'slides');
  const outDir = path.join(dir, 'thumbs');
  fs.mkdirSync(slidesDir);
  fs.writeFileSync(path.join(slidesDir, '01.html'), '<!doctype html><html><body>Slide</body></html>');

  const result = spawnSync(
    process.execPath,
    [genThumbsPath, '--slides', slidesDir, '--out', outDir, '--width', 'not-a-number'],
    { cwd: repoRoot, encoding: 'utf8' },
  );

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /缩略图生成不完整|Expected positive integer/);
});
