import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { backup, DatabaseSync } from 'node:sqlite';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const IMPORT_COLORS = new Set(['purple', 'blue', 'green', 'orange']);
const IMPORT_ID = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}|note-\d+-[a-z0-9]{1,8})$/i;
const digest = value => createHash('sha256').update(value).digest('hex');

function classify(row) {
  let note;
  try { note = JSON.parse(row.data); } catch { return { excluded: 'invalidNote' }; }
  if (!note || typeof note !== 'object' || typeof note.content !== 'string' || typeof note.title !== 'string') return { excluded: 'invalidNote' };
  if (typeof note.path !== 'string' || !/\.(md|markdown)$/i.test(note.path)) return { excluded: 'missingMarkdownPath' };
  const filename = note.path.replace(/\\/g, '/').split('/').pop().replace(/\.(md|markdown)$/i, '');
  if (!/^\d/u.test(filename)) return { excluded: 'filenameHasNoNumberPrefix' };
  if (!filename || filename.trim() !== filename || filename.length > 500) return { excluded: 'invalidFilenameTitle' };
  if (note.title === filename) return { excluded: 'titleAlreadyMatchesFilename' };
  if (note.title !== note.content.match(/^#\s+(.+)$/m)?.[1]?.trim()) return { excluded: 'titleDoesNotMatchFirstHeading' };
  if (!row.created_at || row.created_at !== row.updated_at || note.updatedAt !== row.updated_at) return { excluded: 'modifiedAfterImport' };
  if (!Number.isSafeInteger(row.revision) || row.revision < 1) return { excluded: 'invalidRevision' };
  if (!IMPORT_ID.test(row.id)) return { excluded: 'nonImporterId' };
  if (!IMPORT_COLORS.has(note.color)) return { excluded: 'nonImporterColor' };
  return { title: filename, oldTitle: note.title };
}

async function privateJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  await rename(temporary, filename);
}

/** Explicitly scoped maintenance: dry runs never open a writable connection.
 * beforeApply is an optional verification hook used only by isolated tests.
 */
export async function restoreImportedNumberedTitles({ dataDir = path.join(ROOT, 'data'), ownerEmail, apply = false, beforeApply } = {}) {
  if (typeof ownerEmail !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ownerEmail.trim())) throw new Error('An explicit valid --owner-email is required.');
  const directory = path.resolve(dataDir);
  const databasePath = path.join(directory, 'knowledge.sqlite');
  await stat(databasePath);
  const reader = new DatabaseSync(databasePath, { readOnly: true });
  let writer;
  let transaction = false;
  try {
    reader.exec('PRAGMA busy_timeout = 5000');
    reader.exec('BEGIN');
    const owner = reader.prepare('SELECT id FROM users WHERE email = ?').get(ownerEmail.trim().toLowerCase());
    if (!owner) throw new Error('The explicitly selected owner account was not found.');
    const rows = reader.prepare('SELECT id,owner_id,data,revision,created_at,updated_at FROM notes WHERE owner_id = ?').all(owner.id);
    const totalNotes = reader.prepare('SELECT COUNT(*) AS count FROM notes').get().count;
    reader.exec('COMMIT');
    const summary = {
      mode: apply ? 'apply' : 'dry-run', totalNotes, ownerNotes: rows.length,
      excludedOtherOwners: totalNotes - rows.length, candidates: 0, sharingOnlyCandidates: 0,
      exclusions: {}, applied: 0, skippedConcurrentChanges: 0,
    };
    const candidates = [];
    for (const row of rows) {
      const result = classify(row);
      if (result.excluded) summary.exclusions[result.excluded] = (summary.exclusions[result.excluded] || 0) + 1;
      else {
        candidates.push({ ...row, ...result });
        summary.candidates++;
        if (row.revision > 1) summary.sharingOnlyCandidates++;
      }
    }
    if (!apply || !candidates.length) return summary;

    const backups = path.join(directory, 'backups');
    await mkdir(backups, { recursive: true, mode: 0o700 });
    await chmod(backups, 0o700);
    const basename = `imported-numbered-titles-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const backupPath = path.join(backups, `${basename}.sqlite`);
    const manifestPath = path.join(backups, `${basename}.json`);
    // Create with private permissions before SQLite opens it. Native online
    // backup produces a consistent snapshot of the live WAL database.
    const placeholder = await open(backupPath, 'wx', 0o600);
    await placeholder.close();
    await backup(reader, backupPath);
    await chmod(backupPath, 0o600);
    const manifest = {
      version: 1, state: 'prepared', createdAt: new Date().toISOString(), backupFile: path.basename(backupPath),
      // A title-only recovery does not need note bodies, attachments, emails,
      // passwords, or account records. Hashes let restoration detect later edits.
      notes: candidates.map(row => ({
        id: row.id, ownerId: row.owner_id, originalTitle: row.oldTitle, restoredTitle: row.title,
        originalRevision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
        originalDataSha256: digest(row.data), status: 'prepared',
      })),
    };
    await privateJson(manifestPath, manifest);
    if (beforeApply) await beforeApply();

    writer = new DatabaseSync(databasePath);
    writer.exec('PRAGMA busy_timeout = 5000');
    writer.exec('BEGIN IMMEDIATE');
    transaction = true;
    const update = writer.prepare(`UPDATE notes SET data = json_set(data, '$.title', ?), revision = revision + 1
      WHERE id = ? AND owner_id = ? AND data = ? AND revision = ? AND created_at = ? AND updated_at = ?`);
    const readUpdated = writer.prepare('SELECT data,revision FROM notes WHERE id = ?');
    for (let index = 0; index < candidates.length; index++) {
      const row = candidates[index];
      const changed = update.run(row.title, row.id, row.owner_id, row.data, row.revision, row.created_at, row.updated_at).changes;
      const record = manifest.notes[index];
      if (changed === 1) {
        summary.applied++;
        const updated = readUpdated.get(row.id);
        record.status = 'applied';
        record.restoredRevision = updated.revision;
        record.restoredDataSha256 = digest(updated.data);
      } else {
        summary.skippedConcurrentChanges++;
        record.status = 'skipped-concurrent-change';
      }
    }
    writer.exec('COMMIT');
    transaction = false;
    manifest.state = 'committed';
    await privateJson(manifestPath, manifest);
    return { ...summary, backupPath, manifestPath };
  } finally {
    if (transaction) writer.exec('ROLLBACK');
    writer?.close();
    reader.close();
  }
}

function argumentsFor(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === '--help') return { help: true };
    if (argument === '--apply') { options.apply = true; continue; }
    if (argument === '--dry-run') { options.apply = false; continue; }
    if (!['--owner-email', '--data-dir'].includes(argument)) throw new Error('Unknown argument. Use --help for supported options.');
    const value = argv[++index];
    if (!value || value.startsWith('--')) throw new Error('A required option value is missing.');
    const key = argument === '--owner-email' ? 'ownerEmail' : 'dataDir';
    if (Object.hasOwn(options, key)) throw new Error('An option was supplied more than once.');
    options[key] = value;
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = argumentsFor(process.argv.slice(2));
    if (options.help) console.log('Usage: node scripts/restore-imported-numbered-titles.mjs --owner-email EMAIL [--data-dir DIR] [--dry-run | --apply]\nDefaults to a read-only dry run. Apply creates a private online backup and title recovery manifest.');
    else console.log(JSON.stringify(await restoreImportedNumberedTitles(options), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
