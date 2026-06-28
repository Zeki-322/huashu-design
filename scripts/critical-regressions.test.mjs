import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE = process.execPath;

function makeTempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function runNode(args, options = {}) {
  return spawnSync(NODE, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: options.timeout ?? 120000,
    env: {
      ...process.env,
      NODE_PATH: path.join(ROOT, 'node_modules'),
      ...(options.env || {}),
    },
  });
}

function writeSlides(slidesDir, count) {
  fs.mkdirSync(slidesDir, { recursive: true });
  for (let i = 1; i <= count; i++) {
    fs.writeFileSync(path.join(slidesDir, `${String(i).padStart(2, '0')}.html`), `<!doctype html>
<html><body style="margin:0;width:1920px;height:1080px;background:hsl(${i * 30},70%,80%)">
<h1>Slide ${i}</h1>
</body></html>`);
  }
}

function writeDeckIndex(deckRoot, manifest) {
  const template = fs.readFileSync(path.join(ROOT, 'assets/deck_index.html'), 'utf8');
  const html = template.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  fs.writeFileSync(path.join(deckRoot, 'index.html'), html);
}

test('deck_index forces grid when gallery is requested without complete thumbs', async (t) => {
  const tmp = makeTempDir('huashu-deck-no-thumbs-');
  t.after(() => rmrf(tmp));

  const slideCount = 24;
  writeSlides(path.join(tmp, 'slides'), slideCount);
  writeDeckIndex(tmp, Array.from({ length: slideCount }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    label: `Slide ${i + 1}`,
  })));

  const browser = await chromium.launch();
  t.after(async () => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${pathToFileURL(path.join(tmp, 'index.html')).href}?ov=gallery`);
  await page.waitForFunction(
    (n) => document.body.dataset.ov === 'grid' && document.querySelectorAll('#wall .card').length === n,
    slideCount,
    { timeout: 5000 },
  );

  const state = await page.evaluate(() => ({
    overview: document.body.dataset.ov,
    gridCards: document.querySelectorAll('#wall .card').length,
    galleryCards: document.querySelectorAll('#gallery .card').length,
    galleryIframes: document.querySelectorAll('#gallery iframe').length,
  }));
  assert.equal(state.overview, 'grid');
  assert.equal(state.gridCards, slideCount);
  assert.equal(state.galleryCards, 0);
  assert.equal(state.galleryIframes, 0);
});

test('deck_index uses image-only gallery when every slide has a thumb', async (t) => {
  const tmp = makeTempDir('huashu-deck-with-thumbs-');
  t.after(() => rmrf(tmp));

  const slideCount = 4;
  writeSlides(path.join(tmp, 'slides'), slideCount);
  fs.mkdirSync(path.join(tmp, 'thumbs'));
  const manifest = Array.from({ length: slideCount }, (_, i) => {
    const name = `${String(i + 1).padStart(2, '0')}.jpg`;
    fs.writeFileSync(path.join(tmp, 'thumbs', name), '');
    return {
      file: `slides/${String(i + 1).padStart(2, '0')}.html`,
      thumb: `thumbs/${name}`,
      label: `Slide ${i + 1}`,
    };
  });
  writeDeckIndex(tmp, manifest);

  const browser = await chromium.launch();
  t.after(async () => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`${pathToFileURL(path.join(tmp, 'index.html')).href}?ov=gallery`);
  await page.waitForFunction(
    () => document.body.dataset.ov === 'gallery' && document.querySelectorAll('#gallery .card').length > 0,
    null,
    { timeout: 5000 },
  );

  const state = await page.evaluate(() => ({
    overview: document.body.dataset.ov,
    galleryCards: document.querySelectorAll('#gallery .card').length,
    galleryImgs: document.querySelectorAll('#gallery img.thumb-img').length,
    galleryIframes: document.querySelectorAll('#gallery iframe').length,
  }));
  assert.equal(state.overview, 'gallery');
  assert.ok(state.galleryCards > slideCount);
  assert.equal(state.galleryImgs, state.galleryCards);
  assert.equal(state.galleryIframes, 0);
});

test('gen_deck_thumbs rejects invalid output dimensions instead of reporting success', () => {
  const tmp = makeTempDir('huashu-thumb-args-');
  try {
    writeSlides(path.join(tmp, 'slides'), 1);
    const result = runNode([
      'scripts/gen_deck_thumbs.mjs',
      '--slides', path.join(tmp, 'slides'),
      '--out', path.join(tmp, 'thumbs'),
      '--width', '0',
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /width/i);
  } finally {
    rmrf(tmp);
  }
});

test('export_deck_pptx fails closed and removes stale output on partial conversion failure', () => {
  const tmp = makeTempDir('huashu-pptx-partial-');
  try {
    const slides = path.join(tmp, 'slides');
    fs.mkdirSync(slides);
    fs.writeFileSync(path.join(slides, '01-ok.html'), `<!doctype html>
<html><head><style>
body{margin:0;width:1280px;height:720px;overflow:hidden;background:#fff}
p{position:absolute;left:80px;top:80px;margin:0;font-size:32px;color:#111}
</style></head><body><p>Valid slide</p></body></html>`);
    fs.writeFileSync(path.join(slides, '02-bad.html'), `<!doctype html>
<html><head><style>body{margin:0;width:100px;height:100px;overflow:hidden}</style></head>
<body><p>Wrong size</p></body></html>`);
    const out = path.join(tmp, 'deck.pptx');
    fs.writeFileSync(out, 'stale output');

    const result = runNode(['scripts/export_deck_pptx.mjs', '--slides', slides, '--out', out]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /禁止缺页|partial|转换失败/i);
    assert.equal(fs.existsSync(out), false);
  } finally {
    rmrf(tmp);
  }
});

test('video renderers do not hide generic content class names as chrome', () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(text, /^\s*\.masthead,/m, rel);
    assert.doesNotMatch(text, /^\s*\.kicker,/m, rel);
    assert.doesNotMatch(text, /^\s*\.title,/m, rel);
    assert.doesNotMatch(text, /^\s*\.footer,/m, rel);
  }
});

test('render-video-seek rejects pages that expose __seek without frozen-clock handshake', () => {
  const tmp = makeTempDir('huashu-seek-bad-');
  try {
    const html = path.join(tmp, 'bad-seek.html');
    fs.writeFileSync(html, `<!doctype html>
<html><body style="margin:0;width:80px;height:60px;background:#123">
<script>
window.__ready = true;
window.__seek = function () {};
</script>
</body></html>`);
    const result = runNode([
      'scripts/render-video-seek.js',
      html,
      '--duration=1',
      '--fps=1',
      '--width=80',
      '--height=60',
      '--concurrency=1',
      '--readytimeout=0.2',
    ], { timeout: 30000 });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /__seekRenderReady|冻结时钟/);
    assert.equal(fs.existsSync(path.join(tmp, 'bad-seek.mp4')), false);
  } finally {
    rmrf(tmp);
  }
});

