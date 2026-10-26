import type { ImportedNote } from './importer'

export interface NoteGraphLink {
  source: string
  target: string
}

/** The graph has one vertex per note and one edge per real, resolved link. */
export function buildNoteGraph(notes: ImportedNote[]) {
  const byId = new Map(notes.map((note) => [note.id, note]))
  const paths = new Map<string, string | null>()
  const names = new Map<string, string | null>()
  const degree = new Map(notes.map((note) => [note.id, 0]))
  const links: NoteGraphLink[] = []
  const seen = new Set<string>()

  const addLookup = (map: Map<string, string | null>, key: string, id: string) => {
    const normalized = normalizePath(key)
    if (!normalized) return
    if (!map.has(normalized)) map.set(normalized, id)
    else if (map.get(normalized) !== id) map.set(normalized, null)
  }

  for (const note of notes) {
    if (note.path) {
      addLookup(paths, note.path, note.id)
      addLookup(paths, withoutExtension(note.path), note.id)
      const filename = note.path.replace(/\\/g, '/').split('/').pop() || ''
      addLookup(names, filename, note.id)
      addLookup(names, withoutExtension(filename), note.id)
    }
    // Obsidian resolves filenames, rather than the first heading in a file.
    // A heading must not make an otherwise unique filename ambiguous.
    if (!note.path) addLookup(names, note.title, note.id)
  }

  const resolve = (raw: string, note: ImportedNote): string | undefined => {
    const target = decode(raw.trim().replace(/^<|>$/g, ''))
    if (target.startsWith('#note/')) {
      const id = target.slice(6).split(/[?#]/)[0]
      return byId.has(id) ? id : undefined
    }
    if (!target || target.startsWith('#') || /^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(target)) return
    const clean = target.split('#')[0].split('?')[0]
    const folder = note.path?.replace(/\\/g, '/').split('/').slice(0, -1).join('/')
    const candidates = [
      ...(folder && !clean.startsWith('/') ? [`${folder}/${clean}`] : []),
      clean,
    ]
    for (const candidate of candidates) {
      const found = paths.get(normalizePath(candidate))
      if (found) return found
    }
    const directName = names.get(normalizePath(clean))
    if (directName) return directName
    // Obsidian resolves a short filename only when it is unambiguous.
    const basename = normalizePath(clean).split('/').pop() || ''
    return names.get(basename) || names.get(withoutExtension(basename)) || undefined
  }

  for (const note of notes) {
    // Links shown as code examples are not relationships in the knowledge base.
    const prose = linkProse(note.content)
    const targets = [
      ...[...prose.matchAll(/!?\[\[([^\]\n]+)\]\]/g)].filter((match) => !isEscaped(prose, match.index!)).map((match) => match[1].split('|')[0]),
      ...[...prose.matchAll(/!?\[[^\]\n]*\]\(\s*(?:<([^>\n]+)>|([^\s)\n]+))(?:\s+["'][^\n]*?["'])?\s*\)/g)].filter((match) => !isEscaped(prose, match.index!)).map((match) => match[1] || match[2]),
    ]
    for (const target of targets) {
      const linkedId = resolve(target, note)
      if (!linkedId || linkedId === note.id) continue
      const key = JSON.stringify([note.id, linkedId].sort())
      if (seen.has(key)) continue
      seen.add(key)
      links.push({ source: note.id, target: linkedId })
      degree.set(note.id, (degree.get(note.id) || 0) + 1)
      degree.set(linkedId, (degree.get(linkedId) || 0) + 1)
    }
  }
  return { nodes: notes, links, degree }
}

function isEscaped(text: string, index: number) {
  let slashes = 0
  while (index > 0 && text[--index] === '\\') slashes += 1
  return slashes % 2 === 1
}

function linkProse(content: string) {
  let fence = ''
  const lines = content.split(/\r?\n/).map((line) => {
    // Fences may be indented or contained in an Obsidian quote/callout.
    const plain = line.replace(/^(?: {0,3}>[ \t]?)+/, '')
    const marker = plain.match(/^ {0,3}(`{3,}|~{3,})/)?.[1]
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && plain.slice(plain.indexOf(marker) + marker.length).trim() === '') fence = ''
      return ''
    }
    if (marker) { fence = marker; return '' }
    return line
  }).join('\n').replace(/<!--[\s\S]*?(?:-->|$)|%%[\s\S]*?%%/g, '')
  // Match a code span's exact delimiter length, including double backticks.
  let prose = ''
  let cursor = 0
  const ticks = /`+/g
  for (let opening = ticks.exec(lines); opening; opening = ticks.exec(lines)) {
    const end = new RegExp(`(?<!\x60)${opening[0]}(?!\x60)`, 'g')
    end.lastIndex = ticks.lastIndex
    const closing = end.exec(lines)
    if (!closing) continue
    prose += lines.slice(cursor, opening.index)
    cursor = closing.index + closing[0].length
    ticks.lastIndex = cursor
  }
  return prose + lines.slice(cursor)
}

function withoutExtension(path: string) {
  return path.replace(/\.(?:md|markdown)$/i, '')
}

function decode(value: string) {
  try { return decodeURIComponent(value) } catch { return value }
}

function normalizePath(path: string) {
  const parts: string[] = []
  for (const part of path.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.join('/').normalize('NFC').toLocaleLowerCase()
}
