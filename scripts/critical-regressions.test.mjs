import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fssync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const NODE_PATH = process.env.NODE_PATH || execFileSync('npm', ['root'], { cwd: ROOT, encoding: 'utf8' }).trim();

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH },
    ...options,
  });
  assert.equal(
    result.status,
    0,
    `${cmd} ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

async function makeTempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function writeDeckIndexFixture(tmpDir, deck) {
  const template = await fs.readFile(path.join(ROOT, 'assets', 'deck_index.html'), 'utf8');
  const html = template.replace(
    /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
    `window.DECK_MANIFEST = ${JSON.stringify(deck, null, 2)};`,
  );
  await fs.writeFile(path.join(tmpDir, 'index.html'), html);
}

test('deck gallery falls back to grid when manifest thumbnails are incomplete', { timeout: 30000 }, async () => {
  const tmp = await makeTempDir('huashu-deck-gallery-');
  const slidesDir = path.join(tmp, 'slides');
  await fs.mkdir(slidesDir);
  const deck = [];
  for (let i = 1; i <= 18; i++) {
    const file = `slides/${String(i).padStart(2, '0')}.html`;
    deck.push({ file, label: `Slide ${i}` });
    await fs.writeFile(path.join(tmp, file), '<!doctype html><html><body>slide</body></html>');
  }
  await writeDeckIndexFixture(tmp, deck);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`file://${path.join(tmp, 'index.html')}?ov=gallery`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.getAttribute('data-mode') === 'overview');
    assert.equal(await page.locator('body').getAttribute('data-ov'), 'grid');
    assert.equal(await page.locator('#gallery iframe').count(), 0);
    assert.equal(await page.locator('#wall iframe').count(), deck.length);
  } finally {
    await browser.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('deck hash navigation clamps to valid slide numbers', { timeout: 30000 }, async () => {
  const tmp = await makeTempDir('huashu-deck-hash-');
  const slidesDir = path.join(tmp, 'slides');
  await fs.mkdir(slidesDir);
  const deck = [
    { file: 'slides/01.html', label: 'One' },
    { file: 'slides/02.html', label: 'Two' },
  ];
  for (const item of deck) {
    await fs.writeFile(path.join(tmp, item.file), `<!doctype html><html><body>${item.label}</body></html>`);
  }
  await writeDeckIndexFixture(tmp, deck);

  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`file://${path.join(tmp, 'index.html')}#99`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.getAttribute('data-mode') === 'present');
    await page.waitForFunction(() => document.getElementById('frame').getAttribute('src').endsWith('slides/02.html'));
    assert.match(await page.locator('#counter').innerText(), /^2 \/ 2/);

    await page.goto(`file://${path.join(tmp, 'index.html')}#0`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.getAttribute('data-mode') === 'present');
    await page.waitForFunction(() => document.getElementById('frame').getAttribute('src').endsWith('slides/01.html'));
    assert.match(await page.locator('#counter').innerText(), /^1 \/ 2/);
  } finally {
    await browser.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('PPTX export fails closed when any slide conversion fails', { timeout: 60000 }, async () => {
  const tmp = await makeTempDir('huashu-pptx-partial-');
  const slidesDir = path.join(tmp, 'slides');
  await fs.mkdir(slidesDir);
  await fs.writeFile(path.join(slidesDir, '01-good.html'), '<!doctype html><html><body style="width:1280px;height:720px;margin:0;background:#fff"></body></html>');
  await fs.writeFile(path.join(slidesDir, '02-bad.html'), '<!doctype html><html><body style="width:640px;height:360px;margin:0;background:#fff"></body></html>');
  const out = path.join(tmp, 'deck.pptx');
  await fs.writeFile(out, 'stale output');

  try {
    const result = spawnSync(process.execPath, [
      path.join(ROOT, 'scripts', 'export_deck_pptx.mjs'),
      '--slides', slidesDir,
      '--out', out,
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_PATH },
    });

    assert.notEqual(result.status, 0, `export unexpectedly succeeded\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stderr, /默认不生成缺页 PPTX|全部失败/);
    assert.equal(fssync.existsSync(out), false, 'stale or partial PPTX output should be removed');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('seek renderer keeps fail-closed frame and handshake safeguards', async () => {
  const source = await fs.readFile(path.join(ROOT, 'scripts', 'render-video-seek.js'), 'utf8');
  assert.match(source, /window\.__seekRenderReady === true/);
  assert.match(source, /page\.waitForFunction\([\s\S]*\n\s*null,\n\s*\{ timeout: READY_TIMEOUT \* 1000 \}/);
  assert.match(source, /pngCount !== TOTAL_FRAMES/);
  assert.match(source, /'-start_number', '0'/);
  assert.doesNotMatch(source, /(?:^|\s)\.(?:masthead|kicker|title|footer)\b/);
});

test('voiceover mixing preserves video length and audible tail with ducking', { timeout: 60000 }, async () => {
  const tmp = await makeTempDir('huashu-voice-mix-');
  const video = path.join(tmp, 'video.mp4');
  const voice = path.join(tmp, 'voice.wav');
  const bgm = path.join(tmp, 'bgm.wav');
  const out = path.join(tmp, 'mixed.mp4');

  try {
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.6', '-c:a', 'pcm_s16le', voice]);
    run('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=2', '-c:a', 'pcm_s16le', bgm]);
    run('bash', [path.join(ROOT, 'scripts', 'mix-voiceover.sh'), video, `--voiceover=${voice}`, `--bgm=${bgm}`, `--out=${out}`]);

    const duration = parseFloat(run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      out,
    ]).stdout.trim());
    assert.ok(duration > 1.8 && duration < 2.2, `expected output near 2s, got ${duration}`);

    const volumeProbe = spawnSync('ffmpeg', ['-v', 'info', '-ss', '1.1', '-t', '0.3', '-i', out, '-vn', '-af', 'volumedetect', '-f', 'null', '-'], {
      cwd: ROOT,
      encoding: 'utf8',
    });
    assert.equal(volumeProbe.status, 0, volumeProbe.stderr);
    const match = volumeProbe.stderr.match(/mean_volume:\s*(-?\d+(?:\.\d+)?) dB/);
    assert.ok(match, volumeProbe.stderr);
    assert.ok(parseFloat(match[1]) > -45, `expected audible audio tail, got ${match[1]} dB`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
