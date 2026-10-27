#!/usr/bin/env python3
"""Discover public page URLs and check responses, without downloading page assets."""
import argparse, concurrent.futures, csv, hashlib, json, os, re, subprocess, time
from collections import Counter
from datetime import datetime, timezone
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlsplit, urlunsplit
from urllib.request import Request, urlopen
from urllib.error import HTTPError
import xml.etree.ElementTree as ET

ROOT = Path(os.environ.get('SINGLEFILE_ROOT', Path(__file__).resolve().parents[1])).resolve()
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', required=True, help='站点配置名，例如 anthropic.com')
parser.add_argument('--limit', type=int, default=2000, help='最多检查的候选页面数')
args = parser.parse_args()
SOURCE = args.source.lower().removeprefix('www.')
if not re.fullmatch(r'[a-z0-9][a-z0-9.-]*', SOURCE) or '..' in SOURCE:
    parser.error('站点域名无效')
if args.limit < 1:
    parser.error('--limit 必须大于零')
try:
    config = json.loads((ROOT / 'config/sources' / (SOURCE + '.json')).read_text())
except FileNotFoundError:
    parser.error('站点配置不存在；请先通过 npm run add 添加一个网页')
BASE = config['origin'].rstrip('/') + '/'
HOST = urlsplit(BASE).hostname
if urlsplit(BASE).scheme not in ('http', 'https') or HOST.removeprefix('www.') != SOURCE:
    parser.error('站点配置的 origin 无效')
OUT = ROOT / 'archives' / SOURCE / 'records/discovery'
OUT.mkdir(parents=True, exist_ok=True)
LIMIT = args.limit
records, external, queries, assets = {}, {}, {}, {}
errors = []
sitemap_seen, sitemap_pages = set(), set()
started = datetime.now(timezone.utc).isoformat()

class Links(HTMLParser):
    def __init__(self):
        super().__init__(); self.links=[]; self.title=''; self.in_title=False; self.canonical=None
    def handle_starttag(self, tag, attrs):
        a=dict(attrs)
        if tag == 'a' and a.get('href'): self.links.append(a['href'])
        if tag == 'title': self.in_title=True
        if tag == 'link' and 'canonical' in a.get('rel','').split(): self.canonical=a.get('href')
    def handle_endtag(self, tag):
        if tag == 'title': self.in_title=False
    def handle_data(self, data):
        if self.in_title: self.title+=data

def normalize(value, base=BASE):
    try:
        u=urlsplit(urljoin(base,value))
        if u.scheme not in ('http','https') or not u.hostname: return None
        # Drop fragments; preserve queries and trailing slashes until redirects verify aliases.
        return urlunsplit((u.scheme.lower(),u.netloc.lower(),u.path or '/',u.query,''))
    except ValueError: return None

def add(value, source, base=BASE):
    url=normalize(value,base)
    if not url: return
    u=urlsplit(url)
    if u.hostname != HOST: dest=external
    elif u.query: dest=queries
    elif re.search(r'\.(?:png|jpe?g|gif|webp|svg|ico|mp4|webm|mp3|wav|pdf|zip|gz|json|xml|txt|css|js|woff2?|ttf)$',u.path,re.I): dest=assets
    else: dest=records
    if url not in dest:
        dest[url]={'url':url,'sources':[]}
    if source not in dest[url]['sources']: dest[url]['sources'].append(source)

def fetch(url):
    for attempt in range(2):
        try:
            with urlopen(Request(url,headers={'User-Agent':'Mozilla/5.0 (compatible; LocalPageInventory/1.0)','Accept':'text/html,application/xml,text/plain;q=0.9,*/*;q=0.1'}),timeout=30) as r:
                data=r.read(32*1024*1024+1)
                return {'status':r.status,'final_url':r.url,'content_type':r.headers.get('Content-Type',''),'body':data[:32*1024*1024],'truncated':len(data)>32*1024*1024}
        except HTTPError as e:
            if attempt==0 and e.code in (429,500,502,503,504): time.sleep(2); continue
            return {'status':e.code,'final_url':e.url,'error':str(e)}
        except Exception as e:
            if attempt==0: time.sleep(1); continue
            return {'status':None,'error':str(e)}

