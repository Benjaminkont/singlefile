import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderIndex } from './render-index.mjs';
import { archives, atomicWrite, exists, loadSources, paths, readJSON, runMain, withLock } from './library.mjs';

export async function collectEntries() {
  const sources = await loadSources();
  const entries = [], sites = [];
  let failed = 0;
  for (const source of sources) {
    const records = await readJSON(paths(source.id).report, []);
    const good = [];
    for (const record of records) {
      if (!record.ok) { failed++; continue; }
      if (!await exists(path.join(paths(source.id).pages, record.file))) continue;
      good.push({ ...record, source: source.id, sourceName: source.name, href: `${source.id}/pages/${record.file}` });
    }
    entries.push(...good);
    sites.push({ id: source.id, name: source.name, count: good.length, failed: records.filter(r => !r.ok).length, href: `${source.id}/index.html` });
  }
  return { entries, sites, failed };
}

export async function prepare() {
  return withLock(path.join(archives, '.prepare.lock'), async () => {
    const { entries, sites, failed } = await collectEntries();
    for (const site of sites) {
      const local = entries.filter(r => r.source === site.id).map(r => ({ ...r, href: `pages/${r.file}` }));
      await atomicWrite(path.join(paths(site.id).base, 'index.html'), renderIndex(local, { title: site.name + ' · 本地归档', source: site.id, failed: site.failed }));
    }
    await atomicWrite(path.join(archives, 'index.html'), renderIndex(entries, { sites, failed }));
    console.log(`目录已更新：${sites.length} 个站点，${entries.length} 篇可阅读资料，${failed} 条失败记录。`);
    return { sources: sites.length, successful: entries.length, failed };
  }, 15000);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runMain(prepare);
