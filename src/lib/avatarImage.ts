export const AVATAR_IMAGE_LIMITS = {
  inputBytes: 20 * 1024 * 1024,
  outputBytes: 2 * 1024 * 1024,
  size: 512,
} as const;

class AvatarImageError extends Error {}

const cancelled = () => new DOMException('已取消图片处理。', 'AbortError');

/** Decode locally, crop the center square, and return the PNG accepted by the server. */
export async function normalizeAvatarImage(file: Blob, options: { signal?: AbortSignal } = {}): Promise<Blob> {
  const { signal } = options;
  if (signal?.aborted) throw cancelled();
  if (!file.size) throw new AvatarImageError('这张图片是空文件，请重新选择。');
  if (file.size > AVATAR_IMAGE_LIMITS.inputBytes) throw new AvatarImageError('图片超过 20 MB，请选择较小的图片。');
  if (file.type && !file.type.toLowerCase().startsWith('image/')) throw new AvatarImageError('请选择 JPG、PNG、WebP 等图片文件。');

  const image = new Image();
  image.decoding = 'async';
  const source = URL.createObjectURL(file);
  const canvas = document.createElement('canvas');
  let rejectLoading: ((reason: unknown) => void) | undefined;
  const abort = () => { image.src = '';rejectLoading?.(cancelled()); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    await new Promise<void>((resolve, reject) => {
      rejectLoading = reject;
      image.onload = () => resolve();
      image.onerror = () => reject(new AvatarImageError('无法读取这张图片，文件可能已损坏或格式不受浏览器支持。'));
      image.src = source;
      if (signal?.aborted) abort();
    });
    rejectLoading = undefined;
    image.onload = null;image.onerror = null;
    if (signal?.aborted) throw cancelled();
    if (image.decode) await image.decode();
    if (signal?.aborted) throw cancelled();
    const width = image.naturalWidth, height = image.naturalHeight;
    if (!width || !height) throw new AvatarImageError('图片没有有效尺寸，请重新选择。');
    const side = Math.min(width, height);
    canvas.width = AVATAR_IMAGE_LIMITS.size;canvas.height = AVATAR_IMAGE_LIMITS.size;
    const context = canvas.getContext('2d');
    if (!context) throw new AvatarImageError('浏览器无法处理图片，请刷新页面或换一个浏览器重试。');
    context.imageSmoothingEnabled = true;context.imageSmoothingQuality = 'high';
    context.drawImage(image, (width - side) / 2, (height - side) / 2, side, side, 0, 0, canvas.width, canvas.height);
    const normalized = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new AvatarImageError('图片转换失败，请换一张图片重试。')), 'image/png');
    });
    if (signal?.aborted) throw cancelled();
    if (normalized.type !== 'image/png' || normalized.size > AVATAR_IMAGE_LIMITS.outputBytes) throw new AvatarImageError('处理后的头像超过 2 MB，请换一张图片重试。');
    return normalized;
  } catch (cause) {
    if (signal?.aborted || cause instanceof DOMException && cause.name === 'AbortError') throw cancelled();
    if (cause instanceof AvatarImageError) throw cause;
    throw new AvatarImageError('无法处理这张图片，文件可能已损坏或格式不受支持，请改用 JPG、PNG 或 WebP 图片。');
  } finally {
    rejectLoading = undefined;
    signal?.removeEventListener('abort', abort);
    image.onload = null;image.onerror = null;image.src = '';
    URL.revokeObjectURL(source);
    canvas.width = 0;canvas.height = 0;
  }
}
