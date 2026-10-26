import { useCallback, useEffect, useState } from 'react';
import { ApiError } from './api';
import type { ImportedNote } from './importer';
import { fetchDocument, forgetDocument, peekDocument, readCachedDocument } from './libraryCache';

export function useNoteDocument(id: string | null, revision: number | undefined) {
  const [document, setDocument] = useState<ImportedNote>();
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => {
    if (id) { forgetDocument(id);setAttempt(previous => previous + 1); }
  }, [id]);
  useEffect(() => {
    if (!id) return;
    let active = true;
    let receivedLive = false;
    const current = peekDocument(id);
    if (current) setDocument(current);
    setError('');
    const validMemory = current && revision !== undefined && current.revision === revision;
    if (validMemory) return;
    void readCachedDocument(id).then(cached => {
      if (active && !receivedLive && cached) setDocument(cached);
    });
    const loadDocument = async () => {
      const note = await fetchDocument(id);
      // An index refresh can advance the revision while an older detail request
      // is still pending. Once it settles, fetch again instead of adopting it.
      if (active && revision !== undefined && note.revision !== undefined && note.revision < revision) {
        return fetchDocument(id);
      }
      return note;
    };
    void loadDocument().then(note => {
      receivedLive = true;
      if (active) setDocument(previous => previous?.id === note.id && previous.revision !== undefined && note.revision !== undefined && previous.revision >= note.revision && previous.author === note.author ? previous : note);
    }).catch(cause => {
      receivedLive = true;
      if (!active) return;
      if (cause instanceof ApiError && cause.status === 404) {
        forgetDocument(id); setDocument(undefined);
      }
      setError(cause instanceof Error ? cause.message : '文档暂时无法读取，请重试。');
    });
    return () => { active = false; };
  }, [id, revision, attempt]);
  useEffect(() => {
    if (!error) return;
    window.addEventListener('online', retry);
    return () => window.removeEventListener('online', retry);
  }, [error, retry]);
  const note = document?.id === id ? document : id ? peekDocument(id) : undefined;
  return { note, error, retry };
}
