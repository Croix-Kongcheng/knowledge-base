import { fromMarkdown } from 'mdast-util-from-markdown';

export interface ImportLink {
  start: number;
  end: number;
  targetStart: number;
  targetEnd: number;
  target: string;
  label: string;
  embedded: boolean;
  wiki: boolean;
  definition?: { start: number; end: number };
}

interface MarkdownNode {
  type: string;
  children?: MarkdownNode[];
  url?: string;
  identifier?: string;
  position?: { start: { offset?: number }; end: { offset?: number } };
}

interface SourceRange { start: number; end: number }

function mergedRanges(ranges: SourceRange[]): SourceRange[] {
  const ordered = ranges.slice().sort((left, right) => left.start - right.start || right.end - left.end);
  const merged: SourceRange[] = [];
  for (const value of ordered) {
    const previous = merged[merged.length - 1];
    if (previous && value.start <= previous.end) previous.end = Math.max(previous.end, value.end);
    else merged.push({ ...value });
  }
  return merged;
}

function firstEndingAfter(ranges: SourceRange[], offset: number): number {
  let low = 0, high = ranges.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (ranges[middle].end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function intersects(start: number, end: number, ranges: SourceRange[]): boolean {
  const index = firstEndingAfter(ranges, start);
  return index < ranges.length && ranges[index].start < end;
}

function enclosed(start: number, end: number, ranges: SourceRange[]): boolean {
  const index = firstEndingAfter(ranges, start);
  return index < ranges.length && ranges[index].start <= start && ranges[index].end >= end;
}

const range = (node: MarkdownNode) => ({ start: node.position?.start.offset ?? 0, end: node.position?.end.offset ?? 0 });
const escaped = (text: string, at: number) => {
  let count = 0;
  while (at > 0 && text[--at] === '\\') count++;
  return count % 2 === 1;
};

/** Locate the outer label, skipping escapes and inline code in its contents. */
function labelEnd(text: string, start: number): number {
  let depth = 1;
  for (let index = start + 1; index < text.length; index++) {
    if (text[index] === '\\') { index++; continue; }
    if (text[index] === '`') {
      let count = 1;
      while (text[index + count] === '`') count++;
      const close = text.indexOf('`'.repeat(count), index + count);
      if (close >= 0) { index = close + count - 1; continue; }
    }
    if (text[index] === '[') depth++;
    else if (text[index] === ']' && --depth === 0) return index;
  }
  return -1;
}

function destination(text: string, start: number, end: number): { start: number; end: number } | undefined {
  while (start < end && /\s/.test(text[start])) start++;
  while (end > start && /\s/.test(text[end - 1])) end--;
  if (text[start] === '<') {
    const close = text.indexOf('>', start + 1);
    if (close >= 0 && close < end) return { start: start + 1, end: close };
  }
  // Obsidian accepts spaces and balanced parentheses in file destinations.
  // A final quoted title belongs to the link syntax, not the file path.
  const title = /\s+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\))\s*$/.exec(text.slice(start, end));
  if (title) end = start + title.index;
  return end > start ? { start, end } : undefined;
}

