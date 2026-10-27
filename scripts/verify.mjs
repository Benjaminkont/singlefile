import path from 'node:path';
import { requireSource, option, paths, readJSON, writeJSON, runMain, withLock } from './library.mjs';
import { launchBrowser } from './browser.mjs';
import { inspectPage } from './inspect-page.mjs';
import { mkdir } from 'node:fs/promises';

runMain(async () => {
  const source = await requireSource(), p = paths(source.id);
  const only = option('--only'), live = process.argv.includes('--live');
  await withLock(path.join(p.reports, '.capture.lock'), async () => {
    const records = (await readJSON(p.report, [])).filter(r => r.ok && (!only || r.file === only));
    if (!records.length) throw new Error('没有匹配的成功归档。');
    const currentScreenshots = path.join(p.screenshots, 'current');
    await mkdir(currentScreenshots, { recursive: true });
    const verificationPath = path.join(p.reports, 'offline-verification-report.json');
    const verified = only ? (await readJSON(verificationPath, [])).filter(r => r.file !== only) : [];
    const browser = await launchBrowser(option('--browser'));
    try {
      for (const record of records) {
        const stem = record.file.replace(/\.html$/, '');
        const item = { url: record.url, file: record.file, checked: new Date().toISOString(), mode: live ? 'live-comparison' : 'offline', offlineOk: false };
        try {
          const { text, ...offline } = await inspectPage(browser, path.join(p.pages, record.file), {
            screenshot: process.argv.includes('--screenshots') ? path.join(currentScreenshots, stem + '-offline.png') : undefined,
          });
          item.offline = offline; item.offlineOk = offline.offlineOk;
          // Historical text files are evidence; verification records fresh text length without overwriting them.
          if (live) {
            try {
              const { text: liveText, ...online } = await inspectPage(browser, record.finalUrl || record.url, { offline: false });
              item.live = online;
              item.textMatchesLive = liveText.replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim();
            } catch (error) { item.live = { error: error.message }; }
          }
        } catch (error) { item.error = error.message; }
        verified.push(item);
        await writeJSON(verificationPath, verified);
        console.log(`${item.offlineOk ? 'OFFLINE_OK' : 'OFFLINE_FAILED'} ${record.file} brokenImages=${item.offline?.brokenImages.length ?? '?'}`);
        if (!item.offlineOk || (live && (!item.live || item.live.error || !item.textMatchesLive))) process.exitCode = 1;
      }
    } finally { await browser.close(); }
  });
});
