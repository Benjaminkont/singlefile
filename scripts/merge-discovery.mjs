import path from 'node:path';
import { requireSource, loadSource, paths, readJSON, webpageUrl, validFile, writeJSON, withLock, runMain } from './library.mjs';

runMain(async () => {
  const selected = await requireSource(), p = paths(selected.id);
  await withLock(path.join(p.reports, '.capture.lock'), async () => {
    const { id, ...config } = await loadSource(selected.id);
    const discovered = await readJSON(path.join(p.discovery, 'crawl-targets.json'));
    const known = new Set(config.targets.flatMap(t => [t.url, ...(t.aliases || [])]).map(webpageUrl));
    const files = new Set(config.targets.map(t => t.file));
    let added = 0;
    for (const target of discovered) {
      const url = webpageUrl(target.url);
      if (known.has(url)) continue;
      validFile(target.file);
      if (files.has(target.file)) throw new Error('发现结果文件名冲突：' + target.file);
      config.targets.push(target); known.add(url); files.add(target.file); added++;
    }
    await writeJSON(p.config, config);
    console.log(`已合并 ${added} 个新目标；共 ${config.targets.length} 个。运行 capture 并指定站点才会保存网页。`);
  });
});
