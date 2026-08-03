import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE = process.execPath;
const NODE_PATH = path.join(ROOT, 'node_modules');

function read(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function run(cmd, args, options = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH, ...(options.env || {}) },
    ...options,
  });
}

async function tmpDir(name) {
  return fsp.mkdtemp(path.join(os.tmpdir(), `huashu-${name}-`));
}

test('deck gallery fails closed when thumbnails are incomplete', () => {
  const html = read('assets/deck_index.html');
  assert.match(html, /const HAS_COMPLETE_THUMBS = deck\.length > 0 && deck\.every\(item => item && item\.thumb\);/);
  assert.match(html, /const EFFECTIVE_OVERVIEW = \(OVERVIEW === 'gallery' && HAS_COMPLETE_THUMBS\) \? 'gallery' : 'grid';/);
  assert.match(html, /document\.body\.setAttribute\('data-ov', EFFECTIVE_OVERVIEW\);/);
  assert.match(html, /if \(EFFECTIVE_OVERVIEW === 'gallery'\) buildGallery\(\); else buildGrid\(\);/);
  assert.match(html, /throw new Error\('Gallery overview requires a thumb for slide '/);
  assert.match(html, /let hasValidHash = false;/);
  assert.match(html, /show\(current, hasValidHash\);/);
});

test('video renderers do not hide common content class names', () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const src = read(rel);
    const css = src.match(/const HIDE_CHROME_CSS = `([\s\S]*?)`;/)?.[1] || '';
    assert.doesNotMatch(css, /\.masthead|\.kicker|\.title|\.footer/);
  }
});

test('seek renderer requires frozen-clock handshake and exact frame output', () => {
  const src = read('scripts/render-video-seek.js');
  assert.match(src, /window\.__seekRenderReady === true/);
  assert.match(src, /page\.waitForFunction\([\s\S]*?null,[\s\S]*?\{ timeout: READY_TIMEOUT \* 1000 \}/);
  assert.match(src, /const TOTAL_FRAMES = Math\.max\(1, Math\.ceil\(FPS \* DURATION\)\);/);
  assert.match(src, /if \(pngCount !== TOTAL_FRAMES\)/);
  assert.match(src, /'-start_number', '0'/);
  assert.match(src, /function cleanupOutputs\(\)/);
});

test('thumbnail generation removes stale output and fails non-zero on per-slide failure', async () => {
  const dir = await tmpDir('thumbs');
  const slides = path.join(dir, 'slides');
  const thumbs = path.join(dir, 'thumbs');
  await fsp.mkdir(slides);
  await fsp.mkdir(thumbs);
  await fsp.writeFile(path.join(slides, '01.html'), '<!doctype html><body style="margin:0;width:1920px;height:1080px;background:#fff"></body>');
  const stale = path.join(thumbs, '01.jpg');
  await fsp.writeFile(stale, 'stale');

  const result = run(NODE, [
    'scripts/gen_deck_thumbs.mjs',
    '--slides', slides,
    '--out', thumbs,
    '--quality', '999',
  ]);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(stale), false);
});

test('PPTX export deletes stale output and fails closed on partial conversion failure', async () => {
  const dir = await tmpDir('pptx');
  const slides = path.join(dir, 'slides');
  const out = path.join(dir, 'deck.pptx');
  await fsp.mkdir(slides);
  await fsp.writeFile(out, 'stale');
  await fsp.writeFile(path.join(slides, '01-good.html'), `<!doctype html>
<html><body style="margin:0;width:1280px;height:720px;background:#fff"><p style="position:absolute;left:40px;top:40px;font-size:24px">OK</p></body></html>`);
  await fsp.writeFile(path.join(slides, '02-bad.html'), `<!doctype html>
<html><body style="margin:0;width:1280px;height:720px;background:#fff"><p style="position:absolute;left:40px;top:680px;font-size:48px">Too low</p></body></html>`);

  const result = run(NODE, ['scripts/export_deck_pptx.mjs', '--slides', slides, '--out', out], { timeout: 60000 });

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(out), false);
});

test('ducking voiceover mix remains audible after the first second', async () => {
  const dir = await tmpDir('mix');
  const video = path.join(dir, 'video.mp4');
  const voice = path.join(dir, 'voice.wav');
  const bgm = path.join(dir, 'bgm.wav');
  const out = path.join(dir, 'out.mp4');

  assert.equal(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=2', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=mono', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-shortest', video]).status, 0);
  assert.equal(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=2', voice]).status, 0);
  assert.equal(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', bgm]).status, 0);

  const mixed = run('bash', ['scripts/mix-voiceover.sh', video, `--voiceover=${voice}`, `--bgm=${bgm}`, `--out=${out}`], { timeout: 60000 });
  assert.equal(mixed.status, 0, mixed.stdout + mixed.stderr);

  const probe = run('ffmpeg', ['-v', 'info', '-ss', '1', '-t', '0.5', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { timeout: 60000 });
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  const mean = (probe.stderr.match(/mean_volume: ([\-\d.]+) dB/) || [])[1];
  assert.ok(mean, probe.stderr);
  assert.ok(Number(mean) > -60, `mean volume too low after 1s: ${mean} dB`);
});
