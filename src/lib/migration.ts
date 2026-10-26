import type { ImportedAsset, ImportedNote } from './importer';
import { notesApi } from './api';
import { deleteAssets, getLegacyAsset, getPendingLegacyNotes, saveAssets } from './storage';
import { fromMarkdown } from 'mdast-util-from-markdown';
import type { Definition, Image, Link, Nodes } from 'mdast';

const EXACT_ASSET_REFERENCE = /^asset:([A-Za-z0-9][A-Za-z0-9._-]{0,159})$/;
const SUPPORTED_MIME = /^(?:image\/[a-z0-9.+-]+|application\/(?:pdf|octet-stream)|text\/(?:plain|csv)|audio\/[a-z0-9.+-]+|video\/[a-z0-9.+-]+)$/i;
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const yieldToBrowser = () => new Promise<void>(resolve => setTimeout(resolve, 0));
const rotateRight = (value: number, count: number) => (value >>> count) | (value << (32 - count));

/** Hash the existing ASCII URL without allocating another full copy, including on HTTP origins. */
async function dataUrlId(value: string): Promise<string> {
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  const paddedLength = Math.ceil((value.length + 9) / 64) * 64;
  const bitLength = value.length * 8;
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let word = 0; word < 16; word += 1) {
      let packed = 0;
      for (let byte = 0; byte < 4; byte += 1) {
        const index = offset + word * 4 + byte;
        const current = index < value.length ? value.charCodeAt(index)
          : index === value.length ? 0x80
            : index >= paddedLength - 8 ? Math.floor(bitLength / 2 ** ((paddedLength - index - 1) * 8)) & 255 : 0;
        packed = (packed << 8) | current;
      }
      words[word] = packed;
    }
    for (let word = 16; word < 64; word += 1) {
      const earlier = words[word - 15];
      const previous = words[word - 2];
      const small0 = rotateRight(earlier, 7) ^ rotateRight(earlier, 18) ^ (earlier >>> 3);
      const small1 = rotateRight(previous, 17) ^ rotateRight(previous, 19) ^ (previous >>> 10);
      words[word] = words[word - 16] + small0 + words[word - 7] + small1;
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let round = 0; round < 64; round += 1) {
      const big1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choice = (e & f) ^ (~e & g);
      const first = (h + big1 + choice + SHA256_CONSTANTS[round] + words[round]) >>> 0;
      const big0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const second = (big0 + majority) >>> 0;
      h = g; g = f; f = e; e = (d + first) >>> 0;
      d = c; c = b; b = a; a = (first + second) >>> 0;
    }
    state[0] += a; state[1] += b; state[2] += c; state[3] += d;
    state[4] += e; state[5] += f; state[6] += g; state[7] += h;
    if (offset && offset % (1024 * 1024) === 0) await yieldToBrowser();
  }
  return `legacy-${[...state].map(word => word.toString(16).padStart(8, '0')).join('')}`;
}

interface LegacyDataUrl { type: string; start: number; base64: boolean; size: number }

function inspectDataUrl(value: string): LegacyDataUrl {
  const comma = value.indexOf(',');
  if (comma < 0) throw new Error('旧笔记包含格式无效的图片或附件数据，迁移已停止，原数据仍保留。');
  const header = value.slice(0, comma);
  const metadata = /^data:([^;,]+)(?:;charset=[a-z0-9._-]+)?(;base64)?$/i.exec(header);
  if (!metadata || !SUPPORTED_MIME.test(metadata[1])) throw new Error('旧笔记包含格式无效的图片或附件数据，迁移已停止，原数据仍保留。');
  const start = comma + 1;
  let size = 0;
  if (metadata[2]) {
    const payloadLength = value.length - start;
    if (payloadLength % 4 === 1) throw new Error('旧笔记的附件编码不完整，迁移已停止，原数据仍保留。');
    const finalPadding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
    if (finalPadding && payloadLength % 4 !== 0) throw new Error('旧笔记的附件编码无效，迁移已停止，原数据仍保留。');
    for (let offset = start; offset < value.length; offset += 64 * 1024) {
      const chunk = value.slice(offset, Math.min(offset + 64 * 1024, value.length));
      const final = offset + chunk.length === value.length;
      if (!(final ? /^[a-z0-9+/]*={0,2}$/i : /^[a-z0-9+/]*$/i).test(chunk)) throw new Error('旧笔记的附件编码无效，迁移已停止，原数据仍保留。');
    }
    size = Math.floor(payloadLength * 3 / 4) - finalPadding;
  } else {
    for (let index = start; index < value.length; index += 1) {
      if (value[index] === '%') {
        const encoded = value.slice(index + 1, index + 3);
        if (!/^[0-9a-f]{2}$/i.test(encoded)) throw new Error('旧笔记的附件编码无效，迁移已停止，原数据仍保留。');
        index += 2;
      } else if (value.charCodeAt(index) > 127) throw new Error('旧笔记的附件地址需要使用有效的 URL 编码，原数据仍保留。');
      size += 1;
    }
  }
  return { type: metadata[1].toLowerCase(), start, base64: Boolean(metadata[2]), size };
}

