import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NODE_PATH = execFileSync('npm', ['root'], { cwd: ROOT, encoding: 'utf8' }).trim();
const env = { ...process.env, NODE_PATH };

function tempDir(name) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `huashu-${name}-`));
}

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env,
    ...options,
  });
}

test('deck gallery falls back to grid when manifest lacks complete thumbs', async () => {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    await page.goto(`file://${path.join(ROOT, 'assets/deck_index.html')}?ov=gallery`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.body.dataset.mode === 'overview');
    await page.waitForTimeout(100);

    const overview = await page.evaluate(() => ({
      ov: document.body.dataset.ov,
      hash: location.hash,
      galleryCards: document.querySelectorAll('#ov-gallery .card').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
      gridIframes: document.querySelectorAll('#wall iframe').length,
    }));

    assert.equal(overview.ov, 'grid');
    assert.equal(overview.hash, '');
    assert.equal(overview.galleryCards, 0);
    assert.equal(overview.galleryIframes, 0);
    assert.ok(overview.gridIframes > 0, 'grid overview still renders slide iframes');

    await page.click('#startBtn');
    await page.waitForFunction(() => document.body.dataset.mode === 'present');
    const present = await page.evaluate(() => ({
      wallIframes: document.querySelectorAll('#wall iframe').length,
      galleryIframes: document.querySelectorAll('#ov-gallery iframe').length,
    }));
    assert.equal(present.wallIframes, 0);
    assert.equal(present.galleryIframes, 0);
  } finally {
    await browser.close();
  }
});

test('gen_deck_thumbs fails closed and deletes stale slide thumbnails', () => {
  const dir = tempDir('thumbs');
  const slides = path.join(dir, 'slides');
  const thumbs = path.join(dir, 'thumbs');
  fs.mkdirSync(slides);
  fs.mkdirSync(thumbs);
  fs.writeFileSync(path.join(slides, '01.html'), '<!doctype html><body style="margin:0;width:1920px;height:1080px;background:#fff"></body>');
  const stale = path.join(thumbs, '01.jpg');
  fs.writeFileSync(stale, 'stale');

  const result = runNode([
    'scripts/gen_deck_thumbs.mjs',
    '--slides', slides,
    '--out', thumbs,
    '--width', '0',
  ]);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(stale), false);
});

test('export_deck_pptx refuses partial output by default and removes stale pptx', () => {
  const dir = tempDir('pptx');
  const slides = path.join(dir, 'slides');
  fs.mkdirSync(slides);
  fs.writeFileSync(path.join(slides, '01-valid.html'), `<!doctype html>
<html><head><style>
html,body{margin:0;width:1280px;height:720px;overflow:hidden;font-family:Arial,sans-serif;}
h1{position:absolute;left:100px;top:100px;margin:0;font-size:48px;}
</style></head><body><h1>Valid</h1></body></html>`);
  fs.writeFileSync(path.join(slides, '02-invalid.html'), `<!doctype html>
<html><head><style>
html,body{margin:0;width:1280px;height:720px;overflow:hidden;background:linear-gradient(red,blue);}
</style></head><body><h1>Invalid</h1></body></html>`);
  const out = path.join(dir, 'deck.pptx');
  fs.writeFileSync(out, 'stale');

  const result = runNode(['scripts/export_deck_pptx.mjs', '--slides', slides, '--out', out]);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(out), false);
  assert.match(result.stderr, /不完整|失败/);
});

test('render-video chrome hiding does not target common content classes', () => {
  for (const rel of ['scripts/render-video.js', 'scripts/render-video-seek.js']) {
    const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    assert.doesNotMatch(source, /^\s*\.masthead,|^\s*\.kicker,|^\s*\.title,|^\s*\.footer,/m, rel);
  }
});

test('seek renderer rejects non-frozen seek handshake and removes stale mp4', () => {
  const dir = tempDir('seek');
  const html = path.join(dir, 'bad-seek.html');
  fs.writeFileSync(html, `<!doctype html><body style="margin:0;background:#000"><script>
window.__ready = true;
window.__seek = () => {};
</script></body>`);
  const staleMp4 = path.join(dir, 'bad-seek.mp4');
  fs.writeFileSync(staleMp4, 'stale');

  const result = runNode([
    'scripts/render-video-seek.js',
    html,
    '--duration=1',
    '--fps=1',
    '--width=16',
    '--height=16',
    '--readytimeout=0.3',
  ]);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.equal(fs.existsSync(staleMp4), false);
  assert.match(result.stderr, /__seekRenderReady|seek 握手|waiting failed/i);
});

test('narration and ducking scripts preserve local deps and audible tail audio', () => {
  const narration = fs.readFileSync(path.join(ROOT, 'scripts/render-narration.sh'), 'utf8');
  assert.match(narration, /LOCAL_NODE_PATH=.*npm root/);
  assert.doesNotMatch(narration, /npm root -g/);
  assert.doesNotMatch(narration, /\[ -n "\$KEEP_SILENT" \] &&/);

  const mix = fs.readFileSync(path.join(ROOT, 'scripts/mix-voiceover.sh'), 'utf8');
  assert.match(mix, /asplit=2\[voice_sc\]\[voice_mix\]/);
  assert.doesNotMatch(mix, /afade=t=out:st=0(?::|:d=)/);
});
