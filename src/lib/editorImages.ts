import { ApiError, apiRequest } from './api';

export interface EditorImageAsset {
  id: string;
  path: string;
  reference: string;
  size: number;
  markdown: string;
}

const MAX_IMAGE_BYTES = 500 * 1024 ** 2;
const imageTypes: Record<string, { mime: string; extension: string }> = {
  'image/png': { mime: 'image/png', extension: 'png' },
  'image/jpeg': { mime: 'image/jpeg', extension: 'jpg' },
  'image/jpg': { mime: 'image/jpeg', extension: 'jpg' },
  'image/gif': { mime: 'image/gif', extension: 'gif' },
  'image/webp': { mime: 'image/webp', extension: 'webp' },
  'image/avif': { mime: 'image/avif', extension: 'avif' },
  'image/bmp': { mime: 'image/bmp', extension: 'bmp' },
  'image/x-ms-bmp': { mime: 'image/bmp', extension: 'bmp' },
};

const cancelled = () => new DOMException('已取消图片粘贴。', 'AbortError');

function uniqueId(): string {
  // randomUUID requires a secure context, but this workspace also supports HTTP
  // through a forwarded server port. getRandomValues is available there too.
  return typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
    : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

function timestamp(): string {
  const now = new Date();
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

async function imageType(file: Blob): Promise<{ mime: string; extension: string }> {
  const declared = file.type.toLowerCase().split(';')[0].trim();
  if (declared && !imageTypes[declared] && declared !== 'application/octet-stream') {
    throw new Error('请粘贴 PNG、JPG、GIF、WebP、AVIF 或 BMP 图片。');
  }
  const bytes = new Uint8Array(await file.slice(0, 64).arrayBuffer());
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.slice(start, start + length));
  let mime = '';
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) mime = 'image/png';
  else if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) mime = 'image/jpeg';
  else if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) mime = 'image/gif';
  else if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') mime = 'image/webp';
  else if (ascii(0, 2) === 'BM') mime = 'image/bmp';
  else if (ascii(4, 4) === 'ftyp' && [8, ...Array.from({ length: 12 }, (_, index) => 16 + index * 4)]
    .some(offset => ['avif', 'avis'].includes(ascii(offset, 4)))) mime = 'image/avif';
  const result = imageTypes[mime];
  if (!result || (imageTypes[declared] && imageTypes[declared].mime !== mime)) {
    throw new Error('无法读取这张图片，文件可能已损坏或格式不受支持。');
  }
  return result;
}

/**
 * Upload one clipboard image without changing its resolution or animation.
 * The caller merges path/reference and reference/size into the note draft.
 * Once a POST starts, cancellation waits for its acknowledgement and removes
 * the unpublished asset. This avoids leaving a committed upload behind when
 * the editor is closed just as the response arrives.
 */
export async function uploadEditorImage(file: Blob, options: { signal?: AbortSignal } = {}): Promise<EditorImageAsset> {
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  if (!file.size) throw new Error('这张图片是空文件，请重新复制。');
  if (file.size > MAX_IMAGE_BYTES) throw new Error('单张图片不能超过 500 MB，请使用较小的图片。');
  const { mime, extension } = await imageType(file);
  if (signal?.aborted) throw cancelled();
  const suffix = uniqueId();
  const id = `editor-image-${suffix}`;
  const path = `附件/粘贴图片-${timestamp()}-${suffix}.${extension}`;
  const reference = `asset:${id}`;
  try {
    // Do not abort the transport after the server may have committed the file.
    // The editor can close immediately; this promise cleans up in the background.
    let response: Response;
    try {
      response = await fetch(`/api/assets/${encodeURIComponent(id)}`, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': mime, 'X-Asset-Path': encodeURIComponent(path) },
        body: file,
      });
    } catch {
      throw new ApiError('图片上传连接中断，请检查网络后重试。', 0);
    }
    const body = await response.json().catch(() => ({})) as {
      error?: string; code?: string; asset?: { id: string; path: string; size: number };
    };
    if (!response.ok) {
      if (response.status === 401) window.dispatchEvent(new Event('session-expired'));
      throw new ApiError(body.error || `图片上传失败（${response.status}），请重试。`, response.status, body.code);
    }
    if (body.asset?.id !== id || body.asset.path !== path || body.asset.size !== file.size) {
      throw new Error('图片上传结果无效，请重新粘贴。');
    }
    if (signal?.aborted) throw cancelled();
    return { id, path, reference, size: body.asset.size, markdown: `![粘贴图片](${reference})` };
  } catch (error) {
    // DELETE is restricted server-side to this uploader and to unreferenced
    // assets. It cannot remove an image already saved into any note.
    if (!(error instanceof ApiError && error.status > 0)) {
      await deleteEditorImages([{ id }]).catch(() => { /* Preserve the upload/cancellation error. */ });
    }
    if (signal?.aborted) throw cancelled();
    throw error;
  }
}

/** Remove images created by an abandoned draft; saved/shared images are protected. */
export async function deleteEditorImages(images: ReadonlyArray<Pick<EditorImageAsset, 'id'>>): Promise<void> {
  let firstFailure: unknown;
  const ids = [...new Set(images.map(image => image.id))];
  for (let start = 0; start < ids.length; start += 20) {
    const results = await Promise.allSettled(ids.slice(start, start + 20).map(id =>
      apiRequest<void>(`/assets/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true })));
    for (const result of results) if (result.status === 'rejected') firstFailure ??= result.reason;
  }
  if (firstFailure) throw firstFailure;
}
