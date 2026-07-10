import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function tmpDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `huashu-${name}-`));
}

function writeFile(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, NODE_PATH: path.join(root, 'node_modules') },
    ...options,
  });
}

test('deck gallery falls back to grid when manifest lacks thumbnails', { timeout: 30_000 }, async () => {
  const dir = tmpDir('deck-gallery');
  try {
    const slidesDir = path.join(dir, 'slides');
    fs.mkdirSync(slidesDir, { recursive: true });
    const items = [];
    for (let i = 1; i <= 8; i++) {
      const file = `${String(i).padStart(2, '0')}.html`;
      writeFile(path.join(slidesDir, file), `<!doctype html><body style="margin:0;background:#fff"><h1>Slide ${i}</h1></body>`);
      items.push(`    { file: "slides/${file}", label: "Slide ${i}" }`);
    }

    const source = fs.readFileSync(path.join(root, 'assets/deck_index.html'), 'utf8');
    const html = source.replace(
      /window\.DECK_MANIFEST = \[[\s\S]*?\];/,
      `window.DECK_MANIFEST = [\n${items.join(',\n')}\n  ];`,
    );
    const index = path.join(dir, 'index.html');
    writeFile(index, html);

    const browser = await chromium.launch();
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`file://${index}?ov=gallery`, { waitUntil: 'load' });
    await page.waitForFunction(() =>
      document.body.dataset.ov === 'grid' && document.querySelectorAll('#wall iframe').length === 8,
    );
    const state = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#wall iframe').length,
    }));
    await browser.close();

    assert.deepEqual(state, { ov: 'grid', galleryIframes: 0, gridIframes: 8 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('gen_deck_thumbs fails closed and removes stale thumbnail on conversion failure', { timeout: 30_000 }, () => {
  const dir = tmpDir('thumbs');
  try {
    const slides = path.join(dir, 'slides');
    const out = path.join(dir, 'thumbs');
    writeFile(path.join(slides, '01.html'), '<!doctype html><body style="margin:0;background:#fff">ok</body>');
    writeFile(path.join(out, '01.jpg'), 'stale');

    const result = runNode([
      path.join(root, 'scripts/gen_deck_thumbs.mjs'),
      '--slides', slides,
      '--out', out,
      '--width', '0',
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(path.join(out, '01.jpg')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('export_deck_pptx removes stale output when any slide conversion fails', { timeout: 60_000 }, () => {
  const dir = tmpDir('pptx');
  try {
    const slides = path.join(dir, 'slides');
    const out = path.join(dir, 'deck.pptx');
    writeFile(path.join(slides, '01-good.html'), `<!doctype html>
      <html><head><style>html,body{margin:0;width:1280px;height:720px;background:#fff}p{position:absolute;left:80px;top:80px;font-size:32px}</style></head>
      <body><p>Valid slide</p></body></html>`);
    writeFile(path.join(slides, '02-bad.html'), `<!doctype html>
      <html><head><style>html,body{margin:0;width:1280px;height:720px;background:linear-gradient(red, blue)}</style></head>
      <body><p>Invalid slide</p></body></html>`);
    writeFile(out, 'stale');

    const result = runNode([
      path.join(root, 'scripts/export_deck_pptx.mjs'),
      '--slides', slides,
      '--out', out,
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(out), false);
    assert.match(result.stderr, /默认不生成部分 PPTX|全部失败/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seek renderer rejects non-frozen handshakes and removes stale mp4', { timeout: 30_000 }, () => {
  const dir = tmpDir('seek-bad');
  try {
    const html = path.join(dir, 'bad.html');
    const stale = path.join(dir, 'bad.mp4');
    writeFile(html, `<!doctype html><body><script>
      window.__ready = true;
      window.__seek = () => {};
    </script></body>`);
    writeFile(stale, 'stale');

    const result = runNode([
      path.join(root, 'scripts/render-video-seek.js'),
      html,
      '--duration=0.01',
      '--fps=1',
      '--width=64',
      '--height=64',
      '--concurrency=1',
      '--readytimeout=0.2',
    ]);

    assert.notEqual(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(stale), false);
    assert.match(result.stderr, /__seekRenderReady|waiting failed|Timeout/i);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('seek renderer captures at least one frame for zero-duration valid seek pages', { timeout: 30_000 }, () => {
  const dir = tmpDir('seek-good');
  try {
    const html = path.join(dir, 'good.html');
    const mp4 = path.join(dir, 'good.mp4');
    writeFile(html, `<!doctype html><html><body style="margin:0;background:#123;color:#fff"><div id="t">0</div><script>
      window.__ready = true;
      if (window.__seekRender) {
        window.__seekRenderReady = true;
        window.__seek = (t) => {
          document.getElementById('t').textContent = String(t);
          document.body.style.background = '#204060';
        };
      }
    </script></body></html>`);

    const result = runNode([
      path.join(root, 'scripts/render-video-seek.js'),
      html,
      '--duration=0',
      '--fps=60',
      '--width=64',
      '--height=64',
      '--concurrency=1',
      '--readytimeout=1',
    ]);

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(mp4), true);
    assert.ok(fs.statSync(mp4).size > 0);
    assert.match(result.stdout, /Captured 1\/1 frames/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('video chrome hiding does not target generic content class names', () => {
  for (const script of ['render-video.js', 'render-video-seek.js']) {
    const source = fs.readFileSync(path.join(root, 'scripts', script), 'utf8');
    assert.equal(source.includes('.masthead, .kicker, .title'), false, script);
    assert.equal(source.includes('.footer,'), false, script);
  }
});

test('mix-voiceover ducking preserves full video length and audible audio after first second', { timeout: 60_000 }, () => {
  const dir = tmpDir('mix');
  try {
    const video = path.join(dir, 'video.mp4');
    const voice = path.join(dir, 'voice.mp3');
    const bgm = path.join(dir, 'bgm.mp3');
    const out = path.join(dir, 'out.mp4');

    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'testsrc=size=64x64:rate=25:duration=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=0.3', '-q:a', '9', voice], { stdio: 'ignore' });
    execFileSync('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3', '-q:a', '9', bgm], { stdio: 'ignore' });

    const result = spawnSync('bash', [
      path.join(root, 'scripts/mix-voiceover.sh'),
      video,
      `--voiceover=${voice}`,
      `--bgm=${bgm}`,
      `--out=${out}`,
    ], { cwd: root, encoding: 'utf8' });

    assert.equal(result.status, 0, result.stdout + result.stderr);
    const duration = Number(execFileSync('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      out,
    ], { encoding: 'utf8' }).trim());
    assert.ok(duration > 2.8 && duration < 3.3, `duration=${duration}`);

    const probe = spawnSync('ffmpeg', ['-v', 'info', '-ss', '1', '-t', '0.4', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stdout + probe.stderr);
    assert.match(probe.stderr, /max_volume: -?\d+(\.\d+)? dB/);
    assert.doesNotMatch(probe.stderr, /max_volume: -inf dB/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
