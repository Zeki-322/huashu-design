import fs from 'fs/promises';
import path from 'path';
import vm from 'vm';

export function naturalSlideCompare(a, b) {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

function extractArrayLiteral(source, assignmentName) {
  const assignment = source.indexOf(assignmentName);
  if (assignment === -1) return null;

  const start = source.indexOf('[', assignment);
  if (start === -1) return null;

  let depth = 0;
  let quote = null;
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (let i = start; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '/' && next === '/') {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === '/' && next === '*') {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch;
      continue;
    }
    if (ch === '[') depth++;
    if (ch === ']') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }

  throw new Error(`Could not parse ${assignmentName}: unterminated array literal`);
}

export function parseDeckManifestFromHtml(html, sourceName = 'index.html') {
  const literal = extractArrayLiteral(html, 'window.DECK_MANIFEST');
  if (!literal) return null;

  let manifest;
  try {
    manifest = vm.runInNewContext(`(${literal})`, Object.freeze({}), {
      timeout: 1000,
      displayErrors: false,
    });
  } catch (error) {
    throw new Error(`Failed to parse DECK_MANIFEST in ${sourceName}: ${error.message}`);
  }

  if (!Array.isArray(manifest)) {
    throw new Error(`DECK_MANIFEST in ${sourceName} must be an array`);
  }
  return manifest;
}

async function findIndexFile(slidesDir, explicitIndex) {
  const candidates = explicitIndex
    ? [path.resolve(explicitIndex)]
    : [path.join(path.dirname(slidesDir), 'index.html')];

  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch (_) {
      // No deck index next to this slides directory; fall back to natural order.
    }
  }
  return null;
}

export async function readOrderedSlidesFromManifest(slidesDir, explicitIndex) {
  const indexFile = await findIndexFile(slidesDir, explicitIndex);
  if (!indexFile) return null;

  const html = await fs.readFile(indexFile, 'utf8');
  const manifest = parseDeckManifestFromHtml(html, indexFile);
  if (!manifest) return null;

  const deckRoot = path.dirname(indexFile);
  const ordered = [];
  for (const [i, item] of manifest.entries()) {
    if (!item || typeof item.file !== 'string' || !item.file.trim()) {
      throw new Error(`DECK_MANIFEST entry ${i + 1} in ${indexFile} is missing a file`);
    }

    const absoluteFile = path.resolve(deckRoot, item.file);
    const relativeToSlides = path.relative(slidesDir, absoluteFile);
    if (relativeToSlides.startsWith('..') || path.isAbsolute(relativeToSlides)) {
      throw new Error(`DECK_MANIFEST entry "${item.file}" is outside slides directory ${slidesDir}`);
    }
    if (!relativeToSlides.endsWith('.html')) {
      throw new Error(`DECK_MANIFEST entry "${item.file}" is not an .html slide`);
    }
    try {
      await fs.access(absoluteFile);
    } catch (_) {
      throw new Error(`DECK_MANIFEST entry "${item.file}" does not exist`);
    }
    ordered.push(relativeToSlides);
  }
  return ordered;
}

export async function listOrderedSlideFiles(slidesDir, options = {}) {
  const absoluteSlidesDir = path.resolve(slidesDir);
  const manifestFiles = await readOrderedSlidesFromManifest(absoluteSlidesDir, options.index);
  if (manifestFiles) return manifestFiles;

  return (await fs.readdir(absoluteSlidesDir))
    .filter(f => f.endsWith('.html'))
    .sort(naturalSlideCompare);
}
