import { forwardRef, useImperativeHandle, useLayoutEffect, useRef } from 'react';
import { Annotation, ChangeSet, Compartment, EditorSelection, EditorState, Prec, StateEffect, StateField, Transaction, type Range, type StateCommand } from '@codemirror/state';
import { Decoration, EditorView, WidgetType, drawSelection, dropCursor, keymap, placeholder, type DecorationSet } from '@codemirror/view';
import { defaultKeymap, historyKeymap, isolateHistory, redo, undo } from '@codemirror/commands';
import { syntaxTree } from '@codemirror/language';
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { assetIdFromReference } from '../lib/assets';
import { useReadingPreferences } from '../lib/useReadingPreferences';
import './LiveMarkdownEditor.css';

export interface LiveMarkdownHandle {
  focus(): void;
  getValue(): string;
  insert(before: string, after?: string, fallback?: string): void;
  insertText(text: string, options?: { block?: boolean }): void;
  replaceToken(token: string, replacement: string): boolean;
}

interface LiveMarkdownEditorProps {
  value: string;
  onChange: (value: string) => void;
  onPasteImages: (files: File[]) => void;
  attachments?: Record<string, string>;
  active?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
}

const refreshPreview = StateEffect.define<null>();
const externalChange = Annotation.define<boolean>();
type Attachments = Record<string, string>;
const EMPTY_ATTACHMENTS: Attachments = {};
interface EditSnapshot { text: string; selection: EditorSelection }
interface EditHistory { entries: EditSnapshot[]; index: number; lastEvent: string; lastTime: number }
const historyJump = StateEffect.define<number>();
const imageResolved = StateEffect.define<{ token: string; replacement: string }>();

function resolveSnapshot(snapshot: EditSnapshot, token: string, replacement: string): EditSnapshot {
  const changes: { from: number; to: number; insert: string }[] = [];
  for (let from = snapshot.text.indexOf(token); from >= 0; from = snapshot.text.indexOf(token, from + token.length)) changes.push({ from, to: from + token.length, insert: replacement });
  if (!changes.length) return snapshot;
  const mapping = ChangeSet.of(changes, snapshot.text.length);
  return { text: snapshot.text.split(token).join(replacement), selection: snapshot.selection.map(mapping) };
}

/** Image uploads update existing history versions, never create a new undo step. */
const imageHistoryEffects = StateField.define<EditHistory>({
  create: state => ({ entries: [{ text: state.doc.toString(), selection: state.selection }], index: 0, lastEvent: '', lastTime: 0 }),
  update(history, transaction) {
    let entries = history.entries;
    for (const effect of transaction.effects) {
      if (effect.is(imageResolved)) entries = entries.map(entry => resolveSnapshot(entry, effect.value.token, effect.value.replacement));
    }
    const jump = transaction.effects.find(effect => effect.is(historyJump));
    if (jump?.is(historyJump)) return { entries, index: jump.value, lastEvent: '', lastTime: 0 };
    if (!transaction.docChanged) return entries === history.entries ? history : { ...history, entries };
    const snapshot = { text: transaction.newDoc.toString(), selection: transaction.newSelection };
    if (transaction.annotation(Transaction.addToHistory) === false) {
      entries = entries.slice();
      entries[history.index] = snapshot;
      return { ...history, entries };
    }
    const event = transaction.annotation(Transaction.userEvent) || '';
    const time = transaction.annotation(Transaction.time) || Date.now();
    const isolated = transaction.annotation(isolateHistory);
    const typing = event.startsWith('input.type') && history.lastEvent.startsWith('input.type')
      || event === 'external.source' && history.lastEvent === 'external.source';
    const deleting = event.startsWith('delete') && history.lastEvent.startsWith('delete');
    const composing = event === 'input.type.compose' && history.lastEvent.startsWith('input.type.compose');
    const join = history.index > 0 && !isolated && (composing || ((typing || deleting) && time - history.lastTime < 500 && transaction.startState.selection.eq(entries[history.index].selection)));
    entries = entries.slice(0, history.index + 1);
    if (join) entries[entries.length - 1] = snapshot;
    else entries.push(snapshot);
    // Bound retained text for long imported documents on the Orange Pi.
    let retained = entries.reduce((total, entry) => total + entry.text.length, 0);
    while (entries.length > 2 && (entries.length > 100 || retained > 8 * 1024 ** 2)) retained -= entries.shift()!.text.length;
    return { entries, index: entries.length - 1, lastEvent: isolated ? '' : event, lastTime: time };
  },
});

