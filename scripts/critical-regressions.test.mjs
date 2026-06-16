#!/usr/bin/env node
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

async function read(rel) {
  return fs.readFile(path.join(repoRoot, rel), 'utf8');
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    encoding: options.encoding ?? 'utf8',
    stdio: options.stdio,
  });
  assert.equal(
    result.status,
    0,
    `${command} ${args.join(' ')} failed\nSTDOUT:\n${result.stdout || ''}\nSTDERR:\n${result.stderr || ''}`,
  );
  return result;
}

function commandExists(command) {
  return spawnSync(command, ['-version'], { stdio: 'ignore' }).status === 0;
}

function replaceManifest(template, manifest) {
  return template.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`,
  );
}

async function writeDeckFixture(manifest) {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'deck-index-regression-'));
  await fs.mkdir(path.join(tmpDir, 'slides'), { recursive: true });
  await fs.mkdir(path.join(tmpDir, 'thumbs'), { recursive: true });

  for (const item of manifest) {
    await fs.writeFile(
      path.join(tmpDir, item.file),
      '<!doctype html><html><body style="margin:0;background:#fff"><h1>slide</h1></body></html>',
    );
    if (item.thumb) {
      await fs.writeFile(path.join(tmpDir, item.thumb), '');
    }
  }

  const template = await read('assets/deck_index.html');
  const html = replaceManifest(template, manifest);
  const indexPath = path.join(tmpDir, 'index.html');
  await fs.writeFile(indexPath, html);
  return { tmpDir, indexPath };
}

test('deck_index falls back to grid when forced gallery lacks complete thumbnails', async () => {
  const manifest = Array.from({ length: 13 }, (_, i) => ({
    file: `slides/${String(i + 1).padStart(2, '0')}.html`,
    label: `Slide ${i + 1}`,
  }));
  const { tmpDir, indexPath } = await writeDeckFixture(manifest);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${pathToFileURL(indexPath).href}?ov=gallery`);
    await page.waitForFunction(() => document.body.getAttribute('data-mode') === 'overview');

    const state = await page.evaluate(() => ({
      overview: document.body.getAttribute('data-ov'),
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
      wallIframes: document.querySelectorAll('#wall iframe').length,
    }));

    assert.equal(state.overview, 'grid');
    assert.equal(state.galleryIframes, 0);
    assert.equal(state.wallIframes, manifest.length);
  } finally {
    await browser.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('deck_index uses image-only gallery when every slide has a thumbnail', async () => {
  const manifest = Array.from({ length: 6 }, (_, i) => {
    const name = String(i + 1).padStart(2, '0');
    return {
      file: `slides/${name}.html`,
      thumb: `thumbs/${name}.jpg`,
      label: `Slide ${i + 1}`,
    };
  });
  const { tmpDir, indexPath } = await writeDeckFixture(manifest);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${pathToFileURL(indexPath).href}?ov=gallery`);
    await page.waitForSelector('#gallery .card');

    const state = await page.evaluate(() => ({
      overview: document.body.getAttribute('data-ov'),
      galleryIframes: document.querySelectorAll('#gallery iframe').length,
      galleryImages: document.querySelectorAll('#gallery img.thumb-img').length,
    }));

    assert.equal(state.overview, 'gallery');
    assert.equal(state.galleryIframes, 0);
    assert.ok(state.galleryImages > manifest.length, 'gallery should tile reusable thumbnail images');
  } finally {
    await browser.close();
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('render-video-seek refuses incomplete frame sequences', async () => {
  const src = await read('scripts/render-video-seek.js');
  assert.match(src, /pngCount !== TOTAL_FRAMES/);
  assert.match(src, /cleanupOutputs\(\);[\s\S]*?process\.exit\(1\);/);
  assert.match(src, /'-start_number', '0'/);
});

test('export_deck_pptx refuses partial PPTX output', async () => {
  const src = await read('scripts/export_deck_pptx.mjs');
  assert.match(src, /不生成不完整 PPTX/);
  assert.match(src, /await fs\.rm\(outFile, \{ force: true \}\);/);
  assert.doesNotMatch(src, /errors\.length === files\.length/);
});

test('mix-voiceover ducking keeps audio audible after the first second', { skip: !commandExists('ffmpeg') || !commandExists('ffprobe') }, async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mix-voiceover-regression-'));
  const video = path.join(tmpDir, 'video.mp4');
  const voice = path.join(tmpDir, 'voice.wav');
  const bgm = path.join(tmpDir, 'bgm.wav');
  const out = path.join(tmpDir, 'out.mp4');

  try {
    run('ffmpeg', [
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=16x16:d=2:r=30',
      '-an',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      video,
    ]);
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', voice]);
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', bgm]);
    run('bash', [
      path.join(repoRoot, 'scripts/mix-voiceover.sh'),
      video,
      `--voiceover=${voice}`,
      `--bgm=${bgm}`,
      `--out=${out}`,
    ]);

    const probe = run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      out,
    ]);
    const duration = Number.parseFloat(probe.stdout);
    assert.ok(duration > 1.8 && duration < 2.2, `expected output duration near 2s, got ${duration}`);

    const audio = spawnSync('ffmpeg', [
      '-v', 'error',
      '-ss', '1.0',
      '-t', '0.25',
      '-i', out,
      '-f', 'f32le',
      '-ac', '1',
      '-',
    ], { encoding: null });
    assert.equal(audio.status, 0, audio.stderr?.toString() || '');

    let sumSquares = 0;
    const samples = audio.stdout.length / 4;
    for (let i = 0; i < audio.stdout.length; i += 4) {
      const sample = audio.stdout.readFloatLE(i);
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / samples);
    assert.ok(rms > 0.005, `audio should remain audible after 1s, got RMS=${rms}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
