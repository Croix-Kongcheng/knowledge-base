/** Limits apply only to supported public files, after ignored folders are removed. */
export const IMPORT_LIMITS = {
  totalBytes: 500 * 1024 * 1024,
  files: 20_000,
  noteBytes: 10 * 1024 * 1024,
  totalLabel: '500 MB',
  filesLabel: '20,000',
  noteLabel: '10 MB',
} as const;
