import { fromMarkdown } from 'mdast-util-from-markdown';

function labelEnd(text, start, end) {
  let depth = 1;
  for (let index = start + 1; index < end; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '`') {
      let width = 1;
      while (text[index + width] === '`') width++;
      const close = text.indexOf('`'.repeat(width), index + width);
      if (close >= 0 && close < end) { index = close + width - 1; continue; }
    }
    if (text[index] === '[') depth++;
    else if (text[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

function destinationRange(text, node) {
  const start = node.position?.start.offset, end = node.position?.end.offset;
  if (start === undefined || end === undefined) return;
  const close = labelEnd(text, start + (node.type === 'image' ? 1 : 0), end);
  if (close < 0) return;
  let cursor = close + 1;
  if (node.type === 'definition') {
    if (text[cursor++] !== ':') return;
  } else {
    while (/\s/.test(text[cursor] || '') && cursor < end) cursor++;
    if (text[cursor++] !== '(') return;
  }
  while (/\s/.test(text[cursor] || '') && cursor < end) cursor++;
  if (text[cursor] === '<') {
    const begin = ++cursor;
    for (; cursor < end; cursor++) {
      if (text[cursor] === '\\') cursor++;
      else if (text[cursor] === '>') return { start: begin, end: cursor };
    }
    return;
  }
  const begin = cursor;
  let depth = 0;
  for (; cursor < end; cursor++) {
    const char = text[cursor];
    if (char === '\\') { cursor++; continue; }
    if (/\s/.test(char)) break;
    if (char === '(') depth++;
    else if (char === ')' && !depth--) break;
  }
  return cursor > begin ? { start: begin, end: cursor } : undefined;
}

/** Rewrite only actual Markdown destinations; retain labels, code and source formatting. */
export function remapImportedNoteLinks(content, idMap) {
  if (idMap.size === 0 || !content.includes('[')) return content;
  const links = [], definitions = new Map(), referenced = new Set();
  const root = fromMarkdown(content);
  const codeRanges = [], codeStack = [root];
  while (codeStack.length) {
    const node = codeStack.pop();
    if (['code', 'inlineCode', 'html'].includes(node.type)) {
      const start = node.position?.start.offset, end = node.position?.end.offset;
      if (start !== undefined && end !== undefined) codeRanges.push({ start, end });
    } else if (node.children) for (const child of node.children) codeStack.push(child);
  }
  codeRanges.sort((left, right) => left.start - right.start);
  const enclosed = (ranges, start, end) => {
    let low = 0, high = ranges.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (ranges[middle].end <= start) low = middle + 1;
      else high = middle;
    }
    return low < ranges.length && ranges[low].start <= start && ranges[low].end >= end;
  };
  const protectedComments = [];
  let commentStart;
  for (const marker of content.matchAll(/%%/g)) {
    if (enclosed(codeRanges, marker.index, marker.index + 2)) continue;
    if (commentStart === undefined) commentStart = marker.index;
    else { protectedComments.push({ start: commentStart, end: marker.index + 2 }); commentStart = undefined; }
  }
  if (commentStart !== undefined) protectedComments.push({ start: commentStart, end: content.length });
  const stack = [root];
  while (stack.length) {
    const node = stack.pop();
    if (['code', 'inlineCode', 'html'].includes(node.type)) continue;
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (start !== undefined && end !== undefined && enclosed(protectedComments, start, end)) continue;
    if (node.type === 'link' || node.type === 'image') links.push(node);
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === 'linkReference' || node.type === 'imageReference') referenced.add(node.identifier);
    if (node.children) for (let index = node.children.length - 1; index >= 0; index--) stack.push(node.children[index]);
  }
  for (const identifier of referenced) if (definitions.has(identifier)) links.push(definitions.get(identifier));
  const edits = new Map();
  for (const node of links) {
    if (!node.url?.startsWith('#note/')) continue;
    let source;
    try { source = decodeURIComponent(node.url.slice(6)); } catch { continue; }
    const target = idMap.get(source);
    if (!target || target === source) continue;
    const range = destinationRange(content, node);
    if (range) edits.set(`${range.start}:${range.end}`, { ...range, value: `#note/${encodeURIComponent(target)}` });
  }
  const pieces = [];
  let cursor = 0;
  for (const edit of [...edits.values()].sort((left, right) => left.start - right.start)) {
    pieces.push(content.slice(cursor, edit.start), edit.value);
    cursor = edit.end;
  }
  pieces.push(content.slice(cursor));
  return pieces.join('');
}
