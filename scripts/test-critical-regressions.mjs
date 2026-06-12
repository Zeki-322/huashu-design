#!/usr/bin/env node
import assert from 'assert/strict';
import { spawnSync } from 'child_process';
import fs from 'fs';
import fsp from 'fs/promises';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

async function testDeckGalleryDoesNotFallbackToIframes() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'deck-index-regression-'));
  const slideDir = path.join(tmp, 'slides');
  await fsp.mkdir(slideDir);

  const count = 12;
  for (let i = 1; i <= count; i++) {
    await fsp.writeFile(
      path.join(slideDir, `${String(i).padStart(2, '0')}.html`),
      '<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:white"></body></html>',
    );
  }

  const manifest = Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    return `    { file: "slides/${n}.html", label: "Slide ${n}" }`;
  }).join(',\n');

  let index = await fsp.readFile(path.join(root, 'assets/deck_index.html'), 'utf8');
  index = index.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\n  \];/,
    `window.DECK_MANIFEST = [\n${manifest}\n  ];`,
  );
  index = index.replace(
    '  // window.DECK_OVERVIEW = \'grid\';  // 取消注释可固定概览模式',
    '  window.DECK_OVERVIEW = \'gallery\';',
  );
  await fsp.writeFile(path.join(tmp, 'index.html'), index);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto('file://' + path.join(tmp, 'index.html'), { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    const state = await page.evaluate(() => ({
      overview: document.body.dataset.ov,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#ov-grid iframe').length,
      gridCards: document.querySelectorAll('#wall .card').length,
    }));

    assert.equal(state.overview, 'grid');
    assert.equal(state.galleryIframes, 0);
    assert.equal(state.gridIframes, count);
    assert.equal(state.gridCards, count);
  } finally {
    await browser.close();
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function testPptxPartialFailureDoesNotWriteOutput() {
  const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), 'pptx-regression-'));
  const slides = path.join(tmp, 'slides');
  const out = path.join(tmp, 'out.pptx');
  await fsp.mkdir(slides);
  await fsp.writeFile(out, 'stale output');

  await fsp.writeFile(path.join(slides, '01-valid.html'), `<!doctype html>
<html><head><style>
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: #fff; }
p { position: absolute; left: 96px; top: 96px; margin: 0; font-size: 28px; color: #111; }
</style></head><body><p>Valid slide</p></body></html>`);

  await fsp.writeFile(path.join(slides, '02-invalid.html'), `<!doctype html>
<html><head><style>
html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; background: linear-gradient(90deg, #fff, #000); }
p { position: absolute; left: 96px; top: 96px; margin: 0; font-size: 28px; color: #111; }
</style></head><body><p>Invalid slide</p></body></html>`);

  try {
    const result = spawnSync(
      process.execPath,
      [path.join(root, 'scripts/export_deck_pptx.mjs'), '--slides', slides, '--out', out],
      { encoding: 'utf8' },
    );

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stderr, /不生成 PPTX/);
    assert.equal(fs.existsSync(out), false, 'partial conversion must not leave stale or incomplete PPTX output');
  } finally {
    await fsp.rm(tmp, { recursive: true, force: true });
  }
}

async function testVideoExportSafeguards() {
  const renderVideo = await fsp.readFile(path.join(root, 'scripts/render-video.js'), 'utf8');
  const renderSeek = await fsp.readFile(path.join(root, 'scripts/render-video-seek.js'), 'utf8');
  const cssBlocks = [renderVideo, renderSeek].map(text => {
    const match = text.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/);
    assert.ok(match, 'HIDE_CHROME_CSS block should exist');
    return match[1];
  });

  for (const css of cssBlocks) {
    assert.equal(/\.kicker\b/.test(css), false, 'content class .kicker must not be hidden by default');
    assert.equal(/\.title\b/.test(css), false, 'content class .title must not be hidden by default');
  }

  assert.match(renderSeek, /'-start_number', '0'/, 'ffmpeg image sequence must start at frame-000000');
  assert.match(renderSeek, /pngCount !== TOTAL_FRAMES/, 'seek renderer must fail on incomplete frame sequences');
}

await testDeckGalleryDoesNotFallbackToIframes();
await testPptxPartialFailureDoesNotWriteOutput();
await testVideoExportSafeguards();
console.log('✓ critical regression tests passed');