function decodeDataUrl(value: string, descriptor: LegacyDataUrl): Blob {
  const parts: Uint8Array<ArrayBuffer>[] = [];
  if (descriptor.base64) {
    for (let offset = descriptor.start; offset < value.length; offset += 64 * 1024) {
      let binary: string;
      try { binary = atob(value.slice(offset, Math.min(offset + 64 * 1024, value.length))); }
      catch { throw new Error('旧笔记的附件编码无效，迁移已停止，原数据仍保留。'); }
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      parts.push(bytes);
    }
  } else {
    let bytes = new Uint8Array(64 * 1024);
    let length = 0;
    for (let index = descriptor.start; index < value.length; index += 1) {
      let byte = value.charCodeAt(index);
      if (value[index] === '%') { byte = Number.parseInt(value.slice(index + 1, index + 3), 16); index += 2; }
      bytes[length++] = byte;
      if (length === bytes.length) { parts.push(bytes); bytes = new Uint8Array(64 * 1024); length = 0; }
    }
    if (length) parts.push(bytes.slice(0, length));
  }
  return new Blob(parts, { type: descriptor.type });
}

type MarkdownTarget = Definition | Image | Link;

function markdownTargets(content: string): MarkdownTarget[] {
  if (!/[<\[]/.test(content)) return [];
  const stack: Nodes[] = [fromMarkdown(content)];
  const targets: MarkdownTarget[] = [];
  const definitions = new Map<string, Definition>();
  const usedDefinitions = new Set<string>();
  while (stack.length) {
    const node = stack.pop()!;
    if (node.type === 'link' || node.type === 'image') targets.push(node);
    if (node.type === 'definition' && !definitions.has(node.identifier)) definitions.set(node.identifier, node);
    if (node.type === 'linkReference' || node.type === 'imageReference') usedDefinitions.add(node.identifier);
    if ('children' in node) for (let index = node.children.length - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
  for (const identifier of usedDefinitions) {
    const definition = definitions.get(identifier);
    if (definition) targets.push(definition);
  }
  return targets;
}

function assetIds(note: ImportedNote, targets = markdownTargets(note.content)): Set<string> {
  const result = new Set<string>();
  for (const target of targets) {
    const id = EXACT_ASSET_REFERENCE.exec(target.url)?.[1];
    if (id) result.add(id);
  }
  for (const value of Object.values(note.attachments || {})) {
    const id = EXACT_ASSET_REFERENCE.exec(value)?.[1];
    if (id) result.add(id);
  }
  return result;
}

function destinationRange(content: string, node: MarkdownTarget): { start: number; end: number } {
  const start = node.position?.start.offset;
  const end = node.position?.end.offset;
  if (start === undefined || end === undefined) throw new Error('无法定位旧笔记的附件地址，原数据仍保留。');
  const source = content.slice(start, end);
  if (node.type === 'link' && source.startsWith('<')) return { start: start + 1, end: end - 1 };
  let index = source.indexOf('[') + 1;
  if (!index) throw new Error('无法定位旧笔记的附件地址，原数据仍保留。');
  let depth = 1;
  while (index < source.length && depth) {
    const character = source[index];
    if (character === '\\') { index += 2; continue; }
    if (character === '`') {
      const run = /^`+/.exec(source.slice(index))![0];
      let candidate = source.indexOf(run, index + run.length);
      while (candidate >= 0 && (source[candidate - 1] === '`' || source[candidate + run.length] === '`')) candidate = source.indexOf(run, candidate + run.length);
      if (candidate >= 0) { index = candidate + run.length; continue; }
    }
    if (character === '[') depth += 1;
    else if (character === ']') depth -= 1;
    index += 1;
  }
  const delimiter = node.type === 'definition' ? ':' : '(';
  if (depth || source[index] !== delimiter) throw new Error('无法定位旧笔记的附件地址，原数据仍保留。');
  index += 1;
  while (/\s/.test(source[index] || '') && index < source.length) index += 1;
  if (source[index] === '<') {
    const targetStart = ++index;
    while (index < source.length) {
      if (source[index] === '\\') { index += 2; continue; }
      if (source[index] === '>') return { start: start + targetStart, end: start + index };
      index += 1;
    }
  } else {
    const targetStart = index;
    let parentheses = 0;
    while (index < source.length) {
      const character = source[index];
      if (character === '\\') { index += 2; continue; }
      if (/\s/.test(character) || (character === ')' && !parentheses)) break;
      if (character === '(') parentheses += 1;
      else if (character === ')') parentheses -= 1;
      index += 1;
    }
    if (index > targetStart) return { start: start + targetStart, end: start + index };
  }
  throw new Error('无法定位旧笔记的附件地址，原数据仍保留。');
}

/** Copy legacy browser data to the shared server without deleting or rewriting its source. */
export async function migrateLegacyNotes(notes: ImportedNote[], onProgress?: (label: string) => void): Promise<ImportedNote[]> {
  onProgress?.('正在检查已迁移的笔记…');
  const serverNotes = await notesApi.list();
  const serverIds = new Set(serverNotes.map(note => note.id));
  const pending = getPendingLegacyNotes(notes, serverNotes);
  if (!pending.length) return serverNotes;
  if (new Set(pending.map(note => note.id)).size !== pending.length) throw new Error('本地笔记存在重复编号，请先检查原知识库。原数据仍保留。');
  const pendingIds = new Set(pending.map(note => note.id));
  // Include path matches as lightweight aliases: a new legacy note can still
  // link to an old ID whose matching server note now has a canonical ID.
  // These entries are only resolved, never updated or read for attachments.
  const aliases = notes.filter(note => !serverIds.has(note.id) && !pendingIds.has(note.id))
    .map(note => ({ ...note, content: '', attachments: {}, attachmentSizes: {}, migrationAlias: true }));

  const uploaded: string[] = [];
  const preparedAssets = new Map<string, ImportedAsset>();
  const sizes = new Map<string, number>();
  const availability = new Map<string, Promise<number | null>>();
  const convertedUrls = new Map<string, { reference: string; size: number }>();
  const existingAssets = new Set(serverNotes.flatMap(note => [...assetIds(note)]));
  for (const note of serverNotes) for (const [reference, size] of Object.entries(note.attachmentSizes || {})) {
    const id = EXACT_ASSET_REFERENCE.exec(reference)?.[1];
    if (id && existingAssets.has(id) && Number.isSafeInteger(size) && size >= 0) sizes.set(id, size);
  }

  const serverAssetSize = async (id: string): Promise<number | null> => {
    if (existingAssets.has(id) && sizes.has(id)) return sizes.get(id)!;
    let request = availability.get(id);
    if (!request) {
      request = fetch(`/api/assets/${encodeURIComponent(id)}`, { method: 'HEAD', credentials: 'same-origin', cache: 'no-store' }).then(response => {
        if (response.status === 404) return null;
        if (!response.ok) throw new Error('无法检查服务器附件，请保持登录后重试。原数据仍保留。');
        const header = response.headers.get('Content-Length');
        const size = header === null ? NaN : Number(header);
        if (!Number.isSafeInteger(size) || size < 0) throw new Error('服务器未能返回附件大小，请稍后重试。原数据仍保留。');
        sizes.set(id, size);
        return size;
      });
      availability.set(id, request);
    }
    return request;
  };

  const resolveLegacyAsset = async (id: string): Promise<number> => {
    if (sizes.has(id)) return sizes.get(id)!;
    const existingSize = await serverAssetSize(id);
    if (existingSize !== null) return existingSize;
    const asset = await getLegacyAsset(id);
    if (!asset) throw new Error('本地附件缺失，无法完整迁移。请在之前导入笔记的浏览器中操作，原数据仍保留。');
    preparedAssets.set(id, asset);
    sizes.set(id, asset.blob.size);
    return asset.blob.size;
  };

  const convertDataUrl = async (value: string, preferredPath?: string): Promise<{ reference: string; size: number }> => {
    const cached = convertedUrls.get(value);
    if (cached) return cached;
    // Validate before hashing so a malformed attachment never becomes a broken server reference.
    const descriptor = inspectDataUrl(value);
    const id = await dataUrlId(value);
    const reference = `asset:${id}`;
    const existingSize = await serverAssetSize(id);
    const size = existingSize ?? descriptor.size;
    if (existingSize === null) {
      const blob = decodeDataUrl(value, descriptor);
      const extension = blob.type.split('/')[1].replace('svg+xml', 'svg').replace('jpeg', 'jpg').replace(/[^a-z0-9]/g, '') || 'bin';
      preparedAssets.set(id, { id, path: preferredPath || `历史附件/${id}.${extension}`, blob });
    }
    sizes.set(id, size);
    const converted = { reference, size };
    convertedUrls.set(value, converted);
    return converted;
  };

  const preparedNotes: ImportedNote[] = [];
  for (let index = 0; index < pending.length; index += 1) {
    onProgress?.(`正在准备历史笔记 ${index + 1} / ${pending.length}…`);
    const note = pending[index];
    const targets = markdownTargets(note.content);
    const attachments: Record<string, string> = {};
    const attachmentSizes: Record<string, number> = {};
    for (const [alias, value] of Object.entries(note.attachments || {})) {
      if (/^data:/i.test(value)) {
        const converted = await convertDataUrl(value, alias);
        attachments[alias] = converted.reference;
        attachmentSizes[converted.reference] = converted.size;
      } else {
        const id = EXACT_ASSET_REFERENCE.exec(value)?.[1];
        if (!id) throw new Error('旧笔记包含无效的附件引用，迁移已停止，原数据仍保留。');
        attachments[alias] = value;
        attachmentSizes[value] = await resolveLegacyAsset(id);
      }
    }
    for (const id of assetIds(note, targets)) attachmentSizes[`asset:${id}`] = await resolveLegacyAsset(id);
    const replacements: { start: number; end: number; value: string }[] = [];
    for (const target of targets) {
      if (!/^data:/i.test(target.url)) continue;
      const converted = await convertDataUrl(target.url);
      attachmentSizes[converted.reference] = converted.size;
      replacements.push({ ...destinationRange(note.content, target), value: converted.reference });
    }
    const parts: string[] = [];
    let cursor = 0;
    for (const replacement of replacements.sort((left, right) => left.start - right.start)) {
      if (replacement.start < cursor) throw new Error('旧笔记附件地址存在重叠，迁移已停止，原数据仍保留。');
      parts.push(note.content.slice(cursor, replacement.start), replacement.value);
      cursor = replacement.end;
    }
    parts.push(note.content.slice(cursor));
    const content = replacements.length ? parts.join('') : note.content;
    preparedNotes.push({ ...note, content, attachments, attachmentSizes });
    if (index % 20 === 0) await yieldToBrowser();
  }

  try {
    const assets = [...preparedAssets.values()];
    const totalBytes = assets.reduce((sum, asset) => sum + asset.blob.size, 0);
    let priorBytes = 0;
    // Include the in-flight ID: an interrupted response can leave a completed upload behind.
    for (let index = 0; index < assets.length; index += 1) {
      const asset = assets[index];
      uploaded.push(asset.id);
      await saveAssets([asset], progress => {
        onProgress?.(`正在上传历史附件 ${index + 1} / ${assets.length}（${Math.round((priorBytes + progress.bytes) / Math.max(1, totalBytes) * 100)}%）…`);
      });
      priorBytes += asset.blob.size;
    }
    onProgress?.('正在保存迁移后的笔记…');
    const imported = await notesApi.migrate([...preparedNotes, ...aliases]);
    const importedIds = new Set(imported.map(note => note.id));
    return [...imported, ...serverNotes.filter(note => !importedIds.has(note.id))];
  } catch (error) {
    await deleteAssets(uploaded).catch(() => { /* Referenced or unavailable assets must never erase the original failure. */ });
    throw error;
  }
}
