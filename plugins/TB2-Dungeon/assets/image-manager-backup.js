/** Metadata-only archive transfer. Binary images and unknown files are never mutated. */
'use strict';
const BackupArchive = typeof module !== 'undefined' ? require('./image-manager.js').ImageArchive : window.ImageArchive;
const BackupIdentity = typeof module !== 'undefined' ? require('./box-identity.js').BoxIdentity : window.BoxIdentity;
class ImageManagerBackup {
    static FORMAT = 'core-flasher-manager-metadata';
    static MAX_BYTES = 16 * 1024 * 1024;
    static MAX_FILES = 10000;
    constructor(archive) { this.archive = archive; }
    /** Restrict restore paths to recognized manager documents, not arbitrary TC files. */
    validateDocument(path, bytes) {
        BackupArchive.path(path);
        if (!path.endsWith('.cfmeta')) throw new Error('Backup contains an unsupported file path.');
        const value = BackupArchive.parse(bytes);
        if (path === BackupArchive.CONFIG) {
            if (value.format !== 1 || !Number.isSafeInteger(value.limitBytes) || value.limitBytes < BackupArchive.SIZE)
                throw new Error('Invalid manager settings in backup.');
            return { kind: 'settings', value };
        }
        if (path.split('/').length < 3) throw new Error('Invalid metadata location.');
        if (path.endsWith('/box.cfmeta')) return { kind: 'box', value: BackupArchive.boxProfile(value) };
        return { kind: 'image', value: BackupArchive.metadata(value) };
    }
    /** Read all canonical metadata twice: no partially observed snapshot is downloaded. */
    async snapshot() {
        const archive = this.archive;
        if (archive.storage.archiveExists && !await archive.storage.archiveExists()) {
            archive.files = []; archive.entries = []; archive.boxProfiles = [];
            archive.used = 0; archive.limit = BackupArchive.DEFAULT_LIMIT;
            return [];
        }
        await archive.refresh();
        const records = [];
        let totalBytes = 0;
        for (const file of archive.files.filter(file => file.path.endsWith('.cfmeta'))) {
            archive.checkpoint();
            const bytes = await archive.storage.read(file.path, BackupArchive.META_LIMIT);
            const value = BackupArchive.parse(bytes);
            const canonical = file.path === BackupArchive.CONFIG || file.path.endsWith('/box.cfmeta') ||
                archive.files.some(item => item.path === file.path.replace(/\.cfmeta$/, '.bin')) ||
                (value?.format === 1 && ('sha256' in value || 'box' in value));
            if (!canonical) continue; // Foreign documents are not part of this manager's replacement set.
            totalBytes += bytes.length;
            if (records.length >= ImageManagerBackup.MAX_FILES || totalBytes > ImageManagerBackup.MAX_BYTES)
                throw new Error('Manager metadata exceeds the backup size limit.');
            const document = this.validateDocument(file.path, bytes);
            records.push({ path: file.path, text: new TextDecoder('utf-8', {fatal:true}).decode(bytes),
                sha256: await BackupArchive.hash(bytes), ...document });
        }
        records.sort((left, right) => left.path.localeCompare(right.path));
        return records;
    }
    static equal(left, right) {
        return left.length === right.length && left.every((file, index) =>
            file.path === right[index].path && file.sha256 === right[index].sha256);
    }
    async export() {
        const files = await this.snapshot();
        BackupIdentity.assertUnique(files.filter(file => file.kind === 'box').map(file => file.value));
        if (!ImageManagerBackup.equal(files, await this.snapshot())) throw new Error('Archive changed during backup. Download again.');
        const backup = { format: ImageManagerBackup.FORMAT, version: 1, createdAt: new Date().toISOString(),
            files: files.map(({path, text, sha256}) => ({path, text, sha256})) };
        const bytes = BackupArchive.bytes(backup);
        if (bytes.length > ImageManagerBackup.MAX_BYTES) throw new Error('Metadata backup exceeds the 16 MiB limit.');
        return bytes;
    }
    /** Validate the complete input before even preparing a TC write. */
    async parse(bytes) {
        if (!(bytes instanceof Uint8Array) || bytes.length > ImageManagerBackup.MAX_BYTES) throw new Error('Invalid metadata backup size.');
        const backup = JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(bytes));
        if (backup.format !== ImageManagerBackup.FORMAT || backup.version !== 1 ||
            !Array.isArray(backup.files) || backup.files.length > ImageManagerBackup.MAX_FILES)
            throw new Error('Unsupported metadata backup format.');
        const records = [], paths = new Set();
        for (const file of backup.files) {
            if (typeof file.path !== 'string' || typeof file.text !== 'string' || paths.has(file.path.toLowerCase()))
                throw new Error('Invalid or duplicate metadata path in backup.');
            paths.add(file.path.toLowerCase());
            const content = new TextEncoder().encode(file.text);
            if (await BackupArchive.hash(content) !== file.sha256) throw new Error('Metadata backup checksum mismatch.');
            records.push({ ...file, ...this.validateDocument(file.path, content) });
        }
        BackupIdentity.assertUnique(records.filter(record => record.kind === 'box').map(record => record.value));
        const ids = records.filter(record => record.kind === 'image').map(record => record.value.id);
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate image identity in backup.');
        return records.sort((left, right) => left.path.localeCompare(right.path));
    }
    /** Missing binaries are retained as descriptions; existing binaries must match exactly. */
    async verifyImages(records) {
        const missing = [], archive = this.archive;
        for (const record of records.filter(record => record.kind === 'image')) {
            archive.checkpoint();
            const path = record.path.replace(/\.cfmeta$/, '.bin');
            if (!archive.files.some(file => file.path === path)) { missing.push(path); continue; }
            archive.progress(`Checking ${path}...`);
            const bytes = await archive.storage.read(path, BackupArchive.SIZE);
            if (bytes.length !== record.value.size || await BackupArchive.hash(bytes) !== record.value.sha256)
                throw new Error(`Image checksum does not match: ${path}. Restore stopped.`);
        }
        return missing;
    }
    async preview(bytes) {
        const after = await this.parse(bytes), before = await this.snapshot();
        const missing = await this.verifyImages(after);
        const find = (records, path) => records.find(record => record.path === path);
        const added = after.filter(record => !find(before, record.path));
        const changed = after.filter(record => find(before, record.path)?.sha256 && find(before, record.path).sha256 !== record.sha256);
        const removed = before.filter(record => !find(after, record.path));
        const unprotected = before.filter(record => record.kind === 'image' && record.value.protected && !find(after, record.path)?.value.protected);
        return { before, after, added, changed, removed, unprotected, missing };
    }
    /** Replace only the previewed metadata; guarded rollback never overwrites external changes. */
    async restore(plan, options = {}) {
        const archive = this.archive;
        return archive.run(async () => {
            // Treat a caller-supplied preview as untrusted too, including direct API calls.
            const validated = await this.parse(BackupArchive.bytes({format:ImageManagerBackup.FORMAT, version:1, files:plan.after}));
            if (!ImageManagerBackup.equal(validated, plan.after)) throw new Error('Invalid restore preview.');
            const expected = await this.preview(BackupArchive.bytes({format:ImageManagerBackup.FORMAT, version:1, files:validated}));
            if (!ImageManagerBackup.equal(expected.before, plan.before)) throw new Error('Archive changed. Create a new restore preview.');
            plan = expected;
            if (plan.unprotected.length && !options.confirmedUnprotect) throw new Error('Confirm removal of image protection first.');
            if (!ImageManagerBackup.equal(plan.before, await this.snapshot())) throw new Error('Archive changed. Create a new restore preview.');
            await this.verifyImages(plan.after);
            const extra = plan.after.reduce((total, file) => total + new TextEncoder().encode(file.text).length, 0);
            if (archive.used + extra > archive.limit) throw new Error('Archive size limit reached. Increase the limit before restoring.');
            const completed = [];
            try {
                await archive.ensureRoot();
                // Publish settings last so lowering the limit does not invalidate this checked operation.
                const writes = [...plan.added, ...plan.changed].sort((a,b) => Number(a.kind === 'settings') - Number(b.kind === 'settings'));
                for (const record of [...writes, ...plan.removed]) {
                    archive.checkpoint();
                    const old = plan.before.find(file => file.path === record.path);
                    const next = plan.after.find(file => file.path === record.path);
                    const oldBytes = old && new TextEncoder().encode(old.text);
                    const newBytes = next && new TextEncoder().encode(next.text);
                    archive.progress(`Restoring ${record.path}...`);
                    if (old && !BackupArchive.same(await archive.storage.read(record.path, BackupArchive.META_LIMIT), oldBytes))
                        throw new Error('Metadata changed during restore.');
                    const step = { path: record.path, oldBytes, newBytes };
                    completed.push(step);
                    await archive.storage.mkdir(record.path.slice(0, record.path.lastIndexOf('/')));
                    if (!next) await archive.storage.remove(record.path);
                    else if (old) await archive.replace(record.path, newBytes, oldBytes);
                    else await archive.checkedWrite(record.path, newBytes);
                }
                if (!ImageManagerBackup.equal(plan.after, await this.snapshot())) throw new Error('Restored metadata failed verification.');
            } catch (error) {
                const remaining = [];
                // A failed replace may leave an intact old file or a recovery file; never guess ownership.
                for (const step of completed.reverse()) {
                    try {
                        const present = (await archive.storage.list(step.path.slice(0, step.path.lastIndexOf('/'))))
                            .some(file => file.name === step.path.split('/').pop());
                        const actual = present ? await archive.storage.read(step.path, BackupArchive.META_LIMIT) : null;
                        if (actual && step.oldBytes && BackupArchive.same(actual, step.oldBytes)) continue;
                        if ((actual && (!step.newBytes || !BackupArchive.same(actual, step.newBytes))) || (!actual && step.newBytes))
                            throw new Error('Concurrent or uncertain write');
                        if (step.oldBytes) {
                            await archive.storage.write(step.path, step.oldBytes, () => {});
                            if (!BackupArchive.same(await archive.storage.read(step.path, BackupArchive.META_LIMIT), step.oldBytes)) throw new Error('Rollback failed');
                        } else if (present) await archive.storage.remove(step.path);
                    } catch { remaining.push(step.path); }
                }
                throw new Error(`${error.message} Restore did not complete.${remaining.length ? ' Review possibly inconsistent metadata: ' + remaining.join(', ') : ' Previous metadata restored where changed.'}`);
            }
        }, options);
    }
}
if (typeof module !== 'undefined') module.exports = { ImageManagerBackup };
if (typeof window !== 'undefined') window.ImageManagerBackup = ImageManagerBackup;
