#!/usr/bin/env node
// Offline browser evidence only. This does not certify translation accuracy or visual quality.
import path from 'node:path';
import { readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { launchBrowser } from './browser.mjs';

const args = process.argv.slice(2);
const source = path.resolve(args[0] || '');
const recordFlag = args.indexOf('--records');
if (!args[0] || recordFlag < 0 || !args[recordFlag + 1]) {
  console.error('Usage: node scripts/verify-translation.mjs SOURCE --records DIR');
  process.exit(2);
}
const records = path.resolve(args[recordFlag + 1]);
const manifest = JSON.parse(await readFile(path.join(records, 'source.json'), 'utf8'));
if (path.resolve(manifest.source) !== source) throw new Error('Source path differs from extraction manifest');
const translated = path.resolve(manifest.output);
await Promise.all([access(source), access(translated)]);
const shots = path.join(records, 'screenshots');
await mkdir(shots, { recursive: true });
const report = { source, translated, startedAt: new Date().toISOString(), networkPolicy: 'Offline mode; request interception permits only file:, data:, blob:, about:', status: 'browser_machine_checks_recorded_pending_human_visual_review', humanVisualReview: 'pending', contentReview: 'not_performed_by_this_script', screenshots: [], viewports: [], limitations: ['Screenshots require human inspection; machine checks do not establish translation accuracy or layout quality.', 'Only existing same-document fragment links are clicked. Other interactive controls are not exercised.', 'Each screenshot shows one viewport; tall figures, tables, and code blocks may need further manual inspection.'] };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const browser = await launchBrowser();
try {
  for (const viewport of [{ name: 'desktop', width: 1440, height: 1000 }, { name: 'mobile', width: 390, height: 844 }]) {
    const pair = { viewport, pages: [] };
    for (const [language, file] of [['en', source], ['zh', translated]]) {
      const page = await browser.newPage();
      const blocked = new Set();
      const errors = [];
      try {
        await page.setViewport({ width: viewport.width, height: viewport.height });
        await page.setOfflineMode(true);
        await page.setRequestInterception(true);
        page.on('request', request => {
          if (/^(?:file|data|blob|about):/.test(request.url())) request.continue().catch(() => {});
          else { blocked.add(request.url()); request.abort().catch(() => {}); }
        });
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(pathToFileURL(file).href, { waitUntil: 'load', timeout: 60000 });
        await page.evaluate(async () => { await document.fonts.ready; });
        // Trigger the archive's lazy-loaded images without making source changes.
        await page.evaluate(async () => {
          for (const image of document.images) {
            image.scrollIntoView({ block: 'center' });
            await new Promise(resolve => setTimeout(resolve, 15));
          }
          window.scrollTo(0, 0);
        });
        await delay(250);
        const metrics = await page.evaluate(() => {
          const visible = element => {
            const box = element.getBoundingClientRect();
            const css = getComputedStyle(element);
            return box.width > 0 && box.height > 0 && css.visibility !== 'hidden' && css.display !== 'none';
          };
          const images = [...document.images].filter(visible);
          const main = document.querySelector('main') || document.body;
          const headings = [...main.querySelectorAll('h1,h2')].map((h, index) => ({ index, tag: h.tagName, id: h.id, text: h.innerText, visible: visible(h) }));
          const visibleFeatures = [...main.querySelectorAll('figure,table,pre')].map((el, index) => ({ index, tag: el.tagName, visible: visible(el), height: Math.round(el.getBoundingClientRect().height), width: Math.round(el.getBoundingClientRect().width) })).filter(x => x.visible);
          const overflow = [...document.querySelectorAll('body *')].filter(el => {
            if (!visible(el)) return false;
            const box = el.getBoundingClientRect();
            return box.left < -1 || box.right > innerWidth + 1;
          }).slice(0, 40).map(el => ({ tag: el.tagName, id: el.id, class: String(el.className).slice(0, 160), text: (el.innerText || '').slice(0, 80), left: Math.round(el.getBoundingClientRect().left), right: Math.round(el.getBoundingClientRect().right) }));
          const anchorLinks = [...document.querySelectorAll('a[href]')].map((a, index) => {
            let url;
            try { url = new URL(a.getAttribute('href'), location.href); } catch { return null; }
            if (url.pathname !== location.pathname || url.search !== location.search || !url.hash || url.hash === '#') return null;
            let fragment;
            try { fragment = decodeURIComponent(url.hash.slice(1)); } catch { fragment = url.hash.slice(1); }
            const target = document.getElementById(fragment) || document.getElementsByName(fragment)[0];
            return { index, href: a.getAttribute('href'), fragment, targetExists: !!target, visible: visible(a) };
          }).filter(Boolean);
          return { title: document.title, textLength: main.innerText.length, width: innerWidth, documentWidth: document.documentElement.scrollWidth, horizontalOverflow: document.documentElement.scrollWidth > innerWidth + 1, fontsStatus: document.fonts.status, headings, visibleImages: images.length, brokenImages: images.filter(i => !i.complete || !i.naturalWidth).map(i => ({ alt: i.alt, sourceType: i.currentSrc.split(':')[0], complete: i.complete })), visibleFeatures, overflowElementsSample: overflow, anchorLinks };
        });
        async function snapshot(label, selector, index, position) {
          if (selector) {
            const found = await page.evaluate(({ selector, index }) => {
              const main = document.querySelector('main') || document.body;
              const element = main.querySelectorAll(selector)[index];
              if (!element) return false;
              element.scrollIntoView({ block: 'start' });
              return true;
            }, { selector, index });
            if (!found) return;
          } else {
            await page.evaluate(position => window.scrollTo(0, position === 'bottom' ? document.documentElement.scrollHeight : 0), position);
          }
          await delay(70);
          const name = viewport.name + '-' + language + '-' + label + '.png';
          await page.screenshot({ path: path.join(shots, name) });
          report.screenshots.push({ viewport: viewport.name, language, label, file: path.join('screenshots', name), selector: selector || null, index: index ?? null });
        }
        await snapshot('top', null, null, 'top');
        for (const heading of metrics.headings.filter(h => h.visible)) await snapshot('heading-' + String(heading.index).padStart(3, '0'), 'h1,h2', heading.index);
        for (const feature of metrics.visibleFeatures) await snapshot('feature-' + String(feature.index).padStart(3, '0') + '-' + feature.tag.toLowerCase(), 'figure,table,pre', feature.index);
        await snapshot('bottom', null, null, 'bottom');
        metrics.anchorClickChecks = [];
        for (const anchor of metrics.anchorLinks.filter(a => a.visible && a.targetExists)) {
          try {
            const clicked = await page.evaluate(index => {
              const a = document.querySelectorAll('a[href]')[index];
              if (!a) return false;
              a.click();
              return true;
            }, anchor.index);
            await delay(30);
            const result = await page.evaluate(fragment => {
              const target = document.getElementById(fragment) || document.getElementsByName(fragment)[0];
              return { currentHash: location.hash, targetPresentAfterClick: !!target, targetTop: target ? Math.round(target.getBoundingClientRect().top) : null };
            }, anchor.fragment);
            metrics.anchorClickChecks.push({ ...anchor, clickMode: 'DOM click of existing visible anchor', clicked, ...result });
          } catch (error) {
            metrics.anchorClickChecks.push({ ...anchor, error: error.message });
          }
        }
        const localLinks = await page.$$eval('a[href]', links => links.map(a => a.href).filter(href => href.startsWith('file:') && !href.startsWith(location.href.split('#')[0] + '#')));
        metrics.localFileLinks = [];
        for (const href of [...new Set(localLinks)]) {
          const url = new URL(href); url.hash = ''; url.search = '';
          const target = fileURLToPath(url);
          metrics.localFileLinks.push({ href, exists: await access(target).then(() => true).catch(() => false) });
        }
        metrics.blockedExternalRequests = [...blocked];
        metrics.pageErrors = errors;
        pair.pages.push({ language, file, ...metrics });
      } finally { await page.close(); }
    }
    const [en, zh] = pair.pages;
    pair.comparison = { headingTagAndIdSequenceMatches: JSON.stringify(en.headings.map(h => [h.tag, h.id])) === JSON.stringify(zh.headings.map(h => [h.tag, h.id])), visibleImageCountMatches: en.visibleImages === zh.visibleImages, newBrokenImages: Math.max(0, zh.brokenImages.length - en.brokenImages.length), newHorizontalOverflow: zh.horizontalOverflow && !en.horizontalOverflow, featureTagSequenceMatches: JSON.stringify(en.visibleFeatures.map(f => f.tag)) === JSON.stringify(zh.visibleFeatures.map(f => f.tag)) };
    report.viewports.push(pair);
  }
  report.finishedAt = new Date().toISOString();
  await writeFile(path.join(records, 'browser-review.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ records, screenshots: report.screenshots.length, viewports: report.viewports.map(v => ({ viewport: v.viewport.name, comparison: v.comparison, pages: v.pages.map(p => ({ language: p.language, visibleImages: p.visibleImages, brokenImages: p.brokenImages.length, horizontalOverflow: p.horizontalOverflow, anchorClickChecks: p.anchorClickChecks.length })) })), humanVisualReview: 'pending' }, null, 2));
} finally { await browser.close(); }
