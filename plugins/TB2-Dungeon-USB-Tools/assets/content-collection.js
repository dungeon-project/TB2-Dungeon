/** Narrow, byte-preserving edits of existing collection playback settings. */
class Tb2CollectionEditing {
    static MAX_BYTES = 2 * 1024 * 1024;
    static VALUES = new Set(['resume', 'alwaysReset']);
    static running = false;
    static equal(left, right) { return left.length === right.length && left.every((byte, index) => byte === right[index]); }
    static async digest(bytes) { return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)); }

    /** JSON.parse validates syntax; token positions preserve whitespace, numbers and opaque fields. */
    static setting(bytes) {
        const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        const document = JSON.parse(text);
        if (!document || Array.isArray(document) || typeof document !== 'object') throw new Error('Invalid collection object.');
        const tokens = /"(?:\\[\s\S]|[^"\\])*"|[{}\[\]:,]|[^\s{}\[\]:,]+/g;
        let depth = 0, previous = '', key = null, location = null;
        const keys = new Set();
        for (const match of text.matchAll(tokens)) {
            const token = match[0];
            if (depth === 1 && token.startsWith('"') && (previous === '{' || previous === ',')) {
                key = JSON.parse(token);
                if (keys.has(key)) throw new Error('Duplicate collection fields prevent editing.');
                keys.add(key);
            } else if (depth === 1 && previous === ':' && key === 'resumeBehavior') {
                location = { start: match.index, end: match.index + token.length };
            }
            if (token === '{' || token === '[') depth++;
            if (token === '}' || token === ']') depth--;
            previous = token;
        }
        const value = document.resumeBehavior;
        if (!location || !this.VALUES.has(value)) throw new Error(value === undefined ?
            'Playback behavior is not specified; editing is unavailable.' : 'Unknown playback behavior; editing is unavailable.');
        // Keep the input BOM, if present, when translating character positions to byte offsets.
        const bom = bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf ? 3 : 0;
        const encoder = new TextEncoder();
        return { value, start: bom + encoder.encode(text.slice(0, location.start)).length,
            end: bom + encoder.encode(text.slice(0, location.end)).length };
    }

    static patch(bytes, value) {
        if (!this.VALUES.has(value)) throw new Error('Unsupported playback behavior.');
        const setting = this.setting(bytes), replacement = new TextEncoder().encode(JSON.stringify(value));
        const output = new Uint8Array(setting.start + replacement.length + bytes.length - setting.end);
        output.set(bytes.subarray(0, setting.start)); output.set(replacement, setting.start);
        output.set(bytes.subarray(setting.end), setting.start + replacement.length);
        return output;
    }

    /** Resolve the actual handles, including case differences on FAT-derived folder copies. */
    static async locate(directory, name) {
        const collections = [], companions = [];
        for await (const [entryName, handle] of directory.entries()) {
            const folded = entryName.toLowerCase();
            if (folded === name.toLowerCase()) collections.push({ name: entryName, handle });
            if (folded === (name + '.info').toLowerCase()) companions.push({ name: entryName, handle });
        }
        if (collections.length !== 1 || companions.length > 1 ||
            collections[0].handle.kind !== 'file' || companions.some(entry => entry.handle.kind !== 'file')) {
            throw new Error('Collection or companion file is missing or ambiguous.');
        }
        return { collection: collections[0], companion: companions[0] || null };
    }
    static async bytes(handle, limit = this.MAX_BYTES) {
        const file = await handle.getFile();
        if (file.size > limit) throw new Error('Collection or companion file exceeds its supported size.');
        return new Uint8Array(await file.slice(0, file.size).arrayBuffer());
    }

    /** Capture only session-local originals; neither document contents nor credentials enter logs. */
    static async inspect(directory, name, original) {
        const record = { directory, name, original, issue: '', value: null, readOnly: true };
        try {
            record.value = this.setting(original).value;
            const pair = await this.locate(directory, name);
            record.handle = pair.collection.handle; record.infoName = pair.companion?.name || null;
            record.infoHandle = pair.companion?.handle || null;
            record.readOnly = typeof record.handle.createWritable !== 'function';
            record.infoBytes = record.infoHandle ? await this.bytes(record.infoHandle, 40) : null;
            if (record.infoBytes && (record.infoBytes.length !== 40 ||
                !this.equal(record.infoBytes.subarray(0, 32), await this.digest(original)))) {
                throw new Error('Companion data does not match this collection. Refresh or restore a consistent copy.');
            }
        } catch (error) { record.issue = error.message; }
        return record;
    }

    /** Recheck identity, companion presence and bytes, including edits with unchanged timestamps. */
    static async assertCurrent(record) {
        const pair = await this.locate(record.directory, record.name);
        if (!(await record.handle.isSameEntry(pair.collection.handle)) ||
            (pair.companion?.name || null) !== record.infoName ||
            (record.infoHandle && !(await record.infoHandle.isSameEntry(pair.companion.handle))) ||
            !this.equal(await this.bytes(record.handle), record.original) ||
            (record.infoHandle && !this.equal(await this.bytes(record.infoHandle, 40), record.infoBytes))) {
            throw new Error('Collection changed since the scan. Refresh before saving.');
        }
    }

    /** Write a checked pair; two-file commits are not atomic, so retain originals for recovery. */
    static async save(record, value, signal) {
        const backup = typeof ContentBackup === 'undefined' ? null : ContentBackup;
        if (this.running || backup?.running) throw new Error('Another content operation is running.');
        if (!record || record.readOnly || record.issue || !record.handle?.createWritable) throw new Error('This collection is read-only or unavailable for editing.');
        if (value === this.setting(record.original).value) return false;
        const updated = this.patch(record.original, value);
        if (this.equal(updated, record.original)) return false;
        this.running = true; if (backup) backup.running = true;
        const writes = [];
        try {
            signal?.throwIfAborted();
            if (await record.directory.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Write access was denied.');
            await this.assertCurrent(record);
            signal?.throwIfAborted();
            writes.push({ handle: record.handle, before: record.original, after: updated });
            if (record.infoHandle) {
                const info = record.infoBytes.slice(); info.set(await this.digest(updated), 0);
                writes.push({ handle: record.infoHandle, before: record.infoBytes, after: info });
            }
            // Stage both files before closing either; an early failure leaves both originals intact.
            for (const entry of writes) {
                entry.writer = await entry.handle.createWritable({ mode: 'exclusive' });
                await entry.writer.write(entry.after);
            }
            await this.assertCurrent(record);
            signal?.throwIfAborted();
            for (const entry of writes) { signal?.throwIfAborted(); entry.attempted = true; await entry.writer.close(); entry.closed = true; }
            for (const entry of writes) {
                if (!this.equal(await this.bytes(entry.handle), entry.after)) throw new Error('Saved collection data failed readback verification.');
            }
            signal?.throwIfAborted();
            record.original = updated; record.value = value;
            if (record.infoHandle) record.infoBytes = writes[1].after;
            return true;
        } catch (error) {
            let recoveryFailed = false;
            for (const entry of writes) {
                if (entry.writer && !entry.closed) {
                    try { await entry.writer.abort(); } catch { recoveryFailed = true; }
                }
                if (!entry.attempted) continue;
                try {
                    const current = await this.bytes(entry.handle);
                    if (this.equal(current, entry.before)) continue;
                    if (!this.equal(current, entry.after)) throw new Error('Concurrent modification prevents recovery.');
                    const writer = await entry.handle.createWritable({ mode: 'exclusive' });
                    try { await writer.write(entry.before); await writer.close(); }
                    catch (failure) { try { await writer.abort(); } catch { /* Report recovery as failed below. */ } throw failure; }
                    if (!this.equal(await this.bytes(entry.handle), entry.before)) throw new Error('Recovery readback failed.');
                } catch { recoveryFailed = true; }
            }
            if (recoveryFailed) {
                record.issue = 'Save failed and recovery could not be verified. Collection and companion data may be inconsistent. Refresh before further edits.';
                throw new Error(record.issue);
            }
            throw new Error(`Playback behavior was not saved. ${error.message}`);
        } finally { this.running = false; if (backup) backup.running = false; }
    }
}

// Keep the established Node entry point while browser scripts load the catalog separately.
if (typeof module !== 'undefined') module.exports = {
    Tb2CollectionEditing,
    Tb2TonieCatalog: require('./content-catalog.js').Tb2TonieCatalog,
};
