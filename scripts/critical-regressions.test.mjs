import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function extractHideChromeCss(source) {
  const match = source.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/);
  assert.ok(match, 'HIDE_CHROME_CSS block should exist');
  return match[1];
}

function buildDeckFixture({ thumbs }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-index-regression-'));
  const slidesDir = path.join(dir, 'slides');
  const thumbsDir = path.join(dir, 'thumbs');
  fs.mkdirSync(slidesDir);
  if (thumbs) fs.mkdirSync(thumbsDir);

  const manifest = [];
  for (let i = 1; i <= 13; i++) {
    const name = String(i).padStart(2, '0') + '.html';
    fs.writeFileSync(
      path.join(slidesDir, name),
      `<!doctype html><meta charset="utf-8"><title>${i}</title><body>Slide ${i}</body>`,
    );
    const item = { file: `slides/${name}`, label: `Slide ${i}` };
    if (thumbs) {
      const thumbName = String(i).padStart(2, '0') + '.jpg';
      fs.writeFileSync(path.join(thumbsDir, thumbName), '');
      item.thumb = `thumbs/${thumbName}`;
    }
    manifest.push(item);
  }

  const template = read('assets/deck_index.html');
  const html = template.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  const indexPath = path.join(dir, 'index.html');
  fs.writeFileSync(indexPath, html);
  return { dir, indexPath };
}

test('deck_index falls back to grid when gallery thumbs are incomplete', async () => {
  const fixture = buildDeckFixture({ thumbs: false });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(pathToFileURL(fixture.indexPath).href + '?ov=gallery');
    await page.waitForFunction(() => document.querySelectorAll('#wall iframe').length === 13);

    assert.equal(await page.getAttribute('body', 'data-ov'), 'grid');
    assert.equal(await page.locator('#gallery iframe').count(), 0);
    assert.equal(await page.locator('#wall iframe').count(), 13);
  } finally {
    await browser.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('deck_index keeps gallery iframe-free when thumbs are complete', async () => {
  const fixture = buildDeckFixture({ thumbs: true });
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(pathToFileURL(fixture.indexPath).href + '?ov=gallery');
    await page.waitForFunction(() => document.querySelectorAll('#gallery .card').length > 13);

    assert.equal(await page.getAttribute('body', 'data-ov'), 'gallery');
    assert.equal(await page.locator('#gallery iframe').count(), 0);
    assert.ok(await page.locator('#gallery img.thumb-img').count() > 13);
  } finally {
    await browser.close();
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('video chrome hiding does not target common content class names', () => {
  for (const relPath of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const css = extractHideChromeCss(read(relPath));
    assert.doesNotMatch(css, /(^|[\s,])\.(title|kicker|masthead|footer)([\s,{]|$)/);
    assert.match(css, /\.no-record/);
    assert.match(css, /\[data-role="chrome"\]/);
  }
});

test('render-video waitForFunction passes timeout as Playwright options', () => {
  const source = read('scripts/render-video.js');
  assert.match(
    source,
    /page\.waitForFunction\(\s*\(\) => window\.__ready === true,\s*null,\s*\{ timeout: READY_TIMEOUT \* 1000 \},\s*\)/,
  );
});

test('seek renderer fails closed on unsafe or incomplete frame capture', () => {
  const source = read('scripts/render-video-seek.js');
  assert.match(source, /window\.__seekRenderReady === true/);
  assert.match(source, /pngCount !== TOTAL_FRAMES/);
  assert.match(source, /'-start_number', '0'/);
  assert.match(source, /fs\.rmSync\(MP4_OUT, \{ force: true \}\)/);
  assert.match(
    source,
    /page\.waitForFunction\(\s*\(\) => window\.__ready === true && window\.__seekRenderReady === true && typeof window\.__seek === 'function',\s*null,\s*\{ timeout: READY_TIMEOUT \* 1000 \},\s*\)/,
  );

  assert.match(read('assets/animations.jsx'), /window\.__seekRenderReady = true/);
  assert.match(read('assets/narration_stage.jsx'), /window\.__seekRenderReady = true/);
});

test('seek renderer exports only with the frozen-clock handshake', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seek-render-regression-'));
  const script = path.join(ROOT, 'scripts/render-video-seek.js');
  const env = { ...process.env, NODE_PATH: path.join(ROOT, 'node_modules') };
  try {
    const goodHtml = path.join(dir, 'good.html');
    fs.writeFileSync(goodHtml, `<!doctype html>
<meta charset="utf-8">
<style>
  body { margin: 0; background: #123; color: white; font: 40px sans-serif; }
  .title { position: absolute; inset: 0; display: grid; place-items: center; }
</style>
<div class="title" id="title">VISIBLE TITLE</div>
<script>
  window.__ready = true;
  if (window.__seekRender) {
    window.__seekRenderReady = true;
    window.__seek = (t) => { document.getElementById('title').textContent = 'frame ' + t.toFixed(1); };
  }
</script>`);

    const good = spawnSync(process.execPath, [
      script,
      goodHtml,
      '--duration=0.4',
      '--fps=5',
      '--width=320',
      '--height=180',
      '--concurrency=1',
      '--readytimeout=2',
    ], { env, encoding: 'utf8' });
    assert.equal(good.status, 0, good.stdout + good.stderr);
    assert.match(good.stdout, /Captured 2\/2 frames/);
    assert.ok(fs.statSync(path.join(dir, 'good.mp4')).size > 0);

    const badHtml = path.join(dir, 'bad.html');
    fs.writeFileSync(badHtml, `<!doctype html>
<meta charset="utf-8">
<body>unsafe seek</body>
<script>
  window.__ready = true;
  window.__seek = () => {};
</script>`);
    const bad = spawnSync(process.execPath, [
      script,
      badHtml,
      '--duration=0.4',
      '--fps=5',
      '--width=320',
      '--height=180',
      '--concurrency=1',
      '--readytimeout=0.2',
    ], { env, encoding: 'utf8' });
    assert.notEqual(bad.status, 0);
    assert.match(bad.stderr, /__seekRenderReady/);
    assert.equal(fs.existsSync(path.join(dir, 'bad.mp4')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('narration and thumbnail helpers fail instead of relying on unsafe fallbacks', () => {
  const narration = read('scripts/render-narration.sh');
  assert.match(narration, /npm --prefix "\$SKILL_ROOT" root/);
  assert.doesNotMatch(narration, /npm root -g/);

  const thumbs = read('scripts/gen_deck_thumbs.mjs');
  assert.match(thumbs, /failed\+\+/);
  assert.match(thumbs, /process\.exit\(1\)/);
  assert.doesNotMatch(thumbs, /回退 iframe/);
});
