import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const deckIndexTemplate = path.join(repoRoot, 'assets', 'deck_index.html');
const genThumbsScript = path.join(repoRoot, 'scripts', 'gen_deck_thumbs.mjs');

async function makeDeck({ count = 12, withThumbs = false } = {}) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'deck-index-regression-'));
  const slidesDir = path.join(dir, 'slides');
  const thumbsDir = path.join(dir, 'thumbs');
  await fs.promises.mkdir(slidesDir);
  await fs.promises.mkdir(thumbsDir);

  const manifest = [];
  for (let i = 1; i <= count; i++) {
    const name = String(i).padStart(2, '0');
    await fs.promises.writeFile(
      path.join(slidesDir, `${name}.html`),
      `<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:#fff"><h1>${name}</h1></body></html>`
    );
    if (withThumbs) {
      await fs.promises.writeFile(path.join(thumbsDir, `${name}.jpg`), '');
    }
    manifest.push({
      file: `slides/${name}.html`,
      label: `Slide ${name}`,
      ...(withThumbs ? { thumb: `thumbs/${name}.jpg` } : {}),
    });
  }

  const template = await fs.promises.readFile(deckIndexTemplate, 'utf8');
  const bootScript = `<script>
  window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 4)};
  window.DECK_WIDTH = 1920;
  window.DECK_HEIGHT = 1080;
  window.DECK_OVERVIEW = 'gallery';
</script>`;
  const html = template.replace(/<script>\s*window\.DECK_MANIFEST = \[[\s\S]*?<\/script>/, bootScript);
  await fs.promises.writeFile(path.join(dir, 'index.html'), html);
  return dir;
}

async function withBrowser(fn) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    return await fn(page);
  } finally {
    await browser.close();
  }
}

test('deck_index falls back to grid when gallery is requested without complete thumbs', async () => {
  const dir = await makeDeck({ withThumbs: false });
  try {
    await withBrowser(async (page) => {
      await page.goto(pathToFileURL(path.join(dir, 'index.html')).href, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.ov === 'grid');
      assert.equal(await page.locator('body').getAttribute('data-ov'), 'grid');
      assert.equal(await page.locator('#gallery iframe').count(), 0);
      assert.equal(await page.locator('#wall iframe').count(), 12);
    });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('deck_index keeps gallery image-only when all thumbs are present', async () => {
  const dir = await makeDeck({ withThumbs: true });
  try {
    await withBrowser(async (page) => {
      await page.goto(pathToFileURL(path.join(dir, 'index.html')).href, { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.ov === 'gallery' && document.querySelectorAll('#gallery .card').length > 0);
      assert.equal(await page.locator('body').getAttribute('data-ov'), 'gallery');
      assert.equal(await page.locator('#gallery iframe').count(), 0);
      assert.ok(await page.locator('#gallery img.thumb-img').count() > 0);
    });
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});

test('gen_deck_thumbs exits non-zero and removes failed output on thumbnail failure', async () => {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'gen-thumbs-regression-'));
  const slidesDir = path.join(dir, 'slides');
  const outDir = path.join(dir, 'thumbs');
  await fs.promises.mkdir(slidesDir);
  await fs.promises.mkdir(outDir);
  await fs.promises.writeFile(
    path.join(slidesDir, '01.html'),
    '<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:#fff">slide</body></html>'
  );

  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [
        genThumbsScript,
        '--slides', slidesDir,
        '--out', outDir,
        '--width', '0',
      ], { cwd: repoRoot });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; });
      child.stderr.on('data', chunk => { stderr += chunk; });
      child.on('error', reject);
      child.on('close', code => resolve({ code, stdout, stderr }));
    });

    assert.notEqual(result.code, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /\[FAIL\] 01\.html:/);
    assert.match(result.stderr, /缩略图生成失败/);
    assert.equal(fs.existsSync(path.join(outDir, '01.jpg')), false);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
});
