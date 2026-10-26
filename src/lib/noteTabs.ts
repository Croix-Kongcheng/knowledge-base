/** A workspace keeps at most one replaceable preview alongside pinned notes. */
export interface NoteTabsState {
  ids: string[];
  previewId: string | null;
}

export const EMPTY_NOTE_TABS: NoteTabsState = { ids: [], previewId: null };

export function openTab(state: NoteTabsState, id: string, pinned = false): NoteTabsState {
  if (state.ids.includes(id)) return pinned ? pinTab(state, id) : state;
  if (!pinned && state.previewId && state.ids.includes(state.previewId)) {
    return { ids: state.ids.map(previous => previous === state.previewId ? id : previous), previewId: id };
  }
  return { ids: [...state.ids, id], previewId: pinned ? state.previewId : id };
}

export function pinTab(state: NoteTabsState, id: string): NoteTabsState {
  return state.previewId === id ? { ids: state.ids, previewId: null } : state;
}

export function closeTab(state: NoteTabsState, id: string): NoteTabsState {
  if (!state.ids.includes(id)) return state;
  return { ids: state.ids.filter(previous => previous !== id), previewId: state.previewId === id ? null : state.previewId };
}

/** Drop deleted or inaccessible notes while keeping the remaining tab order. */
export function reconcileTabs(state: NoteTabsState, validIds: Iterable<string>): NoteTabsState {
  const valid = new Set(validIds);
  const ids = [...new Set(state.ids)].filter(id => valid.has(id));
  const previewId = state.previewId && ids.includes(state.previewId) ? state.previewId : null;
  if (ids.length === state.ids.length && ids.every((id, index) => id === state.ids[index]) && previewId === state.previewId) return state;
  return { ids, previewId };
}
