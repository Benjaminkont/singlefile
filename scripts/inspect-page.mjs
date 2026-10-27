import { pathToFileURL } from 'node:url';

const challengePattern = /just a moment|verify (?:that )?you are human|checking your browser|access denied|security (?:check|verification)|too many requests|验证您是人类|人机验证/i;

export async function inspectPage(browser, fileOrUrl, { offline = true, screenshot } = {}) {
  const page = await browser.newPage();
  try {
    await page.setViewport({ width: 1440, height: 1000 });
    await page.setOfflineMode(offline);
    const failedRequests = [];
    page.on('requestfailed', r => { if (/^https?:/.test(r.url())) failedRequests.push(r.url()); });
    const response = await page.goto(offline ? pathToFileURL(fileOrUrl).href : fileOrUrl, { waitUntil: 'load', timeout: 60000 });
    if (!offline) await new Promise(resolve => setTimeout(resolve, 3000));
    const frames = [];
    for (const frame of page.frames()) {
      frames.push(await frame.evaluate(async () => {
        await document.fonts.ready;
        const main = document.querySelector('main') || document.body;
        const images = [...document.images].filter(i => { const b = i.getBoundingClientRect(); return b.width > 0 && b.height > 0 && getComputedStyle(i).visibility !== 'hidden'; });
        return { title: document.title, text: main?.innerText || '', headings: [...main.querySelectorAll('h1,h2,h3')].map(h => h.innerText),
          visibleImages: images.length, brokenImages: images.filter(i => !i.complete || !i.naturalWidth).map(i => ({ alt: i.alt, sourceType: i.src.split(':')[0] })) };
      }));
    }
    const text = frames.map(f => f.text).filter(Boolean).join('\n\n');
    const title = frames[0]?.title || '';
    const challenge = challengePattern.test(title) || (text.length < 3000 && challengePattern.test(text.slice(0, 600)));
    if (screenshot) await page.screenshot({ path: screenshot, fullPage: true });
    return { title, text, textLength: text.trim().length, headings: frames.flatMap(f => f.headings),
      visibleImages: frames.reduce((n, f) => n + f.visibleImages, 0), brokenImages: frames.flatMap(f => f.brokenImages),
      failedRequests, frameCount: frames.length, challenge, offlineOk: text.trim().length > 100 && !challenge, httpStatus: response?.status() };
  } finally { await page.close(); }
}
