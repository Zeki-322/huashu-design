import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_PATH = execFileSync('npm', ['root'], { cwd: ROOT, encoding: 'utf8' }).trim();

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `huashu-${name}-`));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH, ...(options.env || {}) },
    ...options,
  });
}

function requireTool(t, command, args = ['-version']) {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) t.skip(`${command} is not available`);
}

function ffprobeDuration(file) {
  const result = spawnSync('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return Number(result.stdout.trim());
}

test('deck_index falls back to grid when gallery is requested without thumbs', async (t) => {
  requireTool(t, 'ffmpeg');
  const dir = tmpDir('deck-gallery-');
  const slidesDir = path.join(dir, 'slides');
  fs.mkdirSync(slidesDir);
  const manifest = [];
  for (let i = 1; i <= 14; i++) {
    const file = `slides/${String(i).padStart(2, '0')}.html`;
    fs.writeFileSync(path.join(dir, file), `<!doctype html><title>${i}</title><body>${i}</body>`);
    manifest.push({ file, label: `Slide ${i}` });
  }

  const template = fs.readFileSync(path.join(ROOT, 'assets/deck_index.html'), 'utf8');
  const html = template.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest)};`,
  );
  const index = path.join(dir, 'index.html');
  fs.writeFileSync(index, html);

  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await page.goto(`file://${index}?ov=gallery`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.body.dataset.ov === 'grid');
  const counts = await page.evaluate(() => ({
    mode: document.body.dataset.ov,
    gridIframes: document.querySelectorAll('#ov-grid iframe').length,
    galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
  }));
  assert.deepEqual(counts, { mode: 'grid', gridIframes: manifest.length, galleryIframes: 0 });
});

test('video chrome hiding avoids generic content class names', () => {
  for (const file of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
    assert.equal(source.includes('.title,'), false, `${file} must not hide normal .title content`);
    assert.equal(source.includes('.kicker,'), false, `${file} must not hide normal .kicker content`);
    assert.equal(source.includes('.masthead,'), false, `${file} must not hide normal .masthead content`);
    assert.equal(source.includes('.footer,'), false, `${file} must not hide normal .footer content`);
  }
});

test('seek renderer rejects non-frozen __seek implementations and leaves no stale mp4', (t) => {
  requireTool(t, 'ffmpeg');
  const dir = tmpDir('seek-handshake-');
  const html = path.join(dir, 'bad.html');
  const mp4 = path.join(dir, 'bad.mp4');
  fs.writeFileSync(html, `<!doctype html>
    <body style="margin:0;background:#000"></body>
    <script>
      window.__ready = true;
      window.__seek = function () {};
    </script>`);
  fs.writeFileSync(mp4, 'stale');

  const result = run(process.execPath, [
    path.join(ROOT, 'scripts/render-video-seek.js'),
    html,
    '--duration=1',
    '--fps=1',
    '--width=64',
    '--height=64',
    '--concurrency=1',
    '--readytimeout=0.2',
  ]);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(mp4), false, 'failed seek render should remove stale output');
  assert.match(result.stderr + result.stdout, /seek-render|__seekRenderReady|握手/);
});

test('seek renderer fails closed on missing frames before encoding', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/render-video-seek.js'), 'utf8');
  assert.match(source, /pngCount !== TOTAL_FRAMES/);
  assert.match(source, /'-start_number', '0'/);
  assert.match(source, /window\.__seekRenderReady === true/);
});

test('mix-voiceover preserves video duration when voiceover is shorter', (t) => {
  requireTool(t, 'ffmpeg');
  requireTool(t, 'ffprobe');
  const dir = tmpDir('mix-duration-');
  const video = path.join(dir, 'video.mp4');
  const voice = path.join(dir, 'voice.mp3');
  const out = path.join(dir, 'out.mp4');

  assert.equal(run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:d=2:r=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
  ]).status, 0);
  assert.equal(run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.5',
    '-q:a', '9', voice,
  ]).status, 0);

  const result = run('bash', [
    path.join(ROOT, 'scripts/mix-voiceover.sh'),
    video,
    `--voiceover=${voice}`,
    `--out=${out}`,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.ok(ffprobeDuration(out) >= 1.9, 'mixed output must not be truncated to short voiceover');
});

test('ducking mix keeps audible audio after the first second', (t) => {
  requireTool(t, 'ffmpeg');
  const dir = tmpDir('mix-ducking-');
  const video = path.join(dir, 'video.mp4');
  const voice = path.join(dir, 'voice.mp3');
  const bgm = path.join(dir, 'bgm.mp3');
  const out = path.join(dir, 'out.mp4');

  assert.equal(run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=64x64:d=2:r=10',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video,
  ]).status, 0);
  assert.equal(run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=800:duration=2',
    '-q:a', '9', voice,
  ]).status, 0);
  assert.equal(run('ffmpeg', [
    '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2',
    '-q:a', '9', bgm,
  ]).status, 0);

  const result = run('bash', [
    path.join(ROOT, 'scripts/mix-voiceover.sh'),
    video,
    `--voiceover=${voice}`,
    `--bgm=${bgm}`,
    `--out=${out}`,
  ]);
  assert.equal(result.status, 0, result.stdout + result.stderr);

  const probe = run('ffmpeg', [
    '-v', 'info',
    '-ss', '1.0',
    '-t', '0.3',
    '-i', out,
    '-map', '0:a:0',
    '-af', 'volumedetect',
    '-f', 'null',
    '-',
  ]);
  assert.equal(probe.status, 0, probe.stdout + probe.stderr);
  const match = (probe.stderr + probe.stdout).match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
  assert.ok(match, 'volumedetect should report mean_volume');
  assert.ok(Number(match[1]) > -60, `audio after 1s should not be faded to silence: ${match[1]} dB`);
});

test('partial PPTX exports require an explicit opt-in', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts/export_deck_pptx.mjs'), 'utf8');
  assert.match(source, /allow-partial/);
  assert.match(source, /if \(!allowPartial\) \{[\s\S]*?process\.exit\(1\);[\s\S]*?\}\s*\}\s*await pres\.writeFile/);
});
