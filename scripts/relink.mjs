import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { atomicWrite, loadSources, option, paths, readJSON, sourceId, runMain, withLock, writeJSON } from './library.mjs';
import { collectEntries } from './prepare-preview.mjs';

export function rewriteLinks(html, record, mapping, directory) {
  let changed = 0;
  const output = html.replace(/<a\b[^>]*>/gi, tag => tag.replace(/\bhref\s*=\s*(?:(["'])(.*?)\1|([^\s>]+))/gi, (attribute, quote, quoted, unquoted) => {
    const href = (quoted ?? unquoted).replace(/&amp;/g, '&');
    // Already-local links remain relative to their peer snapshots.
    if (!/^https?:\/\//i.test(href) && !href.startsWith('//') && !href.startsWith('/')) return attribute;
    try {
      const url = new URL(href, record.finalUrl || record.url), hash = url.hash;
      url.hash = '';
      const target = mapping.get(url.href);
      if (!target) return attribute;
      changed++;
      const relative = path.relative(directory, target).split(path.sep).join('/') + hash;
      return 'href="' + relative.replace(/[&"<>]/g, c => ({ '&': '&amp;', '"': '&quot;', '<': '&lt;', '>': '&gt;' })[c]) + '"';
    } catch { return attribute; }
  }));
  return { html: output, changed };
}

export async function relink(source, only, { updateReport = true } = {}) {
  const { entries } = await collectEntries();
  const mapping = new Map();
  for (const record of entries) for (const raw of [record.url, record.finalUrl, ...(record.aliases || [])].filter(Boolean)) {
    const url = new URL(raw); url.hash = '';
    if (!mapping.has(url.href)) mapping.set(url.href, path.join(paths(record.source).pages, record.file));
  }
  let changed = 0;
  const records = updateReport ? await readJSON(paths(source).report, []) : [];
  for (const record of entries.filter(r => r.source === source && (!only || r.file === only))) {
    const file = path.join(paths(source).pages, record.file);
    const result = rewriteLinks(await readFile(file, 'utf8'), record, mapping, paths(source).pages);
    if (result.changed) {
      await atomicWrite(file, result.html); changed += result.changed;
      const row = records.find(r => r.file === record.file);
      if (row) { row.bytes = (await stat(file)).size; row.localLinksRewritten = (row.localLinksRewritten || 0) + result.changed; }
    }
  }
  if (changed && updateReport) await writeJSON(paths(source).report, records);
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(async () => {
  const source = option('--source');
  const sources = source ? [sourceId(source)] : (await loadSources()).map(s => s.id);
  let changed = 0;
  for (const id of sources) {
    await readJSON(paths(id).config);
    changed += await withLock(path.join(paths(id).reports, '.capture.lock'), () => relink(id, option('--only')));
  }
  console.log(`已改写 ${changed} 个指向现有归档的链接。`);
});