def sitemap(url):
    if url in sitemap_seen: return
    sitemap_seen.add(url)
    r=fetch(url)
    if r.get('status')!=200:
        errors.append({'source':url,**{k:v for k,v in r.items() if k!='body'}}); return
    data=r['body']; name=hashlib.sha256(url.encode()).hexdigest()[:10]+'-'+Path(urlsplit(url).path).name
    (OUT/name).write_bytes(data)
    try: tree=ET.fromstring(data)
    except ET.ParseError as e: errors.append({'source':url,'error':str(e)}); return
    if tree.tag.endswith('sitemapindex'):
        for item in tree:
            for child in item:
                if child.tag.endswith('loc') and child.text:
                    sub=normalize(child.text,url)
                    if sub and urlsplit(sub).hostname==HOST: sitemap(sub)
    else:
        for item in tree:
            for child in item:
                if child.tag.endswith('loc') and child.text:
                    page=normalize(child.text,url)
                    if page: sitemap_pages.add(page); add(page,'sitemap:'+url)

robots=fetch(urljoin(BASE,'robots.txt'))
if robots.get('status')==200:
    (OUT/'robots.txt').write_bytes(robots['body'])
    maps=re.findall(r'^Sitemap:\s*(\S+)',robots['body'].decode(errors='replace'),re.M|re.I)
else: maps=[]
for url in maps or [urljoin(BASE,'sitemap-index.xml')]: sitemap(url)
add(BASE,'seed:homepage')
print(f'Sitemap pages: {len(sitemap_pages)}; initial candidates: {len(records)}',flush=True)
checked=set()
with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
    while len(checked)<LIMIT:
        batch=[url for url in records if url not in checked][:min(32,LIMIT-len(checked))]
        if not batch: break
        for url,r in zip(batch,pool.map(fetch,batch)):
            checked.add(url); row=records[url]
            row.update({k:v for k,v in r.items() if k!='body'})
            final=normalize(r.get('final_url',url)) or url
            row['redirected']=final!=url
            if urlsplit(final).hostname!=HOST:
                row['classification']='external_redirect'; add(final,'redirect:'+url); continue
            if r.get('status')!=200:
                row['classification']='failed'; continue
            if 'html' not in r.get('content_type','').lower():
                row['classification']='non_html'; continue
            row['classification']='page'
            parser=Links(); parser.feed(r.get('body',b'').decode('utf-8',errors='replace'))
            row['title']=parser.title.strip()
            row['canonical']=normalize(parser.canonical,final) if parser.canonical else None
            if url==BASE: (OUT/'homepage.html').write_bytes(r['body'])
            add(final,'redirect:'+url) if final!=url else None
            for href in parser.links: add(href,'page:'+url,final)
        print(f'Checked {len(checked)}; discovered {len(records)}; external {len(external)}; query URLs {len(queries)}',flush=True)
        (OUT/'checkpoint.json').write_text(json.dumps(list(records.values()),ensure_ascii=False,indent=2))
        time.sleep(0.3)

for filename, classification in [('failed-pages.csv','failed'), ('external-redirects.csv','external_redirect'), ('non-html.csv','non_html')]:
    with (OUT/filename).open('w',newline='') as f:
        writer=csv.DictWriter(f,fieldnames=['url','status','final_url','content_type','error'],extrasaction='ignore')
        writer.writeheader(); writer.writerows(row for row in records.values() if row.get('classification')==classification)

pages={}
for row in records.values():
    if row.get('classification')!='page': continue
    final=normalize(row['final_url'])
    item=pages.setdefault(final,{'url':final,'title':row.get('title',''),'aliases':[],'sources':[],'file':(re.sub(r'[^a-zA-Z0-9_-]+','-',urlsplit(final).path.strip('/'))[:100] or 'home')+'-'+hashlib.sha256(final.encode()).hexdigest()[:8]+'.html'})
    if row['url']!=final: item['aliases'].append(row['url'])
    item['sources']=sorted(set(item['sources']+row['sources']))
