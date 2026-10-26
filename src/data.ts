import type { ImportedNote } from './lib/importer';
import { administrator } from './lib/workspace';

// Directory names and counts come from the user's documents; this is only a
// reusable display palette, with no example workspace content.
export const categories = [
  { color: '#947be9', bg: '#f0ebfc' },
  { color: '#71cbb8', bg: '#eaf7f2' },
  { color: '#7caaf1', bg: '#ecf3ff' },
  { color: '#efb584', bg: '#fff3e8' },
];

export const seedNotes: ImportedNote[] = [];
export const members = [administrator];