/** Extract exact source spans, so unrelated Markdown bytes never get serialized. */
export function collectImportLinks(text: string): ImportLink[] {
  const root = fromMarkdown(text) as MarkdownNode;
  const protectedRanges: { start: number; end: number }[] = [];
  const occupied: { start: number; end: number }[] = [];
  const definitions = new Map<string, MarkdownNode>();
  const nodes: MarkdownNode[] = [];
  const walk = (node: MarkdownNode) => {
    if (['code', 'inlineCode', 'html'].includes(node.type)) { protectedRanges.push(range(node)); return; }
    if (node.type === 'definition') {
      if (node.identifier && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
      protectedRanges.push(range(node));
    }
    if (['link', 'image', 'linkReference', 'imageReference'].includes(node.type)) nodes.push(node);
    for (const child of node.children || []) walk(child);
  };
  walk(root);
  for (const comment of text.matchAll(/<!--[^]*?(?:-->|$)|%%[^]*?(?:%%|$)/g)) {
    protectedRanges.push({ start: comment.index!, end: comment.index! + comment[0].length });
  }
  const protectedIndex = mergedRanges(protectedRanges);
  const links: ImportLink[] = [];
  for (const node of nodes) {
    const span = range(node);
    // Code in a label, such as [`API`](reference.md), does not turn the
    // destination into a code example. Only enclosing protected spans do.
    if (enclosed(span.start, span.end, protectedIndex)) continue;
    const embedded = node.type === 'image' || node.type === 'imageReference';
    const bracket = span.start + (embedded ? 1 : 0);
    const close = labelEnd(text, bracket);
    if (close < 0) continue;
    const label = text.slice(bracket + 1, close);
    let targetRange: { start: number; end: number } | undefined;
    let target = node.url;
    let definition: ImportLink['definition'];
    if (node.type.endsWith('Reference')) {
      const defined = definitions.get(node.identifier || '');
      if (!defined?.url) continue;
      definition = range(defined);
      const definitionClose = labelEnd(text, definition.start);
      targetRange = destination(text, definitionClose + 2, definition.end);
      target = defined.url;
    } else {
      let open = close + 1;
      while (open < span.end && /\s/.test(text[open])) open++;
      if (text[open] === '(') targetRange = destination(text, open + 1, span.end - 1);
    }
    if (targetRange && target !== undefined) {
      links.push({ ...span, targetStart: targetRange.start, targetEnd: targetRange.end, target, label, embedded, wiki: false, definition });
      occupied.push(span);
    }
  }
  const astOccupied = mergedRanges(occupied);
  // Wiki syntax stays text to CommonMark. Scan it only outside parsed code,
  // comments and existing Markdown links, including Obsidian note embeds.
  for (const match of text.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (escaped(text, start) || intersects(start, end, protectedIndex) || intersects(start, end, astOccupied)) continue;
    const [target, ...alias] = match[2].split('|');
    links.push({ start, end, targetStart: start, targetEnd: end, target: target.trim(),
      label: alias.join('|').trim() || target.split('#')[0].trim(), embedded: !!match[1], wiki: true });
    occupied.push({ start, end });
  }
  const looseOccupied = mergedRanges(occupied);
  // CommonMark rejects unescaped spaces in (...), but existing Obsidian vaults
  // frequently contain them. Accept balanced forms without disturbing valid AST
  // links, reference links, escaped examples, or protected code/comment spans.
  for (let index = 0; index < text.length; index++) {
    const start = index;
    const embedded = text[index] === '!' && text[index + 1] === '[';
    const bracket = index + (embedded ? 1 : 0);
    if (text[bracket] !== '[' || text[bracket + 1] === '[' || escaped(text, start)) continue;
    if (intersects(start, bracket + 1, protectedIndex) || intersects(start, bracket + 1, looseOccupied)) continue;
    const close = labelEnd(text, bracket);
    if (close < 0 || text[close + 1] !== '(') continue;
    let depth = 1, end = close + 2;
    for (; end < text.length; end++) {
      if (text[end] === '\n') break;
      if (text[end] === '\\') { end++; continue; }
      if (text[end] === '(') depth++;
      else if (text[end] === ')' && --depth === 0) break;
    }
    if (depth || end >= text.length || intersects(start, end + 1, protectedIndex) || intersects(start, end + 1, looseOccupied)) continue;
    const targetRange = destination(text, close + 2, end);
    if (!targetRange) continue;
    links.push({ start, end: end + 1, targetStart: targetRange.start, targetEnd: targetRange.end,
      target: text.slice(targetRange.start, targetRange.end).replace(/\\([\p{P}\p{S}])/gu, '$1'),
      label: text.slice(bracket + 1, close), embedded, wiki: false });
    index = end;
  }
  return links.sort((left, right) => left.start - right.start);
}
