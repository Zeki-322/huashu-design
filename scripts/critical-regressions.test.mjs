import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname);
const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-critical-'));

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content);
}

async function withBrowser(fn) {
  const browser = await chromium.launch();
  try {
    await fn(browser);
  } finally {
    await browser.close();
  }
}

async function makeDeckHtml(entries) {
  const source = await fs.readFile(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');
  const manifest = `window.DECK_MANIFEST = ${JSON.stringify(entries, null, 4)};`;
  return source.replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, manifest);
}

async function testGalleryWithoutThumbsFallsBackToGrid() {
  const dir = path.join(tempRoot, 'deck-no-thumbs');
  const slides = Array.from({ length: 12 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    label: `Slide ${i + 1}`,
  }));
  for (const slide of slides) {
    await writeFile(path.join(dir, slide.file), '<!doctype html><body>slide</body>');
  }
  await writeFile(path.join(dir, 'index.html'), await makeDeckHtml(slides));

  await withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('file://' + path.join(dir, 'index.html') + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');

    assert.equal(await page.getAttribute('body', 'data-ov'), 'grid');
    assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
    assert.equal(await page.locator('#wall iframe').count(), slides.length);
  });
}

async function testGalleryWithThumbsStaysGallery() {
  const dir = path.join(tempRoot, 'deck-with-thumbs');
  const slides = Array.from({ length: 4 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    label: `Slide ${i + 1}`,
    thumb: `thumbs/${String(i + 1).padStart(2, '0')}.jpg`,
  }));
  for (const slide of slides) {
    await writeFile(path.join(dir, slide.file), '<!doctype html><body>slide</body>');
    await writeFile(path.join(dir, slide.thumb), '');
  }
  await writeFile(path.join(dir, 'index.html'), await makeDeckHtml(slides));

  await withBrowser(async browser => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('file://' + path.join(dir, 'index.html') + '?ov=gallery', { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');

    assert.equal(await page.getAttribute('body', 'data-ov'), 'gallery');
    assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
    assert.ok(await page.locator('#ov-gallery img.thumb-img').count() > slides.length);
  });
}

async function testSeekRenderKeepsAllFrames() {
  const dir = path.join(tempRoot, 'seek');
  const html = path.join(dir, 'seek.html');
  await writeFile(html, `<!doctype html>
<html><body style="margin:0;width:1920px;height:1080px;background:#112;color:white">
<div id="frame" class="title" style="font:80px sans-serif">frame 0</div>
<script>
window.__ready = true;
window.__seek = (t) => { document.getElementById('frame').textContent = 'frame ' + Math.round(t * 2); };
</script>
</body></html>`);

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/render-video-seek.js'),
    html,
    '--duration=1',
    '--fps=2',
    '--width=320',
    '--height=180',
    '--concurrency=1',
  ], {
    cwd: repoRoot,
    env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /Captured 2\/2 frames/);

  const mp4 = path.join(dir, 'seek.mp4');
  const probe = spawnSync('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-count_frames',
    '-show_entries', 'stream=nb_read_frames',
    '-of', 'default=nokey=1:noprint_wrappers=1',
    mp4,
  ], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), '2');
}

async function testPptxExportFailsOnPartialConversion() {
  const dir = path.join(tempRoot, 'pptx');
  const slidesDir = path.join(dir, 'slides');
  const out = path.join(dir, 'deck.pptx');
  await writeFile(out, 'stale-output');
  await writeFile(path.join(slidesDir, '01-ok.html'), `<!doctype html>
<html><head><style>html,body{margin:0;width:1280px;height:720px}p{font-size:32px;margin:40px}</style></head><body><p>OK</p></body></html>`);
  await writeFile(path.join(slidesDir, '02-bad.html'), `<!doctype html>
<html><head><style>html,body{margin:0;width:1280px;height:720px;background:linear-gradient(red, blue)}</style></head><body><p>Bad</p></body></html>`);

  const result = spawnSync(process.execPath, [
    path.join(repoRoot, 'scripts/export_deck_pptx.mjs'),
    '--slides',
    slidesDir,
    '--out',
    out,
  ], {
    cwd: repoRoot,
    env: { ...process.env, NODE_PATH: path.join(repoRoot, 'node_modules') },
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr, /默认不允许缺页交付/);
  await assert.rejects(() => fs.stat(out), error => error && error.code === 'ENOENT');
}

try {
  await testGalleryWithoutThumbsFallsBackToGrid();
  await testGalleryWithThumbsStaysGallery();
  await testSeekRenderKeepsAllFrames();
  await testPptxExportFailsOnPartialConversion();
  console.log('critical regressions passed');
} finally {
  await fs.rm(tempRoot, { recursive: true, force: true });
}
