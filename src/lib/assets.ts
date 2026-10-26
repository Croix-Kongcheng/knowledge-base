export interface ResolvedAsset { url?: string; filename?: string; error?: string; loading: boolean }

export function assetIdFromReference(value?: string): string | null {
  return value?.match(/^asset:([a-z0-9][a-z0-9_-]{0,127})$/i)?.[1] || null;
}

/** Server URLs stream attachments directly, including files larger than browser memory. */
export function useAssetUrl(reference?: string): ResolvedAsset {
  const id = assetIdFromReference(reference);
  return id ? { url: `/api/assets/${encodeURIComponent(id)}`, loading: false } : { loading: false };
}
