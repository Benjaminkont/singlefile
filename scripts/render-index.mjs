const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function renderIndex(entries, { title = '本地网页资料库', sites = [], failed = 0, source } = {}) {
  const rows = entries.map(r => {
    const saved = r.finished || r.started;
    const time = saved ? `<time datetime="${escape(saved)}">${escape(new Date(saved).toLocaleDateString('zh-CN'))}</time>` : '保存日期未记录';
    return `<li data-source="${escape(r.source)}"><a class="title" href="${escape(r.href)}">${escape(r.title || r.file)}</a><div class="meta"><span>${escape(r.sourceName || r.source)}</span> · ${time} · ${(r.bytes / 1024 / 1024).toFixed(2)} MiB</div><a class="original" href="${escape(r.finalUrl || r.url)}" target="_blank" rel="noreferrer">${escape(r.url)}</a></li>`;
  }).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)}</title>
<style>
:root{color-scheme:light;--green:#17644e;--muted:#626b65}*{box-sizing:border-box}body{font-family:system-ui,-apple-system,sans-serif;max-width:1100px;margin:50px auto;padding:0 24px 60px;color:#202b24;background:#f5f7f4}a{color:var(--green)}h1{font-size:30px;margin-bottom:12px}p{line-height:1.75;color:var(--muted)}.toolbar{display:flex;gap:12px;position:sticky;top:0;background:#f5f7f4;padding:18px 0;z-index:1}input,select{font:inherit;padding:12px;border:1px solid #bcc8c0;border-radius:8px;background:white}input{flex:1;min-width:0}nav{display:flex;gap:10px;flex-wrap:wrap}nav a{padding:7px 12px;background:#e6eee8;border-radius:8px;text-decoration:none}ul{list-style:none;padding:0}li{padding:20px;background:white;margin-bottom:12px;border:1px solid #e1e7e2;border-radius:10px}.title{font-size:19px;font-weight:600;text-decoration:none;line-height:1.5}.title:hover{text-decoration:underline}.meta,.original{display:block;font-size:13px;margin-top:8px;overflow-wrap:anywhere}.meta{color:var(--muted)}.original{color:#526f5e}#count{font-size:14px}[hidden]{display:none!important}@media(max-width:600px){body{margin-top:24px;padding:0 16px}.toolbar{flex-direction:column}h1{font-size:25px}}
</style></head><body>
${source ? '<a href="../index.html">← 全部站点</a>' : ''}<h1>${escape(title)}</h1>
<p>共 ${entries.length} 篇可阅读资料${failed ? ` · ${failed} 条抓取失败记录` : ''}。网页保存为静态快照，视频、搜索和登录等交互可能仍需原站。</p>
<nav aria-label="站点目录">${sites.map(s => `<a href="${escape(s.href)}">${escape(s.name)} · ${s.count}</a>`).join('')}</nav>
<div class="toolbar"><input id="search" type="search" aria-label="搜索标题和网址" placeholder="搜索标题或网址…"><select id="source" aria-label="筛选站点"><option value="">全部站点</option>${[...new Map(entries.map(r => [r.source, r.sourceName || r.source])).entries()].map(([id, name]) => `<option value="${escape(id)}">${escape(name)}</option>`).join('')}</select></div>
<p id="count" role="status">显示 ${entries.length} 篇</p><ul id="entries">${rows}</ul><p id="empty" hidden>没有匹配的资料。</p>
<script>
const search=document.querySelector('#search'),source=document.querySelector('#source'),rows=[...document.querySelectorAll('#entries li')];
function filter(){const text=search.value.trim().toLocaleLowerCase();let count=0;for(const row of rows){row.hidden=Boolean(source.value&&row.dataset.source!==source.value)||!row.textContent.toLocaleLowerCase().includes(text);if(!row.hidden)count++;}document.querySelector('#count').textContent='显示 '+count+' 篇';document.querySelector('#empty').hidden=count!==0;}
search.addEventListener('input',filter);source.addEventListener('change',filter);
</script></body></html>\n`;
}
