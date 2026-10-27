(() => {
  let pending;
  async function warm() {
    const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
    try {
      document.documentElement.dataset.localArchiveWarm = 'running';
      await document.fonts.ready;
      const containers = [document.scrollingElement, document.body, ...document.querySelectorAll('body *')]
        .filter((element, index, all) => element && all.indexOf(element) === index)
        .filter(element => element.clientHeight > 100 && element.scrollHeight > element.clientHeight + 100 &&
          (element === document.scrollingElement || /auto|scroll/.test(getComputedStyle(element).overflowY)));
      for (const container of containers) {
        const previous = container.scrollTop;
        const step = Math.max(400, container.clientHeight * 0.8);
        for (let top = 0, count = 0; top < container.scrollHeight && count < 60; top += step, count++) {
          container.scrollTop = top;
          container.dispatchEvent(new Event('scroll'));
          await delay(180);
        }
        container.scrollTop = previous;
      }
      for (const image of document.images) image.loading = 'eager';
      await Promise.race([
        Promise.all([...document.images].map(image => image.complete ? undefined : new Promise(resolve => {
          image.addEventListener('load', resolve, { once: true });
          image.addEventListener('error', resolve, { once: true });
        }))),
        delay(8000),
      ]);
      await delay(1500);
    } finally {
      document.documentElement.dataset.localArchiveWarm = 'complete';
    }
  }
  const start = () => pending ??= warm();
  // Start after page load as well: browser isolated worlds can differ in their
  // handling of SingleFile's optional event hook.
  if (document.readyState === 'complete') setTimeout(start, 1000);
  else addEventListener('load', () => setTimeout(start, 1000), { once: true });
  dispatchEvent(new CustomEvent('single-file-user-script-init'));
  addEventListener('single-file-on-before-capture-request', async event => {
    event.preventDefault();
    try { await start(); }
    finally { dispatchEvent(new CustomEvent('single-file-on-before-capture-response')); }
  });
})();
