import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function run(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    timeout: 120_000,
    ...options,
    env: {
      ...process.env,
      NODE_PATH: path.join(repoRoot, 'node_modules'),
      ...(options.env || {})
    }
  });
}

function assertOk(result, label) {
  assert.equal(result.status, 0, `${label}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
}

function hasCommand(command) {
  return spawnSync('bash', ['-lc', `command -v ${command}`], { encoding: 'utf8' }).status === 0;
}

function ffprobeDuration(file) {
  const result = run('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    file
  ]);
  assertOk(result, `ffprobe duration ${file}`);
  return Number.parseFloat(result.stdout.trim());
}

test('deck_index falls back to grid when gallery lacks complete thumbs', async (t) => {
  const { chromium } = await import('playwright');
  const tmp = tempDir('deck-index-regression-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const slidesDir = path.join(tmp, 'slides');
  fs.mkdirSync(slidesDir);
  const manifest = [];
  for (let i = 1; i <= 12; i++) {
    const file = `${String(i).padStart(2, '0')}.html`;
    fs.writeFileSync(
      path.join(slidesDir, file),
      `<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:#fff"><h1>Slide ${i}</h1></body></html>`
    );
    manifest.push({ file: `slides/${file}`, label: `Slide ${i}` });
  }

  const template = fs.readFileSync(path.join(repoRoot, 'assets/deck_index.html'), 'utf8');
  const html = template.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\n  \];/,
    `window.DECK_MANIFEST = ${JSON.stringify(manifest, null, 2)};`
  );
  const indexFile = path.join(tmp, 'index.html');
  fs.writeFileSync(indexFile, html);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`file://${indexFile}?ov=gallery`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.getAttribute('data-ov'));

    assert.equal(await page.getAttribute('body', 'data-ov'), 'grid');
    assert.equal(await page.locator('#wall iframe').count(), manifest.length);
    assert.equal(await page.locator('#gallery iframe').count(), 0);
  } finally {
    await browser.close();
  }
});

test('export_deck_pptx fails closed and removes stale output on partial conversion', (t) => {
  const tmp = tempDir('pptx-partial-regression-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const slidesDir = path.join(tmp, 'slides');
  fs.mkdirSync(slidesDir);
  fs.writeFileSync(path.join(slidesDir, '01-good.html'), `<!doctype html>
<html><head><style>
html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:white;font-family:Arial,sans-serif}
p{position:absolute;left:96px;top:96px;font-size:32px;color:#111}
</style></head><body><p>Editable slide</p></body></html>`);
  fs.writeFileSync(path.join(slidesDir, '02-bad.html'), `<!doctype html>
<html><head><style>html,body{margin:0;width:1280px;height:720px;overflow:hidden}</style></head><body><div>Unwrapped text breaks PPTX conversion</div></body></html>`);

  const out = path.join(tmp, 'deck.pptx');
  fs.writeFileSync(out, 'stale output');

  const result = run(process.execPath, ['scripts/export_deck_pptx.mjs', '--slides', slidesDir, '--out', out]);
  assert.notEqual(result.status, 0, `export should fail on partial conversion\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stderr, /默认不生成部分 PPTX/);
  assert.equal(fs.existsSync(out), false);
});

test('gen_deck_thumbs exits non-zero on incomplete thumbnail generation', (t) => {
  const tmp = tempDir('thumbs-regression-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const slidesDir = path.join(tmp, 'slides');
  const outDir = path.join(tmp, 'thumbs');
  fs.mkdirSync(slidesDir);
  fs.writeFileSync(path.join(slidesDir, '01-good.html'), '<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:#fff">ok</body></html>');
  fs.symlinkSync('missing-target.html', path.join(slidesDir, '02-missing.html'));

  const result = run(process.execPath, ['scripts/gen_deck_thumbs.mjs', '--slides', slidesDir, '--out', outDir, '--width', '320']);
  assert.notEqual(result.status, 0, `thumbnail generation should fail when any page fails\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  assert.match(result.stderr, /缩略图生成不完整/);
  assert.equal(fs.existsSync(path.join(outDir, '01-good.jpg')), true);
  assert.equal(fs.existsSync(path.join(outDir, '02-missing.jpg')), false);
});

test('mix-voiceover preserves video duration and keeps BGM audible after short voiceover', (t) => {
  if (!hasCommand('ffmpeg') || !hasCommand('ffprobe')) {
    t.skip('ffmpeg/ffprobe not installed');
    return;
  }

  const tmp = tempDir('mix-voiceover-regression-');
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));

  const video = path.join(tmp, 'video.mp4');
  const voice = path.join(tmp, 'voice.wav');
  const bgm = path.join(tmp, 'bgm.wav');
  const out = path.join(tmp, 'mixed.mp4');

  assertOk(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]), 'create test video');
  assertOk(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=1000:duration=0.3', voice]), 'create short voiceover');
  assertOk(run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=1.0', bgm]), 'create bgm');

  const mix = run('bash', ['scripts/mix-voiceover.sh', video, `--voiceover=${voice}`, `--bgm=${bgm}`, `--out=${out}`]);
  assertOk(mix, 'mix voiceover');

  const duration = ffprobeDuration(out);
  assert.ok(duration > 1.8 && duration < 2.3, `expected output near 2s, got ${duration}s`);

  const volume = run('ffmpeg', ['-hide_banner', '-nostats', '-ss', '1.0', '-t', '0.4', '-i', out, '-af', 'volumedetect', '-f', 'null', '-']);
  assertOk(volume, 'measure trailing audio');
  const match = volume.stderr.match(/mean_volume:\s*(-?(?:\d+(?:\.\d+)?|inf)) dB/);
  assert.ok(match, `missing mean_volume in ffmpeg output:\n${volume.stderr}`);
  assert.notEqual(match[1], '-inf', `trailing audio is silent:\n${volume.stderr}`);
  assert.ok(Number.parseFloat(match[1]) > -55, `trailing audio unexpectedly quiet:\n${volume.stderr}`);
});
