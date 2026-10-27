#!/usr/bin/env python3
"""Locate and replace recorded HTML text spans without serializing the DOM."""
import argparse
import hashlib
import html
from html.parser import HTMLParser
import json
from pathlib import Path
import re

SKIP = {'script', 'style', 'svg', 'pre', 'code', 'math'}
VOID = {'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr'}
MATH_CLASS = re.compile(r'(?:^|[\s_-])(?:katex|mathjax|math|equation|formula)(?:$|[\s_-])', re.I)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def read_source(path):
    data = path.read_bytes()
    return data, data.decode('utf-8')


def dump_new(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('x', encoding='utf-8', newline='\n') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')


class TextLocator(HTMLParser):
    def __init__(self, source):
        super().__init__(convert_charrefs=False)
        self.source = source
        self.lines = [0] + [m.end() for m in re.finditer('\n', source)]
        self.stack = []
        self.parts = []
        self.tokens = []

    def source_offset(self):
        row, col = self.getpos()
        return self.lines[row - 1] + col

    def handle_starttag(self, tag, attrs):
        self.tokens.append(self.get_starttag_text())
        values = dict(attrs)
        protected = tag in SKIP or bool(MATH_CLASS.search(values.get('class') or '')) or values.get('role') == 'math' or values.get('translate') == 'no'
        if tag not in VOID:
            self.stack.append((tag, protected))

    def handle_startendtag(self, tag, attrs):
        self.tokens.append(self.get_starttag_text())

    def handle_endtag(self, tag):
        pos = self.source_offset()
        end = self.source.find('>', pos)
        self.tokens.append(self.source[pos:end + 1])
        for i in range(len(self.stack) - 1, -1, -1):
            if self.stack[i][0] == tag:
                del self.stack[i:]
                break

    def add(self, raw):
        if any(protected for _, protected in self.stack):
            return
        start = self.source_offset()
        assert self.source[start:start + len(raw)] == raw
        tag = self.stack[-1][0] if self.stack else ''
        path = '/'.join(t for t, _ in self.stack)
        if self.parts and self.parts[-1]['start'] + len(self.parts[-1]['source']) == start and self.parts[-1]['path'] == path:
            self.parts[-1]['source'] += raw
        else:
            self.parts.append({'start': start, 'source': raw, 'tag': tag, 'path': path})

    def handle_data(self, data):
        self.add(data)

    def entity(self):
        start = self.source_offset()
        match = re.match(r'&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?', self.source[start:])
        if not match:
            raise ValueError('Cannot locate HTML entity at %d' % start)
        self.add(match.group())

    def handle_entityref(self, name):
        self.entity()

    def handle_charref(self, name):
        self.entity()


def locate(source):
    parser = TextLocator(source)
    parser.feed(source)
    parser.close()
    nodes = []
    for part in parser.parts:
        raw = part['source']
        trimmed = raw.strip()
        if not trimmed or not html.unescape(trimmed).strip():
            continue
        lead = len(raw) - len(raw.lstrip())
        node = dict(part, start=part['start'] + lead, source=trimmed, id=len(nodes))
        node['text'] = html.unescape(trimmed)
        node['entities'] = [{'offset': m.start(), 'source': m.group()} for m in re.finditer(r'&(?:#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);?', trimmed)]
        if not re.search(r'[A-Za-z\u3400-\u9fff]', node['text']):
            node['suggested_action'] = 'preserve_numeric_or_punctuation; confirm in context'
        elif re.fullmatch(r'(?:https?://\S+|/[\w./:-]+|[\w.-]+\.(?:py|js|json|ts|md|html)|--[\w-]+|[A-Za-z][\w]*_[\w]+)', node['text']):
            node['suggested_action'] = 'preserve_technical_identifier; confirm in context'
        nodes.append(node)
    for i, node in enumerate(nodes):
        node['context'] = ' | '.join(n['text'] for n in nodes[max(0, i - 2):min(len(nodes), i + 3)])
    return nodes, parser.tokens


def extract(source_path, records):
    if source_path.name.startswith('zh-CN-'):
        raise ValueError('Expected an original source, not a translated copy')
    for name in ('source.json', 'nodes.json'):
        if (records / name).exists():
            raise FileExistsError('Existing extraction protected: ' + str(records / name))
    data, source = read_source(source_path)
    nodes, _ = locate(source)
    manifest = {'source': str(source_path.resolve()), 'bytes': len(data), 'sha256': digest(data), 'encoding': 'utf-8', 'offset_unit': 'Python Unicode characters', 'nodes': len(nodes), 'status': 'extracted', 'skipped_tags': sorted(SKIP), 'output': str(source_path.with_name('zh-CN-' + source_path.name).resolve())}
    dump_new(records / 'source.json', manifest)
    dump_new(records / 'nodes.json', nodes)
    return manifest


def apply(source_path, records):
    manifest = json.loads((records / 'source.json').read_text())
    data, source = read_source(source_path)
    if str(source_path.resolve()) != manifest['source'] or digest(data) != manifest['sha256']:
        raise ValueError('Source path/hash changed; re-extract')
    nodes = json.loads((records / 'nodes.json').read_text())
    fresh, source_tokens = locate(source)
    if nodes != fresh:
        raise ValueError('Extracted records changed; do not edit source records')
    decisions = json.loads((records / 'translations.json').read_text())
    if not isinstance(decisions, list):
        raise ValueError('translations.json must be a list')
    ids = [d.get('id') for d in decisions]
    if len(ids) != len(set(ids)) or set(ids) != set(range(len(nodes))):
        raise ValueError('Missing, duplicate, or unknown translation ids')
    indexed = {d['id']: d for d in decisions}
    replacements = []
    for node in nodes:
        decision = indexed[node['id']]
        if decision.get('source') != node['source'] or not isinstance(decision.get('translation'), str):
            raise ValueError('Source mismatch or missing translation at id %s' % node['id'])
        translation = decision['translation']
        unchanged = translation in (node['source'], node['text'])
        if (unchanged or not translation) and not str(decision.get('reason', '')).strip():
            raise ValueError('Unchanged/empty decision requires reason at id %s' % node['id'])
        replacement = node['source'] if unchanged else html.escape(translation, quote=False)
        replacements.append((node['start'], node['source'], replacement))
    output = source
    for start, old, new in reversed(replacements):
        if output[start:start + len(old)] != old:
            raise ValueError('Offset assertion failed at %d' % start)
        output = output[:start] + new + output[start + len(old):]
    src_pos = out_pos = 0
    for start, old, new in replacements:
        count = start - src_pos
        if source[src_pos:start] != output[out_pos:out_pos + count]:
            raise ValueError('Unexpected mutation outside recorded spans')
        out_pos += count
        if output[out_pos:out_pos + len(new)] != new:
            raise ValueError('Replacement mismatch')
        src_pos = start + len(old)
        out_pos += len(new)
    if source[src_pos:] != output[out_pos:]:
        raise ValueError('Unexpected trailing mutation')
    _, output_tokens = locate(output)
    if source_tokens != output_tokens:
        raise ValueError('HTML tag/attribute tokens changed')
    if digest(source_path.read_bytes()) != manifest['sha256']:
        raise ValueError('Original changed during processing')
    target = source_path.with_name('zh-CN-' + source_path.name)
    verification = {'source': manifest['source'], 'sourceSha256': manifest['sha256'], 'output': str(target.resolve()), 'outputSha256': digest(output.encode('utf-8')), 'nodeCount': len(nodes), 'changedNodes': sum(a != b for _, a, b in replacements), 'allNodeDecisionsPresent': True, 'outsideRecordedSpansIdentical': True, 'tagAndAttributeTokensIdentical': True, 'sourceUnchanged': True, 'status': 'structure_verified_pending_content_and_visual_review', 'contentReview': 'pending', 'browserReview': 'pending', 'registeredInIndex': False}
    if target.exists() or (records / 'verification.json').exists():
        raise FileExistsError('Existing translated output/verification protected')
    with target.open('xb') as stream:
        stream.write(output.encode('utf-8'))
    dump_new(records / 'verification.json', verification)
    return verification


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('extract')
    p.add_argument('source', type=Path)
    p.add_argument('--output', type=Path, required=True)
    p = sub.add_parser('apply')
    p.add_argument('source', type=Path)
    p.add_argument('--records', type=Path, required=True)
    args = parser.parse_args()
    result = extract(args.source, args.output) if args.command == 'extract' else apply(args.source, args.records)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()
