import fs from 'fs/promises';
import path from 'path';
import vm from 'vm';

function findManifestLiteral(source, filename) {
  const match = /window\s*\.\s*DECK_MANIFEST\s*=/.exec(source);
  if (!match) return null;

  let i = match.index + match[0].length;
  while (i < source.length && /\s/.test(source[i])) i++;
  if (source[i] !== '[') {
    throw new Error(`DECK_MANIFEST in ${filename} must be assigned an array literal`);
  }

  const start = i;
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;

  for (; i < source.length; i++) {
    const ch = source[i];
    const next = source[i + 1];

    if (lineComment) {
      if (ch === '\n' || ch === '\r') lineComment = false;
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
        quote = '';
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

  throw new Error(`Could not find the end of DECK_MANIFEST in ${filename}`);
}

export function parseDeckManifest(source, filename = 'index.html') {
  const literal = findManifestLiteral(source, filename);
  if (!literal) return null;

  const script = new vm.Script(`(${literal})`, { filename });
  const manifest = script.runInNewContext(Object.create(null), { timeout: 1000 });
  if (!Array.isArray(manifest)) {
    throw new Error(`DECK_MANIFEST in ${filename} must be an array`);
  }
  return manifest;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (_) {
    return false;
  }
}

async function entriesFromManifest(indexPath) {
  const html = await fs.readFile(indexPath, 'utf8');
  const manifest = parseDeckManifest(html, indexPath);
  if (!manifest) return null;

  const indexDir = path.dirname(indexPath);
  const entries = manifest.map((entry, idx) => {
    if (!entry || typeof entry.file !== 'string' || !entry.file.trim()) {
      throw new Error(`DECK_MANIFEST entry ${idx + 1} in ${indexPath} is missing a file`);
    }
    const absPath = path.resolve(indexDir, entry.file);
    if (path.extname(absPath).toLowerCase() !== '.html') {
      throw new Error(`DECK_MANIFEST entry ${idx + 1} is not an HTML slide: ${entry.file}`);
    }
    return {
      file: entry.file,
      label: entry.label,
      thumb: entry.thumb,
      absPath,
      displayName: entry.file,
      baseName: path.basename(entry.file, '.html'),
    };
  });

  if (!entries.length) {
    throw new Error(`DECK_MANIFEST in ${indexPath} is empty`);
  }

  for (const entry of entries) {
    if (!(await fileExists(entry.absPath))) {
      throw new Error(`DECK_MANIFEST slide not found: ${entry.file}`);
    }
  }

  return entries;
}

export async function resolveDeckEntries({ slidesDir, indexPath }) {
  const resolvedSlides = path.resolve(slidesDir);
  const resolvedIndex = indexPath
    ? path.resolve(indexPath)
    : path.join(path.dirname(resolvedSlides), 'index.html');

  if (await fileExists(resolvedIndex)) {
    const manifestEntries = await entriesFromManifest(resolvedIndex);
    if (manifestEntries) return manifestEntries;
  }

  const files = (await fs.readdir(resolvedSlides))
    .filter(f => f.endsWith('.html'))
    .sort();
  if (!files.length) {
    throw new Error(`No .html files found in ${resolvedSlides}`);
  }
  return files.map(file => ({
    file,
    absPath: path.join(resolvedSlides, file),
    displayName: file,
    baseName: path.basename(file, '.html'),
  }));
}
