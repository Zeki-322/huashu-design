import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function tempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeSlide(file, body = '<h1>Hello</h1>') {
  await writeFile(file, `<!doctype html><html><head><style>html,body{margin:0;width:1280px;height:720px;overflow:hidden;font-family:sans-serif}</style></head><body>${body}</body></html>`);
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') },
    ...options,
  });
}

function extractHideChromeCss(source) {
  const match = source.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/);
  assert.ok(match, 'HIDE_CHROME_CSS template should exist');
  return match[1];
}

test('deck gallery falls back to grid when manifest lacks complete thumbnails', async () => {
  const dir = await tempDir('deck-index-');
  try {
    const slidesDir = path.join(dir, 'slides');
    await mkdir(slidesDir, { recursive: true });
    await Promise.all([
      writeSlide(path.join(slidesDir, '01.html')),
      writeSlide(path.join(slidesDir, '02.html')),
      writeSlide(path.join(slidesDir, '03.html')),
    ]);

    const source = await readFile(path.join(ROOT, 'assets', 'deck_index.html'), 'utf8');
    const manifest = `window.DECK_MANIFEST = [
    { file: "slides/01.html", label: "One" },
    { file: "slides/02.html", label: "Two" },
    { file: "slides/03.html", label: "Three" },
  ];`;
    await writeFile(path.join(dir, 'index.html'), source.replace(/window\.DECK_MANIFEST = \[[\s\S]*?\];/, manifest));

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    try {
      await page.goto('file://' + path.join(dir, 'index.html') + '?ov=gallery', { waitUntil: 'load' });
      await page.waitForFunction(() => document.body.dataset.ov === 'grid');
      assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
      assert.equal(await page.locator('#ov-grid iframe').count(), 3);

      await page.click('#startBtn');
      await page.waitForFunction(() => document.body.dataset.mode === 'present');
      assert.equal(await page.locator('#ov-grid .card').count(), 0);
      assert.equal(await page.locator('#ov-gallery .card').count(), 0);
    } finally {
      await browser.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('gen_deck_thumbs exits non-zero and removes stale thumbnail on failed slide', async () => {
  const dir = await tempDir('deck-thumbs-');
  try {
    const slidesDir = path.join(dir, 'slides');
    const thumbsDir = path.join(dir, 'thumbs');
    await mkdir(slidesDir, { recursive: true });
    await mkdir(thumbsDir, { recursive: true });
    await writeSlide(path.join(slidesDir, '01.html'));
    const stale = path.join(thumbsDir, '01.jpg');
    await writeFile(stale, 'stale');

    const result = runNode([
      'scripts/gen_deck_thumbs.mjs',
      '--slides', slidesDir,
      '--out', thumbsDir,
      '--width', '0',
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(stale), false, 'stale thumbnail should be removed after failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('export_deck_pptx fails closed and removes stale output on partial slide conversion failure', async () => {
  const dir = await tempDir('deck-pptx-');
  try {
    const slidesDir = path.join(dir, 'slides');
    await mkdir(slidesDir, { recursive: true });
    await writeSlide(path.join(slidesDir, '01-good.html'), '<h1 style="font-size:40px">Good</h1>');
    await writeFile(path.join(slidesDir, '02-bad.html'), '<!doctype html><html><head><style>html,body{margin:0;width:640px;height:360px}</style></head><body><h1>Bad</h1></body></html>');
    const out = path.join(dir, 'deck.pptx');
    await writeFile(out, 'stale');

    const result = runNode([
      'scripts/export_deck_pptx.mjs',
      '--slides', slidesDir,
      '--out', out,
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /禁止生成缺页 PPTX|转换失败/);
    assert.equal(fs.existsSync(out), false, 'stale PPTX should be removed after partial failure');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('video chrome hiding does not target generic content class names', async () => {
  for (const file of ['render-video.js', 'render-video-seek.js']) {
    const source = await readFile(path.join(ROOT, 'scripts', file), 'utf8');
    const css = extractHideChromeCss(source);
    assert.doesNotMatch(css, /\.title\b/);
    assert.doesNotMatch(css, /\.kicker\b/);
    assert.doesNotMatch(css, /\.masthead\b/);
    assert.doesNotMatch(css, /\.footer\b/);
  }
});

test('seek renderer requires frozen-clock handshake and removes stale mp4 on failure', async () => {
  const dir = await tempDir('seek-render-');
  try {
    const html = path.join(dir, 'bad.html');
    const mp4 = path.join(dir, 'bad.mp4');
    await writeFile(html, `<!doctype html><html><body><script>
      window.__ready = true;
      window.__seek = function () {};
    </script></body></html>`);
    await writeFile(mp4, 'stale');

    const result = runNode([
      'scripts/render-video-seek.js',
      html,
      '--duration=0.1',
      '--fps=1',
      '--readytimeout=0.2',
      '--concurrency=1',
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(mp4), false, 'stale MP4 should be removed when seek render fails');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('seek render safeguards stay wired into renderer and stages', async () => {
  const seek = await readFile(path.join(ROOT, 'scripts', 'render-video-seek.js'), 'utf8');
  assert.match(seek, /Math\.max\(1,\s*Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(seek, /window\.__seekRenderReady === true/);
  assert.match(seek, /pngCount !== TOTAL_FRAMES/);
  assert.match(seek, /'-start_number', '0'/);

  const animations = await readFile(path.join(ROOT, 'assets', 'animations.jsx'), 'utf8');
  const narration = await readFile(path.join(ROOT, 'assets', 'narration_stage.jsx'), 'utf8');
  assert.match(animations, /window\.__seekRenderReady = true/);
  assert.match(narration, /window\.__seekRenderReady = true/);
});
