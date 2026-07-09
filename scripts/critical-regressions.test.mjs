import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE_PATH = spawnSync('npm', ['root'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim();

async function makeTempDir(prefix) {
  return await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...options,
    env: { ...process.env, NODE_PATH, ...(options.env || {}) },
  });
}

test('deck gallery falls back to grid when manifest lacks thumbnails', async () => {
  const tmp = await makeTempDir('deck-gallery-');
  const slidesDir = path.join(tmp, 'slides');
  await fsp.mkdir(slidesDir);
  const manifest = [];
  for (let i = 1; i <= 18; i++) {
    const name = `${String(i).padStart(2, '0')}.html`;
    manifest.push({ file: `slides/${name}`, label: `Slide ${i}` });
    await fsp.writeFile(path.join(slidesDir, name), `<!doctype html><body><h1>${i}</h1></body>`);
  }

  const source = await fsp.readFile(path.join(ROOT, 'assets/deck_index.html'), 'utf8');
  const html = source.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest)};`,
  );
  const indexPath = path.join(tmp, 'index.html');
  await fsp.writeFile(indexPath, html);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`file://${indexPath}?ov=gallery`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.getAttribute('data-ov') === 'grid');

    assert.equal(await page.locator('#ov-gallery iframe').count(), 0);
    assert.equal(await page.locator('#wall iframe').count(), manifest.length);
  } finally {
    await browser.close();
  }
});

test('ducking mix remains audible after the first second', async () => {
  assert.equal(run('ffmpeg', ['-version']).status, 0, 'ffmpeg must be available');

  const tmp = await makeTempDir('mix-voiceover-');
  const video = path.join(tmp, 'video.mp4');
  const voice = path.join(tmp, 'voice.mp3');
  const bgm = path.join(tmp, 'bgm.mp3');
  const out = path.join(tmp, 'out.mp4');

  assert.equal(run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=3:r=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
    video,
  ]).status, 0);
  assert.equal(run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=700:duration=3',
    '-q:a', '9', '-acodec', 'libmp3lame',
    voice,
  ]).status, 0);
  assert.equal(run('ffmpeg', [
    '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
    '-q:a', '9', '-acodec', 'libmp3lame',
    bgm,
  ]).status, 0);

  const mixed = run('bash', [
    'scripts/mix-voiceover.sh',
    video,
    `--voiceover=${voice}`,
    `--bgm=${bgm}`,
    `--out=${out}`,
  ]);
  assert.equal(mixed.status, 0, mixed.stderr || mixed.stdout);

  const probe = run('ffmpeg', [
    '-ss', '1.2',
    '-t', '0.6',
    '-i', out,
    '-vn',
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ]);
  assert.equal(probe.status, 0, probe.stderr);
  const match = probe.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  assert.ok(match, probe.stderr);
  assert.ok(Number(match[1]) > -45, `audio unexpectedly quiet after 1s: ${match[1]} dB`);
});

test('PPTX export fails closed on partial slide conversion failure', async () => {
  const tmp = await makeTempDir('pptx-fail-closed-');
  const slidesDir = path.join(tmp, 'slides');
  const out = path.join(tmp, 'deck.pptx');
  await fsp.mkdir(slidesDir);
  await fsp.writeFile(path.join(slidesDir, '01-good.html'), `<!doctype html>
<style>body{width:960pt;height:540pt;overflow:hidden;margin:0}</style>
<body><div style="position:absolute;left:60pt;top:60pt"><h1 style="font-size:30pt">Good</h1></div></body>`);
  await fsp.writeFile(path.join(slidesDir, '02-overflow.html'), `<!doctype html>
<style>body{width:960pt;height:540pt;overflow:hidden;margin:0}</style>
<body><div style="position:absolute;left:0;top:0;width:2000pt;height:40pt"><p style="font-size:18pt">Overflow</p></div></body>`);
  await fsp.writeFile(out, 'stale');

  const result = run('node', ['scripts/export_deck_pptx.mjs', '--slides', slidesDir, '--out', out]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(out), false, 'stale/partial PPTX should be removed');
});

test('seek renderer rejects pages without frozen-clock handshake and removes stale MP4', async () => {
  const tmp = await makeTempDir('seek-handshake-');
  const html = path.join(tmp, 'bad.html');
  const mp4 = path.join(tmp, 'bad.mp4');
  await fsp.writeFile(html, `<!doctype html>
<body>bad seek page<script>
window.__ready = true;
window.__seek = function () {};
</script></body>`);
  await fsp.writeFile(mp4, 'stale');

  const result = run('node', [
    'scripts/render-video-seek.js',
    html,
    '--duration=0.01',
    '--fps=1',
    '--readytimeout=0.2',
    '--width=100',
    '--height=100',
    '--keep-chrome',
  ]);
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(mp4), false, 'stale MP4 should be removed on seek-render failure');
});
