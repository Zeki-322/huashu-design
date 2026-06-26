import fs from 'fs/promises';
import path from 'path';
import vm from 'vm';

function extractManifest(html, indexFile) {
  const marker = 'window.DECK_MANIFEST';
  const start = html.indexOf(marker);
  if (start === -1) return null;
  const eq = html.indexOf('=', start);
  const end = html.indexOf('];', eq);
  if (eq === -1 || end === -1) throw new Error(`Cannot parse DECK_MANIFEST in ${indexFile}`);

  const sandbox = { window: {} };
  vm.runInNewContext(
    `window.DECK_MANIFEST = ${html.slice(eq + 1, end + 1)};`,
    sandbox,
    { timeout: 1000 },
  );
  if (!Array.isArray(sandbox.window.DECK_MANIFEST)) {
    throw new Error(`DECK_MANIFEST is not an array in ${indexFile}`);
  }
  return sandbox.window.DECK_MANIFEST;
}

async function sortedHtmlFiles(slidesAbs) {
  return (await fs.readdir(slidesAbs))
    .filter(file => file.endsWith('.html'))
    .sort()
    .map(file => ({ file, path: path.join(slidesAbs, file) }));
}

export async function resolveDeckSlides(slidesDir, { index } = {}) {
  const slidesAbs = path.resolve(slidesDir);
  const indexFile = index ? path.resolve(index) : path.join(path.dirname(slidesAbs), 'index.html');

  let html;
  try {
    html = await fs.readFile(indexFile, 'utf8');
  } catch (error) {
    if (index) throw error;
    return sortedHtmlFiles(slidesAbs);
  }

  const manifest = extractManifest(html, indexFile);
  if (!manifest) {
    if (index) throw new Error(`No DECK_MANIFEST found in ${indexFile}`);
    return sortedHtmlFiles(slidesAbs);
  }

  const indexDir = path.dirname(indexFile);
  const slides = [];
  for (const item of manifest) {
    if (!item || typeof item.file !== 'string') {
      throw new Error(`Invalid DECK_MANIFEST item in ${indexFile}`);
    }
    const slideAbs = path.resolve(indexDir, item.file);
    const rel = path.relative(slidesAbs, slideAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Manifest slide is outside --slides directory: ${item.file}`);
    }
    await fs.access(slideAbs);
    slides.push({ file: rel.split(path.sep).join('/'), path: slideAbs });
  }
  if (!slides.length) throw new Error(`DECK_MANIFEST has no slides in ${indexFile}`);
  return slides;
}