for name,data in [('all-candidates.json',list(records.values())),('crawl-targets.json',sorted(pages.values(),key=lambda r:r['url'])),('external-links.json',list(external.values())),('query-links.json',list(queries.values())),('asset-links.json',list(assets.values()))]:
    (OUT/name).write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n')
(OUT/'urls.txt').write_text(''.join(url+'\n' for url in sorted(pages)))
with (OUT/'all-candidates.csv').open('w',newline='') as f:
    fields=['url','status','classification','final_url','title','canonical','redirected','error']
    w=csv.DictWriter(f,fieldnames=fields,extrasaction='ignore'); w.writeheader(); w.writerows(sorted(records.values(),key=lambda r:r['url']))
summary={'started_at':started,'finished_at':datetime.now(timezone.utc).isoformat(),'sitemap_urls':len(sitemap_pages),'discovered_candidates':len(records),'checked':len(checked),'unprocessed':len(records)-len(checked),'unique_successful_page_destinations':len(pages),'classifications':dict(Counter(r.get('classification','unprocessed') for r in records.values())),'external_links':len(external),'query_links':len(queries),'asset_links':len(assets),'sitemap_errors':errors,'groups':dict(Counter(urlsplit(u).path.strip('/').split('/')[0] or '(首页)' for u in pages))}
(OUT/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
lines=[f'# {SOURCE} 页面清单','',f'生成时间（UTC）：{summary["finished_at"]}。只请求网页 HTML 和站点地图，未下载页面图片、视频等资源。','', '## 范围与统计','',f'- 站点地图列出 {len(sitemap_pages)} 个网址；沿站内 HTML 链接继续发现，共 {len(records)} 个无查询参数的页面候选。',f'- 已检查 {len(checked)} 个；经 HTTP 跳转合并后，得到 **{len(pages)} 个返回 200 的站内 HTML 页面地址**。',f'- 分类：`{json.dumps(summary["classifications"],ensure_ascii=False)}`。',f'- 另列 {len(external)} 个站外地址、{len(queries)} 个带查询参数的站内地址、{len(assets)} 个文件资源地址。',f'- 未处理 {summary["unprocessed"]} 个候选；站点地图错误 {len(errors)} 个。','', f'只沿 {HOST} 的无查询参数页面发现链接，不递归抓取外站。无参数入口若跳到带参数的站内地址，会保留该最终目标；另列的参数链接可能与目标清单重叠，不能直接相加。去掉片段锚点，依据实际 HTTP 跳转合并地址；canonical 仅记录，不据此强行合并。站外跳转会检查响应但不继续发现该外站链接。HTTP 200 不保证正文完整或排版正确，后续保存时仍需浏览器验证。纯 JavaScript 才生成的链接、登录后内容、未被链接的页面及参数页面不保证覆盖。','', '## 文件入口','', '- [可抓取地址（每行一个）](urls.txt)','- [可抓取清单（JSON，含建议文件名与来源）](crawl-targets.json)','- [全部候选及状态（CSV）](all-candidates.csv)','- [全部候选详细记录](all-candidates.json)','- [失败页面](failed-pages.csv)','- [跳到外站的入口](external-redirects.csv)','- [非 HTML 响应](non-html.csv)','- [站外链接](external-links.json)','- [带参数链接，待决定是否纳入](query-links.json)','- [文件资源链接](asset-links.json)','- [统计与时间](summary.json)','', '发现结果会合并到该站点配置，保留原有目标和文件名；不会自动开始网页归档。','', '## 按一级路径分组','', '| 路径 | 页面数 |','| --- | ---: |']
lines.extend(f'| /{k} | {v} |' for k,v in sorted(summary['groups'].items()))
lines+=['','## 页面列表','','| 页面 | 标题 |','| --- | --- |']
for u,r in sorted(pages.items()): lines.append(f'| [{urlsplit(u).path}]({u}) | '+r['title'].replace('|','\\|').replace('\n',' ')+' |')
(OUT/'README.md').write_text('\n'.join(lines)+'\n')
print(json.dumps(summary,ensure_ascii=False,indent=2),flush=True)
subprocess.run(['node', str(ROOT / 'scripts/merge-discovery.mjs'), '--source=' + SOURCE], check=True)
