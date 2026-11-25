/** Local, single-generation content backups through the File System Access API.
 * Data never leaves the selected directories. No device or serial commands are used.
 */
class ContentBackup {
    static BLOCK_SIZE = 4 * 1024 * 1024;
    static MANIFEST = 'content-backup.json';
    static FORMAT = 'core-flasher-content-v1';
    static running = false;

    static check(signal) { signal?.throwIfAborted(); }
    static equal(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
    static path(path) {
        if (typeof path !== 'string' || !path || path.split('/').some(part =>
            !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part))) {
            throw new Error('Invalid relative file path in backup.');
        }
        return path;
    }
    static async permission(handle, mode) {
        if (await handle.queryPermission({mode}) !== 'granted' &&
            await handle.requestPermission({mode}) !== 'granted') {
            throw new Error(`Access to “${handle.name}” denied.`);
        }
    }
    static async disjoint(a, b) {
        if (await a.isSameEntry(b) || await a.resolve(b) !== null || await b.resolve(a) !== null) {
            throw new Error('Box and backup folders must be separate and must not contain each other.');
        }
    }
    /** Resolve beneath an explicitly selected root; never interpret arbitrary absolute paths. */
    static async entry(root, path, kind, create = false) {
        const parts = this.path(path).split('/');
        const name = parts.pop();
        for (const part of parts) root = await root.getDirectoryHandle(part, {create});
        return kind === 'directory' ? root.getDirectoryHandle(name, {create}) : root.getFileHandle(name, {create});
    }
    static async optional(root, path, kind) {
        try { return await this.entry(root, path, kind); }
        catch (error) { if (error.name === 'NotFoundError') return null; throw error; }
    }
    static async digest(bytes) {
        const hash = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(hash), value => value.toString(16).padStart(2, '0')).join('');
    }
    /** Hash bounded slices and detect metadata changes during the read. */
    static async fingerprint(handle, signal, progress = () => {}) {
        const file = await handle.getFile(), hashes = [];
        for (let offset = 0; offset < file.size; offset += this.BLOCK_SIZE) {
            this.check(signal);
            hashes.push(await this.digest(await file.slice(offset, offset + this.BLOCK_SIZE).arrayBuffer()));
            progress(Math.min(offset + this.BLOCK_SIZE, file.size), file.size);
        }
        this.check(signal);
        const after = await handle.getFile();
        if (file.size !== after.size || file.lastModified !== after.lastModified) throw new Error(`Source file changed while reading: ${handle.name}`);
        return {size:file.size, hashes};
    }
    static async scan(root, signal, progress, prefix = '', result = [], hashFiles = true) {
        for await (const [name, handle] of root.entries()) {
            this.check(signal);
            const path = this.path(prefix + name);
            progress({phase:'Checking folders', path});
            if (handle.kind === 'directory') {
                result.push({path, type:'directory'});
                await this.scan(handle, signal, progress, path + '/', result, hashFiles);
            } else if (handle.kind === 'file') {
                try {
                    const file = hashFiles ? null : await handle.getFile();
                    result.push({path, type:'file', ...(hashFiles ? await this.fingerprint(handle, signal) : {size:file.size, modified:file.lastModified})});
                }
                catch (error) { throw new Error(`${path}: ${error.message}`, {cause:error}); }
            } else throw new Error(`Unsupported entry: ${path}`);
        }
        return result.sort((a,b) => a.path.localeCompare(b.path));
    }
    /** Reject corrupt manifests, ambiguous paths and incomplete directory trees before writing. */
    static validate(manifest) {
        if (!manifest || manifest.format !== this.FORMAT || manifest.blockSize !== this.BLOCK_SIZE ||
            typeof manifest.complete !== 'boolean' || !Array.isArray(manifest.entries)) throw new Error('Invalid backup manifest.');
        const entries = new Map(), folded = new Set();
        for (const entry of manifest.entries) {
            this.path(entry.path);
            const foldedPath = entry.path.toLowerCase();
            if (folded.has(foldedPath)) throw new Error('Duplicate or ambiguous paths in backup.');
            folded.add(foldedPath); entries.set(entry.path, entry);
            if (entry.type === 'directory') continue;
            if (entry.type !== 'file' || !Number.isSafeInteger(entry.size) || entry.size < 0 || !Array.isArray(entry.hashes) ||
                entry.hashes.length !== Math.ceil(entry.size / this.BLOCK_SIZE) ||
                !entry.hashes.every(hash => typeof hash === 'string' && /^[0-9a-f]{64}$/.test(hash))) throw new Error('Invalid file checksums in backup.');
        }
        for (const path of entries.keys()) {
            const parts = path.split('/'); parts.pop();
            while (parts.length) {
                if (entries.get(parts.join('/'))?.type !== 'directory') throw new Error('Incomplete folder structure in manifest.');
                parts.pop();
            }
        }
        return manifest;
    }
    static async load(root) {
        const handle = await this.optional(root, this.MANIFEST, 'file');
        if (!handle) return null;
        const file = await handle.getFile();
        // A corrupt file must not force an unbounded allocation before JSON validation.
        if (file.size > 64 * 1024 * 1024) throw new Error('Backup manifest is too large.');
        try { return this.validate(JSON.parse(await file.text())); }
        catch (error) { throw new Error(`Cannot read backup manifest: ${error.message}`); }
    }
    static async writeManifest(root, manifest) {
        const handle = await root.getFileHandle(this.MANIFEST, {create:true});
        const writer = await handle.createWritable();
        try { await writer.write(JSON.stringify(manifest)); await writer.close(); }
        catch (error) {
            try { await writer.abort(); }
            catch (cleanup) { throw new Error(`Manifest not saved: ${error.message}; Failed to abort write: ${cleanup.message}`); }
            throw error;
        }
    }
    static async verify(root, entries, signal, progress) {
        for (const [index, entry] of entries.entries()) {
            this.check(signal);
            progress({phase:'Verifying backup', path:entry.path, index, total:entries.length});
            const handle = await this.entry(root, entry.path, entry.type);
            if (entry.type === 'file') {
                const actual = await this.fingerprint(handle, signal, (bytes, totalBytes) =>
                    progress({phase:'Verifying', path:entry.path, index, total:entries.length, bytes, totalBytes}));
                if (!this.equal(actual, {size:entry.size, hashes:entry.hashes})) throw new Error(`Checksum mismatch: ${entry.path}`);
            }
        }
    }
    /** Copy verified blocks; abort the current writable on failure, never delete other files. */
    static async copy(source, target, entry, signal, progress) {
        this.check(signal);
        const sourceHandle = await this.entry(source, entry.path, 'file');
        const file = await sourceHandle.getFile();
        if (file.size !== entry.size) throw new Error(`Source changed: ${entry.path}`);
        const handle = await this.entry(target, entry.path, 'file', true);
        const writer = await handle.createWritable();
        try {
            for (let offset = 0, block = 0; offset < file.size; offset += this.BLOCK_SIZE, block++) {
                this.check(signal);
                const bytes = await file.slice(offset, offset + this.BLOCK_SIZE).arrayBuffer();
                if (await this.digest(bytes) !== entry.hashes[block]) throw new Error(`Source changed: ${entry.path}`);
                await writer.write(bytes);
                progress(Math.min(offset + this.BLOCK_SIZE, file.size), file.size);
            }
            this.check(signal);
            const after = await sourceHandle.getFile();
            if (after.size !== file.size || after.lastModified !== file.lastModified) throw new Error(`Source changed: ${entry.path}`);
            await writer.close();
        } catch (error) {
            try { await writer.abort(); }
            catch (cleanup) { throw new Error(`${entry.path}: ${error.message}; Failed to abort write: ${cleanup.message}`); }
            throw error;
        }
    }
    /** List exact deletion candidates; keep backup metadata outside the content root. */
    static async extras(root, entries, signal, progress) {
        const keep = new Set(entries.map(entry => entry.path));
        return (await this.scan(root, signal, progress, '', [], false)).filter(entry => !keep.has(entry.path));
    }
    /** Delete individual approved entries deepest first; never recursively remove unreviewed contents. */
    static async removeExtras(root, entries, signal, progress) {
        const deepest = entries.slice().sort((a,b) => b.path.split('/').length - a.path.split('/').length);
        for (const [index, entry] of deepest.entries()) {
            this.check(signal);
            progress({phase:'Deleting additional entries', path:entry.path, index, total:deepest.length});
            const parts = this.path(entry.path).split('/'), name = parts.pop();
            let parent = root;
            for (const part of parts) parent = await parent.getDirectoryHandle(part);
            const current = await this.entry(root, entry.path, entry.type);
            if (entry.type === 'file') {
                const file = await current.getFile();
                if (file.size !== entry.size || file.lastModified !== entry.modified) throw new Error(`Deletion candidate changed: ${entry.path}`);
            }
            await parent.removeEntry(name, {recursive:false});
        }
    }
    static async backup(mode, box, root, signal, progress, removeExtras, confirm) {
        const previous = await this.load(root);
        if (mode === 'full' && previous?.complete) throw new Error('Backup already exists. Use Incremental Backup.');
        if (mode === 'incremental' && !previous) throw new Error('No backup found. Create a Full Backup first.');
        if (!previous) {
            for await (const _entry of root.entries()) throw new Error('Full Backup requires an empty backup folder.');
        }
        const source = await this.scan(box, signal, progress);
        const merged = new Map((removeExtras ? [] : previous?.entries || []).map(entry => [entry.path, entry]));
        for (const entry of source) {
            if (merged.has(entry.path) && merged.get(entry.path).type !== entry.type) throw new Error(`File/folder conflict: ${entry.path}`);
            merged.set(entry.path, entry);
        }
        const manifest = this.validate({format:this.FORMAT, blockSize:this.BLOCK_SIZE, complete:false,
            entries:[...merged.values()].sort((a,b)=>a.path.localeCompare(b.path))});
        const existingContent = previous ? await this.optional(root, 'content', 'directory') : null;
        const removals = removeExtras && existingContent ? await this.extras(existingContent, manifest.entries, signal, progress) : [];
        if (removals.length && !await confirm({operation:'backup', removals})) return {cancelled:true};
        this.check(signal);
        // Journal the full intended state first: interrupted files can never look like a complete backup.
        await this.writeManifest(root, manifest);
        const content = await root.getDirectoryHandle('content', {create:true});
        let copied = 0, skipped = 0;
        for (const [index, entry] of source.entries()) {
            this.check(signal);
            progress({phase:'Backing up', path:entry.path, index, total:source.length});
            if (entry.type === 'directory') { await this.entry(content, entry.path, 'directory', true); continue; }
            const existing = await this.optional(content, entry.path, 'file');
            if (existing && this.equal(await this.fingerprint(existing, signal), {size:entry.size, hashes:entry.hashes})) { skipped++; continue; }
            await this.copy(box, content, entry, signal, (bytes,totalBytes)=>progress({phase:'Backing up',path:entry.path,index,total:source.length,bytes,totalBytes}));
            copied++;
        }
        await this.verify(content, manifest.entries, signal, progress);
        if (!this.equal(source, await this.scan(box, signal, progress))) throw new Error('Content source changed during backup. Backup remains incomplete.');
        await this.removeExtras(content, removals, signal, progress);
        if (removeExtras && (await this.extras(content, manifest.entries, signal, progress)).length) throw new Error('Backup destination changed during the operation. Backup remains incomplete.');
        this.check(signal);
        await this.writeManifest(root, {...manifest, complete:true});
        return {copied, skipped, removed:removals.length};
    }
    static async restore(box, root, signal, progress, confirm, removeExtras) {
        const manifest = await this.load(root);
        if (!manifest?.complete) throw new Error('Only complete, verified backups can be restored.');
        const content = await root.getDirectoryHandle('content');
        await this.verify(content, manifest.entries, signal, progress);
        const preview = {operation:'restore', created:0, overwritten:0, bytes:0,
            removals:removeExtras ? await this.extras(box, manifest.entries, signal, progress) : []};
        for (const entry of manifest.entries) {
            this.check(signal);
            const existing = await this.optional(box, entry.path, entry.type);
            if (entry.type === 'file') { preview[existing ? 'overwritten' : 'created']++; preview.bytes += entry.size; }
        }
        if (!await confirm(preview)) return {cancelled:true};
        for (const [index, entry] of manifest.entries.entries()) {
            this.check(signal);
            progress({phase:'Restoring', path:entry.path, index, total:manifest.entries.length});
            if (entry.type === 'directory') await this.entry(box, entry.path, 'directory', true);
            else await this.copy(content, box, entry, signal, (bytes,totalBytes)=>progress({phase:'Restoring',path:entry.path,index,total:manifest.entries.length,bytes,totalBytes}));
        }
        await this.verify(box, manifest.entries, signal, progress);
        await this.removeExtras(box, preview.removals, signal, progress);
        if (removeExtras && (await this.extras(box, manifest.entries, signal, progress)).length) throw new Error('Restore destination changed; additional entries were not automatically deleted.');
        return {copied:preview.created + preview.overwritten, skipped:0, removed:preview.removals.length};
    }
    /** One operation across all cards; permissions are requested before scans or writes. */
    static async run(mode, box, root, {signal, progress = () => {}, confirm = async () => false, removeExtras = false} = {}) {
        if (this.running) throw new Error('A content operation is already running.');
        if (!['full','incremental','restore'].includes(mode)) throw new Error('Unknown content action.');
        this.running = true;
        try {
            await this.permission(mode === 'restore' ? box : root, 'readwrite');
            await this.permission(mode === 'restore' ? root : box, 'read');
            this.check(signal); await this.disjoint(box, root);
            return mode === 'restore' ? await this.restore(box, root, signal, progress, confirm, removeExtras)
                : await this.backup(mode, box, root, signal, progress, removeExtras, confirm);
        } finally { this.running = false; }
    }
}
if (typeof module !== 'undefined') module.exports = ContentBackup;