function runImageHistory(target: { state: EditorState; dispatch: (transaction: Transaction) => void }, command: StateCommand, resolutions: Map<string, string>): boolean {
  if (target.state.readOnly) return false;
  const history = target.state.field(imageHistoryEffects);
  const index = history.index + (command === undo ? -1 : 1);
  if (index < 0 || index >= history.entries.length) return false;
  let snapshot = history.entries[index];
  const effects: StateEffect<unknown>[] = [historyJump.of(index)];
  for (const [token, replacement] of resolutions) {
    const resolved = resolveSnapshot(snapshot, token, replacement);
    if (resolved !== snapshot) { snapshot = resolved; effects.push(imageResolved.of({ token, replacement })); }
  }
  target.dispatch(target.state.update({ changes: { from: 0, to: target.state.doc.length, insert: snapshot.text }, selection: snapshot.selection, effects, annotations: Transaction.addToHistory.of(false), userEvent: command === undo ? 'undo' : 'redo', scrollIntoView: true }));
  return true;
}

function unescapeMarkdown(value: string): string {
  return value.replace(/\\([\\`*{}\[\]()#+.!_>~|])/g, '$1');
}

/** Resolve attachment aliases without ever accepting executable URL schemes. */
function imageURL(source: string, attachments: Attachments): string | null {
  let candidate = unescapeMarkdown(source.trim().replace(/^<|>$/g, ''));
  let decoded = candidate;
  try { decoded = decodeURIComponent(candidate); } catch { /* A literal percent is valid in a filename. */ }
  const alias = Object.prototype.hasOwnProperty.call(attachments, candidate) ? attachments[candidate]
    : Object.prototype.hasOwnProperty.call(attachments, decoded) ? attachments[decoded] : undefined;
  if (typeof alias === 'string' && alias) candidate = alias;
  const id = assetIdFromReference(candidate);
  if (id) return `/api/assets/${encodeURIComponent(id)}`;
  if (/^https?:\/\/[^\s]+$/i.test(candidate)) return candidate;
  if (/^data:image\/(?:png|jpe?g|gif|webp|svg\+xml|avif|bmp|x-icon|vnd\.microsoft\.icon);base64,[a-z\d+/=\s]+$/i.test(candidate)) return candidate;
  if (/^\/api\/assets\/[a-z\d][a-z\d_-]{0,127}$/i.test(candidate)) return candidate;
  return null;
}

function safeLink(source: string): string | null {
  const candidate = unescapeMarkdown(source.trim().replace(/^<|>$/g, ''));
  return /^(?:https?:\/\/|mailto:|#note\/|#)/i.test(candidate) ? candidate : null;
}

function selectSource(view: EditorView, position: number) {
  view.dispatch({ selection: { anchor: Math.min(position, view.state.doc.length) }, scrollIntoView: true });
  view.focus();
}

function imageElement(source: string, alt: string, attachments: Attachments, view: EditorView): HTMLElement {
  const root = document.createElement('span');
  root.className = 'ne-live-image-content';
  if (/^pending-image:[a-z\d_-]+$/i.test(source)) {
    root.classList.add('ne-live-image-pending');
    root.setAttribute('role', 'status');
    root.textContent = '正在上传图片…';
    return root;
  }
  const url = imageURL(source, attachments);
  if (!url) {
    root.classList.add('ne-live-image-unavailable');
    root.textContent = alt ? `图片：${alt}` : '图片路径不可用';
    return root;
  }
  const image = document.createElement('img');
  image.src = url;
  image.alt = alt || '笔记图片';
  image.loading = 'lazy';
  image.decoding = 'async';
  image.addEventListener('load', () => view.requestMeasure());
  image.addEventListener('error', () => {
    root.classList.add('ne-live-image-unavailable');
    root.textContent = alt ? `图片加载失败：${alt}` : '图片加载失败，请检查附件';
    view.requestMeasure();
  });
  root.append(image);
  return root;
}

class ImagePreview extends WidgetType {
  constructor(readonly source: string, readonly alt: string, readonly position: number, readonly block: boolean, readonly attachments: Attachments) { super(); }
  eq(other: ImagePreview) {
    return this.source === other.source && this.alt === other.alt && this.position === other.position && this.block === other.block && imageURL(this.source, this.attachments) === imageURL(other.source, other.attachments);
  }
  toDOM(view: EditorView) {
    const root = document.createElement(this.block ? 'div' : 'span');
    root.className = `ne-live-image ${this.block ? 'ne-live-image-block' : 'ne-live-image-inline'}`;
    root.append(imageElement(this.source, this.alt, this.attachments, view));
    root.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    root.addEventListener('mouseup', event => { event.preventDefault(); event.stopPropagation(); });
    root.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); selectSource(view, this.position); });
    return root;
  }
  ignoreEvent() { return true; }
}

/** Build a cell using text nodes and a small safe Markdown vocabulary, never HTML. */
function renderInline(target: HTMLElement, text: string, attachments: Attachments, view: EditorView) {
  const tree = markdownLanguage.parser.parse(text);
  type InlineNode = typeof tree.topNode;
  const appendChildren = (parent: HTMLElement, node: InlineNode, from = node.from, to = node.to) => {
    let at = from;
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.to <= from || child.from >= to) continue;
      const start = Math.max(child.from, from);
      if (start > at) parent.append(document.createTextNode(unescapeMarkdown(text.slice(at, start))));
      appendNode(parent, child);
      at = Math.min(child.to, to);
    }
    if (at < to) parent.append(document.createTextNode(unescapeMarkdown(text.slice(at, to))));
  };
  const appendNode = (parent: HTMLElement, node: InlineNode) => {
    if (/^(?:EmphasisMark|StrikethroughMark|CodeMark|LinkMark)$/.test(node.name)) return;
    const tag = ({ StrongEmphasis: 'strong', Emphasis: 'em', Strikethrough: 's', InlineCode: 'code' } as Record<string, string>)[node.name];
    if (tag) {
      const element = document.createElement(tag);
      appendChildren(element, node);
      parent.append(element);
    } else if (node.name === 'Image') {
      const source = node.getChild('URL');
      const label = text.slice(node.from + 2, text.indexOf(']', node.from + 2));
      if (source) parent.append(imageElement(text.slice(source.from, source.to), label, attachments, view));
      else parent.append(document.createTextNode(text.slice(node.from, node.to)));
    } else if (node.name === 'Link') {
      const url = node.getChild('URL');
      const href = url ? safeLink(text.slice(url.from, url.to)) : null;
      const labelEnd = text.indexOf(']', node.from + 1);
      const label = labelEnd > node.from ? text.slice(node.from + 1, labelEnd) : text.slice(node.from, node.to);
      if (href) {
        const element = document.createElement('a');
        element.href = href; element.rel = 'noopener noreferrer'; element.target = '_blank'; element.textContent = unescapeMarkdown(label);
        parent.append(element);
      } else parent.append(document.createTextNode(unescapeMarkdown(label)));
    } else if (node.firstChild) appendChildren(parent, node);
    else parent.append(document.createTextNode(unescapeMarkdown(text.slice(node.from, node.to))));
  };
  appendChildren(target, tree.topNode);
}

class TablePreview extends WidgetType {
  constructor(readonly text: string, readonly position: number, readonly attachments: Attachments) { super(); }
  eq(other: TablePreview) { return this.text === other.text && this.position === other.position && this.attachments === other.attachments; }
  toDOM(view: EditorView) {
    const root = document.createElement('div');
    root.className = 'ne-live-table';
    root.setAttribute('aria-label', '表格预览，点击编辑');
    const table = document.createElement('table');
    const head = document.createElement('thead');
    const body = document.createElement('tbody');
    const tree = markdownLanguage.parser.parse(this.text);
    const tableNode = tree.topNode.getChild('Table');
    const delimiter = tableNode?.getChildren('TableDelimiter').find(node => this.text.slice(node.from, node.to).includes('-'));
    const alignments = delimiter ? this.text.slice(delimiter.from, delimiter.to).trim().replace(/^\||\|$/g, '').split('|').map(value => {
      const trimmed = value.trim();
      return trimmed.startsWith(':') && trimmed.endsWith(':') ? 'center' : trimmed.endsWith(':') ? 'right' : 'left';
    }) : [];
    if (tableNode) for (let row = tableNode.firstChild; row; row = row.nextSibling) {
      if (row.name !== 'TableHeader' && row.name !== 'TableRow') continue;
      const element = document.createElement('tr');
      const cells: string[] = [];
      let start = row.from;
      for (const delimiter of row.getChildren('TableDelimiter')) {
        if (delimiter.from !== row.from) cells.push(this.text.slice(start, delimiter.from).trim());
        start = delimiter.to;
      }
      if (start < row.to) cells.push(this.text.slice(start, row.to).trim());
      cells.forEach((cell, index) => {
        const td = document.createElement(row!.name === 'TableHeader' ? 'th' : 'td');
        td.style.textAlign = alignments[index] || 'left';
        renderInline(td, cell, this.attachments, view);
        element.append(td);
      });
      (row.name === 'TableHeader' ? head : body).append(element);
    }
    table.append(head, body);
    root.append(table);
    root.addEventListener('mousedown', event => { event.preventDefault(); event.stopPropagation(); });
    root.addEventListener('mouseup', event => { event.preventDefault(); event.stopPropagation(); });
    root.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); selectSource(view, this.position); });
    return root;
  }
  ignoreEvent() { return true; }
}

function intersectsSelection(state: EditorState, from: number, to: number) {
  return state.selection.ranges.some(range => range.empty ? range.from >= from && range.from <= to : range.from <= to && range.to >= from);
}

function buildPreview(state: EditorState, attachments: Attachments): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  const doc = state.doc;
  const hidden: Array<{ from: number; to: number }> = [];
  const addMark = (from: number, to: number, className: string) => { if (from < to) ranges.push(Decoration.mark({ class: className }).range(from, to)); };
  syntaxTree(state).iterate({
    enter(node) {
      const { name, from, to } = node;
      const current = node.node;
      if (name === 'Table' && !intersectsSelection(state, from, to)) {
        ranges.push(Decoration.replace({ widget: new TablePreview(doc.sliceString(from, to), from, attachments), block: true }).range(from, to));
        hidden.push({ from, to });
        return false;
      }
      if (/^(?:FencedCode|CodeBlock|HTMLBlock)$/.test(name)) {
        for (let line = doc.lineAt(from); line.from <= to; line = doc.lineAt(line.to + 1)) {
          ranges.push(Decoration.line({ class: 'cm-source-code-line' }).range(line.from));
          if (line.to >= to || line.to === doc.length) break;
        }
        return false;
      }
      if (name === 'Image') {
        const url = current.getChild('URL');
        if (!url) return;
        const source = doc.sliceString(url.from, url.to);
        const raw = doc.sliceString(from, to);
        const alt = unescapeMarkdown(raw.slice(2, raw.indexOf(']')));
        const line = doc.lineAt(from);
        const standalone = line.from <= from && doc.lineAt(to).number === line.number && !doc.sliceString(line.from, from).trim() && !doc.sliceString(to, line.to).trim();
        const active = intersectsSelection(state, from, to);
        const widget = new ImagePreview(source, alt, from, standalone, attachments);
        if (!active) {
          ranges.push(Decoration.replace({ widget, block: standalone }).range(standalone ? line.from : from, standalone ? line.to : to));
          hidden.push({ from, to });
        } else ranges.push(Decoration.widget({ widget, block: standalone, side: 1 }).range(standalone ? line.to : to));
        return false;
      }
      const style = ({ StrongEmphasis: 'cm-live-strong', Emphasis: 'cm-live-emphasis', Strikethrough: 'cm-live-strike', InlineCode: 'cm-live-inline-code', Blockquote: 'cm-live-quote' } as Record<string, string>)[name];
      if (style) addMark(from, to, style);
      if (/^(?:ATXHeading|SetextHeading)\d$/.test(name)) {
        const level = name.slice(-1);
        for (let line = doc.lineAt(from); line.from <= to; line = doc.lineAt(line.to + 1)) {
          ranges.push(Decoration.line({ class: `cm-live-heading cm-live-heading-${level}` }).range(line.from));
          if (line.to >= to || line.to === doc.length) break;
        }
      }
      if (/^(?:EmphasisMark|StrikethroughMark|CodeMark|HeaderMark|QuoteMark)$/.test(name)) {
        const parent = current.parent;
        if (parent && !intersectsSelection(state, parent.from, parent.to)) {
          let end = to;
          if ((name === 'HeaderMark' || name === 'QuoteMark') && doc.sliceString(to, to + 1) === ' ') end++;
          ranges.push(Decoration.replace({}).range(from, end));
        } else addMark(from, to, 'cm-live-markup');
      }
      if (name === 'Link') addMark(from, to, 'cm-live-link');
      if (name === 'Paragraph') ranges.push(Decoration.line({ class: 'cm-paragraph-end' }).range(doc.lineAt(to).from));
    },
  });
  // Obsidian embeds may still use attachment aliases rather than Markdown links.
  const text = doc.toString();
  const embeds = /!\[\[([^\]\n]+)\]\]/g;
  for (let match = embeds.exec(text); match; match = embeds.exec(text)) {
    const from = match.index;
    const to = from + match[0].length;
    if (hidden.some(range => from >= range.from && to <= range.to)) continue;
    const syntax = syntaxTree(state).resolveInner(from, 1);
    let code = false;
    for (let parent = syntax; parent; parent = parent.parent!) {
      if (/^(?:FencedCode|CodeBlock|InlineCode|HTMLBlock|HTMLTag)$/.test(parent.name)) { code = true; break; }
      if (!parent.parent) break;
    }
    if (code) continue;
    const [source, label] = match[1].split('|');
    const line = doc.lineAt(from);
    const standalone = !doc.sliceString(line.from, from).trim() && !doc.sliceString(to, line.to).trim();
    const widget = new ImagePreview(source, label || source, from, standalone, attachments);
    if (intersectsSelection(state, from, to)) ranges.push(Decoration.widget({ widget, block: standalone, side: 1 }).range(standalone ? line.to : to));
    else ranges.push(Decoration.replace({ widget, block: standalone }).range(standalone ? line.from : from, standalone ? line.to : to));
  }
  return Decoration.set(ranges, true);
}

function insertAround(view: EditorView, before: string, after = '', fallback = '文字', toggle = false) {
  if (view.state.readOnly) return;
  const { from, to } = view.state.selection.main;
  const selected = view.state.sliceDoc(from, to);
  if (toggle && from >= before.length && view.state.sliceDoc(from - before.length, from) === before && view.state.sliceDoc(to, to + after.length) === after) {
    view.dispatch({ changes: [{ from: from - before.length, to: from }, { from: to, to: to + after.length }], selection: EditorSelection.range(from - before.length, to - before.length), userEvent: 'input' });
  } else {
    const inside = selected || fallback;
    view.dispatch({ changes: { from, to, insert: before + inside + after }, selection: EditorSelection.range(from + before.length, from + before.length + inside.length), userEvent: 'input' });
  }
  view.focus();
}

const LiveMarkdownEditor = forwardRef<LiveMarkdownHandle, LiveMarkdownEditorProps>(function LiveMarkdownEditor({ value, onChange, onPasteImages, attachments = EMPTY_ATTACHMENTS, active = true, disabled = false, autoFocus = false }, ref) {
  const { preferences } = useReadingPreferences();
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const callbacks = useRef({ onChange, onPasteImages });
  callbacks.current = { onChange, onPasteImages };
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const imageResolutions = useRef(new Map<string, string>());
  const editable = useRef(new Compartment());
  const accessibility = useRef(new Compartment());
  const attributes = (isActive: boolean) => ({ role: 'textbox', 'aria-multiline': 'true', 'aria-label': isActive ? '笔记内容' : 'Markdown 实时编辑器', ...(isActive ? { id: 'ne-content' } : {}) });

  useImperativeHandle(ref, () => ({
    focus() { view.current?.focus(); },
    getValue() { return view.current?.state.doc.toString() || ''; },
    insert(before, after, fallback) { if (view.current) insertAround(view.current, before, after, fallback); },
    insertText(text, options) {
      const editor = view.current;
      if (!editor || editor.state.readOnly) return;
      const { from, to } = editor.state.selection.main;
      const before = editor.state.sliceDoc(Math.max(0, from - 2), from);
      const after = editor.state.sliceDoc(to, Math.min(to + 2, editor.state.doc.length));
      const prefix = !options?.block || !from || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
      const suffix = !options?.block || after.startsWith('\n\n') ? '' : after.startsWith('\n') ? '\n' : '\n\n';
      editor.dispatch({ changes: { from, to, insert: prefix + text + suffix }, selection: { anchor: from + prefix.length + text.length + suffix.length }, userEvent: 'input.paste', annotations: isolateHistory.of('full') });
      editor.focus();
    },
    replaceToken(token, replacement) {
      const editor = view.current;
      if (!editor || !token) return false;
      imageResolutions.current.set(token, replacement);
      const text = editor.state.doc.toString();
      const changes: { from: number; to: number; insert: string }[] = [];
      for (let from = text.indexOf(token); from >= 0; from = text.indexOf(token, from + token.length)) changes.push({ from, to: from + token.length, insert: replacement });
      editor.dispatch({ changes, effects: imageResolved.of({ token, replacement }), annotations: Transaction.addToHistory.of(false) });
      return changes.length > 0;
    },
  }), []);

  useLayoutEffect(() => {
    if (!host.current) return;
    const preview = StateField.define<DecorationSet>({
      create: state => buildPreview(state, attachmentsRef.current),
      update: (decorations, transaction) => transaction.docChanged || transaction.selection || transaction.effects.some(effect => effect.is(refreshPreview)) || syntaxTree(transaction.startState) !== syntaxTree(transaction.state) ? buildPreview(transaction.state, attachmentsRef.current) : decorations,
      provide: field => EditorView.decorations.from(field),
    });
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: value,
        extensions: [
          markdown({ base: markdownLanguage, completeHTMLTags: false, pasteURLAsLink: false }),
          imageHistoryEffects, drawSelection(), dropCursor(), EditorView.lineWrapping,
          placeholder('写下你的想法…支持 Markdown，也可以直接粘贴图片'),
          keymap.of([
            { key: 'Mod-b', run: current => { insertAround(current, '**', '**', '文字', true); return true; } },
            { key: 'Mod-i', run: current => { insertAround(current, '*', '*', '文字', true); return true; } },
            { key: 'Mod-z', run: current => runImageHistory(current, undo, imageResolutions.current), preventDefault: true },
            { key: 'Mod-Shift-z', run: current => runImageHistory(current, redo, imageResolutions.current), preventDefault: true },
            ...historyKeymap.map(binding => ({ ...binding, ...(binding.run === undo ? { run: (current: EditorView) => runImageHistory(current, undo, imageResolutions.current) } : binding.run === redo ? { run: (current: EditorView) => runImageHistory(current, redo, imageResolutions.current) } : {}) })), ...defaultKeymap,
          ]),
          Prec.high(EditorView.domEventHandlers({
            keydown(event, current) {
              if (!(event.ctrlKey || event.metaKey) || event.altKey || event.key.toLowerCase() !== 'z') return false;
              event.preventDefault();
              runImageHistory(current, event.shiftKey ? redo : undo, imageResolutions.current);
              return true;
            },
            beforeinput(event, current) {
              if (event.inputType !== 'historyUndo' && event.inputType !== 'historyRedo') return false;
              event.preventDefault();
              runImageHistory(current, event.inputType === 'historyUndo' ? undo : redo, imageResolutions.current);
              return true;
            },
          })),
          editable.current.of([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]),
          accessibility.current.of(EditorView.contentAttributes.of(attributes(active))),
          preview,
          EditorView.domEventHandlers({
            paste(event) {
              const itemFiles = [...(event.clipboardData?.items || [])].filter(item => item.kind === 'file' && item.type.startsWith('image/')).map(item => item.getAsFile()).filter((file): file is File => Boolean(file));
              const files = itemFiles.length ? itemFiles : [...(event.clipboardData?.files || [])].filter(file => file.type.startsWith('image/'));
              if (!files.length || view.current?.state.readOnly) return false;
              event.preventDefault(); callbacks.current.onPasteImages(files); return true;
            },
          }),
          EditorView.updateListener.of(update => {
            if (update.docChanged && !update.transactions.some(transaction => transaction.annotation(externalChange))) callbacks.current.onChange(update.state.doc.toString());
          }),
        ],
      }),
    });
    view.current = editor;
    if (autoFocus && active) editor.focus();
    return () => { editor.destroy(); view.current = null; };
    // The editor owns its history; subsequent prop changes use transactions below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const previous = editor.state.doc.toString();
    if (previous === value) return;
    let from = 0;
    while (from < previous.length && from < value.length && previous[from] === value[from]) from++;
    let suffix = 0;
    while (suffix < previous.length - from && suffix < value.length - from && previous[previous.length - 1 - suffix] === value[value.length - 1 - suffix]) suffix++;
    editor.dispatch({
      changes: { from, to: previous.length - suffix, insert: value.slice(from, value.length - suffix) },
      // Source edits form an undo step and invalidate any previous redo branch.
      // Upload resolutions already rewrite existing snapshots through replaceToken.
      annotations: [externalChange.of(true), ...(active ? [Transaction.addToHistory.of(false)] : [])],
      ...(active ? {} : { userEvent: 'external.source' }),
    });
  }, [value]);
  useLayoutEffect(() => {
    view.current?.dispatch({ effects: editable.current.reconfigure([EditorState.readOnly.of(disabled), EditorView.editable.of(!disabled)]) });
  }, [disabled]);
  useLayoutEffect(() => {
    view.current?.dispatch({ effects: accessibility.current.reconfigure(EditorView.contentAttributes.of(attributes(active))) });
    if (active) view.current?.requestMeasure();
  }, [active]);
  useLayoutEffect(() => { view.current?.dispatch({ effects: refreshPreview.of(null) }); }, [attachments]);
  useLayoutEffect(() => {
    view.current?.requestMeasure();
  }, [preferences.fontSize, preferences.lineHeight, preferences.paragraphSpacing, preferences.pageMargin]);

  return <div className="ne-live-editor" ref={host} />;
});

export default LiveMarkdownEditor;
