// Opt-in acceptance check against the real local library; no live source requests.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { root, paths, writeJSON } from '../scripts/library.mjs';
import { launchBrowser } from '../scripts/browser.mjs';
import { inspectPage } from '../scripts/inspect-page.mjs';
import { collectEntries } from '../scripts/prepare-preview.mjs';

const output = path.join(root, 'tests/.artifacts/browser');
await mkdir(output, { recursive: true });
const browser = await launchBrowser();
const checks = {};
try {
  const expected = await collectEntries();
  // Normal document scrolling must also trigger deferred content, not just overflow containers.
  const warm = await browser.newPage();
  await warm.setViewport({ width: 1440, height: 1000 });
  await warm.setContent('<html><body><div style="height:2500px"></div><div id="deferred">deferred figure</div></body></html>');
  await warm.evaluate(() => {
    new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) document.body.dataset.deferred = 'loaded'; }).observe(document.querySelector('#deferred'));
  });
  await warm.addScriptTag({ content: await readFile(path.join(root, 'scripts/warm-page.js'), 'utf8') });
  await warm.waitForFunction(() => document.documentElement.dataset.localArchiveWarm === 'complete');
  assert.equal(await warm.$eval('body', el => el.dataset.deferred), 'loaded');
  await warm.close();
  checks.documentScrollWarmup = true;
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 1000 });
  await page.setRequestInterception(true);
  page.on('request', request => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith('http://127.0.0.1:8765/')) request.abort();
    else request.continue();
  });
  await page.goto('http://127.0.0.1:8765/', { waitUntil: 'load' });
  checks.home = await page.$eval('h1', el => el.textContent);
  assert.equal(checks.home, '本地网页资料库');
  checks.total = await page.$$eval('#entries li', rows => rows.length);
  assert.equal(checks.total, expected.entries.length);
  await page.screenshot({ path: path.join(output, 'library-desktop.png') });
  await page.select('#source', 'anthropic.com');
  assert.equal(await page.$$eval('#entries li:not([hidden])', rows => rows.length), expected.entries.filter(r => r.source === 'anthropic.com').length);
  await page.type('#search', 'zz-no-such-article-zz');
  assert.equal(await page.$eval('#empty', el => !el.hidden), true);
  await page.$eval('#search', el => { el.value = '/research/building-effective-agents'; el.dispatchEvent(new Event('input')); });
  assert.equal(await page.$$eval('#entries li:not([hidden])', rows => rows.length), 1);
  checks.filterAndSearch = true;
  await Promise.all([page.waitForNavigation({ waitUntil: 'load' }), page.click('#entries li:not([hidden]) .title')]);
  assert.match(page.url(), /anthropic\.com\/pages\//);
  const text = await page.$eval('body', el => el.innerText);
  assert.match(text, /Prompt chaining/i);
  assert.match(text, /Appendix 2/i);
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (const [label, fraction] of [['top', 0], ['middle', 0.5], ['bottom', 1]]) {
    await page.evaluate(fraction => window.scrollTo(0, fraction * (document.documentElement.scrollHeight - innerHeight)), fraction);
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: path.join(output, 'anthropic-' + label + '.png') });
  }
  const figure = await page.$('main figure img');
  if (figure) {
    await figure.scrollIntoView();
    await new Promise(resolve => setTimeout(resolve, 250));
    await page.screenshot({ path: path.join(output, 'anthropic-diagram.png') });
  }
  checks.articleHeight = height;
  await page.setViewport({ width: 390, height: 844 });
  await page.goto('http://127.0.0.1:8765/');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: path.join(output, 'library-mobile.png') });
  checks.mobile = true;
  await page.close();
  checks.offline = [];
  // Select real snapshots from the current library, including curated subsets.
  const samples = expected.sites.flatMap(site => expected.entries.filter(record => record.source === site.id).slice(0, 2));
  for (const { source: id, file } of samples) {
    const { text: ignored, ...metrics } = await inspectPage(browser, path.join(paths(id).pages, file));
    assert.equal(metrics.offlineOk, true, file);
    if (id === 'anthropic.com') assert.ok(metrics.visibleImages > 0, 'Article figures must be measured after loading');
    checks.offline.push({ source: id, file, ...metrics });
  }
  await writeJSON(path.join(output, 'browser-check.json'), checks);
  console.log(JSON.stringify({ title: checks.home, total: checks.total, filterAndSearch: true, mobile: true,
    offline: checks.offline.map(r => ({ file: r.file, ok: r.offlineOk, textLength: r.textLength, brokenImages: r.brokenImages.length })) }, null, 2));
} finally { await browser.close(); }
