import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function tmpdir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), name));
}

function writeDeckFixture(root, count = 8) {
  fs.mkdirSync(path.join(root, 'slides'), { recursive: true });
  const manifest = [];
  for (let i = 1; i <= count; i++) {
    const id = String(i).padStart(2, '0');
    const file = `slides/${id}.html`;
    manifest.push({ file, label: `Slide ${i}` });
    fs.writeFileSync(path.join(root, file), `<!doctype html><html><body><h1>${id}</h1></body></html>`);
  }
  const index = read('assets/deck_index.html').replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
  fs.writeFileSync(path.join(root, 'index.html'), index);
  return path.join(root, 'index.html');
}

test('deck_index falls back to grid when gallery is requested without complete thumbs', { timeout: 15000 }, async () => {
  const dir = tmpdir('deck-index-gallery-');
  const index = writeDeckFixture(dir);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${pathToFileURL(index).href}?ov=gallery`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.ov === 'grid');

    assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
    assert.equal(await page.evaluate(() => document.body.dataset.mode), 'overview');
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('deck_index tears down overview iframes when entering present mode', { timeout: 15000 }, async () => {
  const dir = tmpdir('deck-index-present-');
  const index = writeDeckFixture(dir);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`${pathToFileURL(index).href}?ov=grid`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.querySelectorAll('#wall iframe').length === 8);

    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present');

    assert.equal(await page.locator('#wall iframe, #gallery iframe').count(), 0);
    assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector('#ov-grid')).display), 'none');
  } finally {
    await browser.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('export_deck_pptx fails closed and removes stale output on partial slide failure', { timeout: 30000 }, () => {
  const dir = tmpdir('deck-pptx-partial-');
  const slides = path.join(dir, 'slides');
  const out = path.join(dir, 'deck.pptx');
  fs.mkdirSync(slides, { recursive: true });
  fs.writeFileSync(out, 'stale pptx');
  fs.writeFileSync(path.join(slides, '01-good.html'), `<!doctype html>
    <html><head><style>html,body{width:1280px;height:720px;margin:0;overflow:hidden;}p{font-size:32px;margin:96px;}</style></head>
    <body><p>Good slide</p></body></html>`);
  fs.writeFileSync(path.join(slides, '02-bad.html'), `<!doctype html>
    <html><head><style>html,body{width:640px;height:360px;margin:0;overflow:hidden;}p{font-size:32px;margin:48px;}</style></head>
    <body><p>Bad dimensions</p></body></html>`);

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts/export_deck_pptx.mjs'),
      '--slides', slides,
      '--out', out,
    ], { cwd: ROOT, encoding: 'utf8' });

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(out), false, 'stale PPTX output should be removed on partial failure');
    assert.match(result.stderr, /部分失败|partial|转换失败/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('critical export source invariants stay fail-closed', () => {
  const renderVideo = read('scripts/render-video.js');
  const seek = read('scripts/render-video-seek.js');
  const thumbs = read('scripts/gen_deck_thumbs.mjs');
  const mix = read('scripts/mix-voiceover.sh');

  for (const source of [renderVideo, seek]) {
    const hideCss = source.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/)?.[1] || '';
    assert.doesNotMatch(hideCss, /\.title|\.kicker|\.masthead|\.footer/);
    assert.match(source, /waitForFunction\([\s\S]*?null,[\s\S]*?\{\s*timeout:/);
  }

  assert.match(seek, /__seekRenderReady === true/);
  assert.match(seek, /Math\.max\(1,\s*Math\.ceil\(FPS \* DURATION\)\)/);
  assert.match(seek, /pngCount !== TOTAL_FRAMES/);
  assert.match(seek, /fs\.rmSync\(MP4_OUT,\s*\{\s*force:\s*true\s*\}\)/);

  assert.match(thumbs, /failures\.push/);
  assert.match(thumbs, /fs\.rmSync\(out,\s*\{\s*force:\s*true\s*\}\)/);
  assert.match(thumbs, /process\.exit\(1\)/);

  assert.match(mix, /asplit=2\[voice_sc\]\[voice_mix\]/);
  assert.doesNotMatch(mix, /afade=t=out:st=0/);
});
