import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

function runNode(args, options = {}) {
  return spawnSync(process.execPath, args, {
    cwd: repoRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_PATH: path.join(repoRoot, 'node_modules'),
      ...options.env,
    },
  });
}

function slideHtml(body) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; width: 1280px; height: 720px; overflow: hidden; }
    body { background: #fff; font-family: Arial, sans-serif; }
    h1, p { position: absolute; left: 80px; top: 80px; font-size: 48px; color: #111; }
  </style>
</head>
<body>${body}</body>
</html>`;
}

test('export_deck_pptx removes stale output when any slide fails validation', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-pptx-fail-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const slides = path.join(tmp, 'slides');
  const out = path.join(tmp, 'deck.pptx');
  await fs.mkdir(slides);
  await fs.writeFile(path.join(slides, '01-valid.html'), slideHtml('<h1>Valid slide</h1>'));
  await fs.writeFile(
    path.join(slides, '02-invalid.html'),
    slideHtml('<p style="background:#fee">Invalid slide</p>'),
  );
  await fs.writeFile(out, 'stale-pptx');

  const result = runNode(['scripts/export_deck_pptx.mjs', '--slides', slides, '--out', out]);

  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stderr, /任一 slide 失败都会造成缺页 PPTX/);
  assert.equal(fsSync.existsSync(out), false, 'failed export must not leave stale or partial PPTX output');
});

test('export_deck_pptx writes output when every slide passes validation', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-pptx-ok-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const slides = path.join(tmp, 'slides');
  const out = path.join(tmp, 'deck.pptx');
  await fs.mkdir(slides);
  await fs.writeFile(path.join(slides, '01-valid.html'), slideHtml('<h1>First slide</h1>'));
  await fs.writeFile(path.join(slides, '02-valid.html'), slideHtml('<h1>Second slide</h1>'));

  const result = runNode(['scripts/export_deck_pptx.mjs', '--slides', slides, '--out', out]);

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fsSync.existsSync(out), true, 'successful export should write a PPTX');
  assert.ok(fsSync.statSync(out).size > 0, 'successful PPTX should not be empty');
});

test('video renderers do not hide generic content title classes', async () => {
  const renderVideo = await fs.readFile(path.join(repoRoot, 'scripts/render-video.js'), 'utf8');
  const renderVideoSeek = await fs.readFile(path.join(repoRoot, 'scripts/render-video-seek.js'), 'utf8');

  assert.doesNotMatch(renderVideo, /^\s*\.title\b/m);
  assert.doesNotMatch(renderVideo, /^\s*\.kicker\b/m);
  assert.doesNotMatch(renderVideoSeek, /^\s*\.title\b/m);
  assert.doesNotMatch(renderVideoSeek, /^\s*\.kicker\b/m);
});

test('render-video-seek passes explicit frame start number to ffmpeg', async (t) => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'huashu-seek-'));
  t.after(() => fs.rm(tmp, { recursive: true, force: true }));

  const html = path.join(tmp, 'seek.html');
  const bin = path.join(tmp, 'bin');
  const fakeFfmpeg = path.join(bin, 'ffmpeg');
  const ffmpegArgs = path.join(tmp, 'ffmpeg-args.txt');
  await fs.mkdir(bin);
  await fs.writeFile(html, `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    html, body { margin: 0; width: 160px; height: 90px; overflow: hidden; background: white; }
    .title { position: absolute; left: 8px; top: 8px; font: 18px Arial; color: #111; }
  </style>
</head>
<body>
  <div class="title">Visible title</div>
  <script>
    window.__seek = function (t) { document.body.dataset.t = String(t); };
    window.__ready = true;
  </script>
</body>
</html>`);
  await fs.writeFile(fakeFfmpeg, `#!/usr/bin/env bash
printf '%s\\n' "$@" > "$FFMPEG_ARGS_FILE"
out="\${@: -1}"
printf 'fake mp4' > "$out"
exit 0
`);
  await fs.chmod(fakeFfmpeg, 0o755);

  const result = runNode([
    'scripts/render-video-seek.js',
    html,
    '--duration=0.1',
    '--fps=10',
    '--width=160',
    '--height=90',
    '--concurrency=1',
    '--settle=1',
  ], {
    env: {
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      FFMPEG_ARGS_FILE: ffmpegArgs,
    },
  });

  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(fsSync.existsSync(path.join(tmp, 'seek.mp4')), true, 'fake ffmpeg should receive the output path');

  const args = (await fs.readFile(ffmpegArgs, 'utf8')).trim().split('\n');
  const startNumberIndex = args.indexOf('-start_number');
  const inputIndex = args.indexOf('-i');
  assert.notEqual(startNumberIndex, -1, 'ffmpeg invocation must include -start_number');
  assert.equal(args[startNumberIndex + 1], '0');
  assert.ok(startNumberIndex < inputIndex, '-start_number must apply to the image sequence input');
});
