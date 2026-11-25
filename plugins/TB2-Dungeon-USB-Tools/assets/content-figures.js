/** Folder-only figure authoring. No image adapter or network references are writable. */
class Tb2FigureEditing {
    static BLOCK_BYTES = 1024 * 1024;
    static MAX_TOTAL_BYTES = 0xfffffffe;
    static MAX_METADATA_BYTES = 2 * 1024 * 1024;
    static MAX_PACKET_BYTES = 1024 * 1024;
    static support() { return typeof module !== 'undefined' ? require('./content-collection.js').Tb2CollectionEditing : Tb2CollectionEditing; }
    static reader() { return typeof module !== 'undefined' ? require('./content-browser.js').Tb2ContentReader : Tb2ContentReader; }
    static check(signal) { signal?.throwIfAborted(); }

    /** The UI accepts display order only; reversal is explicit and never guessed. */
    static uid(value) {
        const normalized = value.replace(/[\s:-]/g, '').toUpperCase();
        if (!/^E004[0-9A-F]{12}$/.test(normalized)) throw new Error('Enter an eight-byte figure UID starting with E004, in display order.');
        return normalized.match(/../g).reverse().join('').toLowerCase();
    }
    static path(reference) {
        const bytes = new TextEncoder().encode(reference);
        let hash = 0x811c9dc5;
        for (const byte of bytes) hash = Math.imul(hash ^ byte, 0x01000193) >>> 0;
        const littleEndian = Uint8Array.of(hash & 255, hash >>> 8 & 255, hash >>> 16 & 255, hash >>> 24);
        const shard = btoa(String.fromCharCode(...littleEndian)).slice(0, 2).replace(/\//g, '_');
        return [shard[0], shard[1], btoa(String.fromCharCode(...bytes)).replace(/=+$/, '')];
    }

    /** Shared operation flag also excludes backup and resume writers, including direct calls. */
    static async operation(root, action) {
        const support = this.support(), backup = typeof ContentBackup === 'undefined' ? null : ContentBackup;
        if (!root || root.forScan || typeof root.removeEntry !== 'function') throw new Error('Select a writable folder. SD images are read-only.');
        if (support.running || backup?.running) throw new Error('Another content operation is running.');
        support.running = true; if (backup) backup.running = true;
        try { return await action(); }
        finally { support.running = false; if (backup) backup.running = false; }
    }
    static async permission(root) {
        if (await root.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('Write access was denied.');
    }
    static async matches(directory, name) {
        const matches = [];
        for await (const [actual, handle] of directory.entries()) {
            if (actual.toLowerCase() === name.toLowerCase()) matches.push({ name: actual, handle });
        }
        return matches;
    }
    static async vacant(directory, name) {
        if ((await this.matches(directory, name)).length) throw new Error(`Already occupied: ${name}. Nothing will be replaced.`);
    }
    static async directory(parent, name) {
        const matches = await this.matches(parent, name);
        if (matches.length > 1 || matches[0]?.handle.kind === 'file') throw new Error('Ambiguous or conflicting content directory.');
        return matches[0]?.handle || parent.getDirectoryHandle(name, { create: true });
    }

    /** Validate bounded Ogg pages, CRC and packet framing before any destination is created. */
    static async validateAudio(file, signal) {
        let offset = 0, sequence = 0, serial = null, ended = false, packetBytes = 0, packetCount = 0;
        let prefix = [], headerParts = [], previousGranule = 0n;
        while (offset < file.size) {
            this.check(signal);
            const header = new Uint8Array(await file.slice(offset, offset + 27).arrayBuffer());
            if (header.length !== 27 || new TextDecoder().decode(header.slice(0, 4)) !== 'OggS' || header[4] !== 0) throw new Error('Invalid or truncated Ogg page.');
            const view = new DataView(header.buffer), flags = header[5];
            if (ended || flags & ~7 || !!(flags & 1) !== (packetBytes > 0) || (sequence === 0 ? flags !== 2 : !!(flags & 2))) throw new Error('Unsupported Ogg stream framing.');
            const currentSerial = view.getUint32(14, true);
            if (serial === null) serial = currentSerial;
            if (serial !== currentSerial || view.getUint32(18, true) !== sequence++) throw new Error('Ogg stream or page sequence is invalid.');
            const lacing = new Uint8Array(await file.slice(offset + 27, offset + 27 + header[26]).arrayBuffer());
            if (lacing.length !== header[26] || !lacing.length) throw new Error('Missing Ogg segment table.');
            const length = 27 + lacing.length + lacing.reduce((sum, value) => sum + value, 0);
            const page = new Uint8Array(await file.slice(offset, offset + length).arrayBuffer());
            if (page.length !== length) throw new Error('Truncated Ogg payload.');
            const expectedCrc = view.getUint32(22, true); page.fill(0, 22, 26);
            let crc = 0;
            for (const byte of page) { crc ^= byte << 24; for (let bit = 0; bit < 8; bit++) crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0; }
            if (crc !== expectedCrc) throw new Error('Ogg page checksum failed.');
            let position = 27 + lacing.length;
            for (const size of lacing) {
                if (prefix.length < 19) prefix.push(...page.slice(position, position + Math.min(size, 19 - prefix.length)));
                if (packetCount < 2) headerParts.push(page.slice(position, position + size));
                packetBytes += size; position += size;
                if (packetBytes > this.MAX_PACKET_BYTES) throw new Error('Ogg packet exceeds the supported size.');
                if (size < 255) {
                    const signature = new TextDecoder().decode(Uint8Array.from(prefix.slice(0, 8)));
                    if (!packetCount && (signature !== 'OpusHead' || packetBytes !== 19 || prefix[8] !== 1 || ![1, 2].includes(prefix[9]) || prefix[18] !== 0)) throw new Error('Only mono/stereo Opus with mapping family 0 is supported.');
                    if (packetCount === 1 && (signature !== 'OpusTags' || packetBytes < 16)) throw new Error('Missing Opus comment header.');
                    if (packetCount === 1) {
                        const tags = new Uint8Array(packetBytes); let copied = 0;
                        for (const part of headerParts) { tags.set(part, copied); copied += part.length; }
                        this.validateTags(tags);
                    }
                    if (packetCount > 1 && !packetBytes) throw new Error('Empty Opus audio packet.');
                    packetCount++; packetBytes = 0; prefix = []; headerParts = [];
                }
            }
            const granule = view.getBigUint64(6, true);
            if (granule !== 0xffffffffffffffffn) {
                if (granule < previousGranule) throw new Error('Ogg timestamps run backwards.');
                previousGranule = granule;
            }
            offset += length; ended = !!(flags & 4);
            if (sequence % 32 === 0) await new Promise(resolve => setTimeout(resolve, 0));
        }
        if (!ended || packetBytes || packetCount < 3) throw new Error('Ogg/Opus stream is incomplete.');
    }

    /** OpusTags lengths must fit the packet; arbitrary padding after comments is legal. */
    static validateTags(bytes) {
        const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        let offset = 8;
        const length = () => {
            if (offset + 4 > bytes.length) throw new Error('Truncated Opus comment header.');
            const value = view.getUint32(offset, true); offset += 4; return value;
        };
        const vendorLength = length(); offset += vendorLength;
        const comments = length();
        if (comments > (bytes.length - offset) / 4) throw new Error('Invalid Opus comment count.');
        for (let index = 0; index < comments; index++) {
            const size = length(); offset += size;
            if (offset > bytes.length) throw new Error('Truncated Opus comment.');
        }
    }

    /** Block hashes give bounded readback and conservative ownership checks during cleanup. */
    static async fingerprints(file, signal) {
        const hashes = [];
        for (let offset = 0; offset < file.size; offset += this.BLOCK_BYTES) {
            this.check(signal);
            const bytes = await file.slice(offset, offset + this.BLOCK_BYTES).arrayBuffer();
            hashes.push(Array.from(await this.support().digest(bytes)).join(','));
        }
        return { size: file.size, hashes };
    }
    static same(left, right) { return JSON.stringify(left) === JSON.stringify(right); }
    static async writeNew(directory, name, file, created, signal, path) {
        this.check(signal); await this.vacant(directory, name);
        const expected = await this.fingerprints(file, signal);
        await this.vacant(directory, name);
        const handle = await directory.getFileHandle(name, { create: true });
        const initial = await handle.getFile();
        if (initial.size !== 0) throw new Error(`Destination appeared during creation: ${path}`);
        const record = { directory, name, handle, path, expected, committed: false }; created.push(record);
        const writer = await handle.createWritable({ mode: 'exclusive' });
        try {
            for (let offset = 0; offset < file.size; offset += this.BLOCK_BYTES) {
                this.check(signal); await writer.write(new Uint8Array(await file.slice(offset, offset + this.BLOCK_BYTES).arrayBuffer()));
            }
            this.check(signal);
            const current = await handle.getFile(), matches = await this.matches(directory, name);
            if (current.size !== 0 || current.lastModified !== initial.lastModified || matches.length !== 1 ||
                !await handle.isSameEntry(matches[0].handle)) throw new Error(`Destination changed during writing: ${path}`);
            await writer.close(); record.committed = true;
        } catch (error) { try { await writer.abort(); } catch { /* Ownership checks below report any unverified output. */ } throw error; }
        if (!this.same(expected, await this.fingerprints(await handle.getFile(), signal))) throw new Error(`Readback failed: ${path}`);
        return record;
    }
    static async cleanup(created) {
        const remaining = [];
        for (const record of [...created].reverse()) {
            try {
                const matches = await this.matches(record.directory, record.name);
                if (!matches.length) continue;
                if (matches.length !== 1 || !await record.handle.isSameEntry(matches[0].handle)) throw new Error('Identity changed');
                // Only verified committed bytes qualify. Empty staged remnants are not claimed.
                if (!record.committed || !this.same(record.expected, await this.fingerprints(await record.handle.getFile()))) throw new Error('Content changed');
                await record.directory.removeEntry(record.name);
            } catch { remaining.push(record.path); }
        }
        return remaining;
    }

    /** Publish metadata last, so a failed audio transfer cannot expose a playable collection. */
    static async add(root, uid, files, { signal, progress = () => {} } = {}) {
        return this.operation(root, async () => {
            const name = this.uid(uid), created = [];
            if (!files.length) throw new Error('Select at least one MP3 or Ogg/Opus track.');
            let total = files.reduce((sum, file) => sum + file.size, 0);
            if (!Number.isSafeInteger(total) || total > this.MAX_TOTAL_BYTES) throw new Error('Total audio size exceeds the supported limit.');
            // Request while the explicit confirmation still has browser user activation.
            await this.permission(root); this.check(signal);
            const collections = await root.getDirectoryHandle('collections'), content = await root.getDirectoryHandle('content');
            await this.vacant(collections, name); await this.vacant(collections, name + '.info');
            const operationId = crypto.randomUUID().replace(/-/g, '');
            const entries = files.map((file, index) => ({ type: 'audio', name: `coreflasher_${name}_${operationId}_${index + 1}`, auth: '', analytics: {}, fileSize: file.size }));
            const Converter = typeof module !== 'undefined' ? require('./audio-converter.js').Tb2AudioConverter : Tb2AudioConverter;
            const converter = new Converter();
            total = 0;
            try {
                for (const [index, originalFile] of files.entries()) {
                    this.check(signal);
                    const file = await converter.prepare(originalFile, { signal,
                        progress: message => progress(`Track ${index + 1} of ${files.length}: ${message}`) });
                    await this.validateAudio(file, signal);
                    entries[index].fileSize = file.size; total += file.size;
                    if (total > this.MAX_TOTAL_BYTES) throw new Error('Converted audio exceeds the supported total size.');
                    this.check(signal); progress(`Writing and checking track ${index + 1}/${files.length}…`);
                    const parts = this.path(entries[index].name);
                    const first = await this.directory(content, parts[0]), second = await this.directory(first, parts[1]);
                    await this.writeNew(second, parts[2], file, created, signal, `content/${first.name}/${second.name}/${parts[2]}`);
                }
                // Build metadata only from verified output sizes, preserving the user's order.
                const bytes = new TextEncoder().encode(JSON.stringify({ version: 1, contentType: 'content_tonie', tonieType: 'content', resumeBehavior: 'resume', tonieSalesId: '', content: entries }));
                if (bytes.length > this.MAX_METADATA_BYTES) throw new Error('Collection exceeds the 2 MiB metadata limit.');
                const info = new Uint8Array(40); info.set(await this.support().digest(bytes));
                const infoView = new DataView(info.buffer); infoView.setUint32(32, total, true); infoView.setUint32(36, total, true);
                await this.vacant(collections, name); await this.vacant(collections, name + '.info');
                await this.writeNew(collections, name + '.info', new Blob([info]), created, signal, `collections/${name}.info`);
                await this.vacant(collections, name);
                await this.writeNew(collections, name, new Blob([bytes]), created, signal, `collections/${name}`);
                const scan = await this.reader().scan(root, { signal });
                const added = scan.collections.find(item => item.sourceName === name);
                if (!added || added.editing?.issue || added.tracks.length !== files.length || added.tracks.some((track, index) => !track.file || track.issue || track.warning || track.file.name !== this.path(entries[index].name)[2])) throw new Error('New collection failed the final scan.');
                return scan;
            } catch (error) {
                const remaining = await this.cleanup(created);
                throw new Error(`Figure was not added successfully. ${error.message}${remaining.length ? '\nFiles requiring review:\n' + remaining.join('\n') : '\nCreated files were removed.'}`);
            } finally { converter.dispose(); }
        });
    }

    /** A fresh full scan protects references from every type, not just playable UI tracks. */
    static async preview(root, name, { signal } = {}) {
        if (!root || root.forScan || typeof root.removeEntry !== 'function') throw new Error('SD images are read-only. Select a folder.');
        const scan = await this.reader().scan(root, { signal });
        if (!scan.complete || !scan.metadataComplete) throw new Error('Cannot safely delete: some collection metadata is unreadable or invalid.');
        const selected = scan.metadata.find(record => record.name === name);
        if (!selected || selected.document.contentType !== 'content_tonie' || selected.document.tonieType !== 'content' || selected.document.content.some(entry => entry.type !== 'audio')) throw new Error('Only regular audio figures can be deleted.');
        const pair = await this.support().locate(selected.directory, name);
        const candidates = entry => [...new Set([entry.name, entry.url].filter(value => typeof value === 'string').flatMap(reference => scan.referenceIndex.get(reference) || []))];
        const protectedPaths = new Set();
        for (const record of scan.metadata) if (record !== selected) for (const entry of record.document.content) for (const file of candidates(entry)) protectedPaths.add(file.path);
        const targets = new Map(), preserved = new Map(), skipped = [];
        for (const [index, entry] of selected.document.content.entries()) {
            const matches = candidates(entry);
            if (!matches.length) skipped.push(`Track ${index + 1}: missing file; nothing removed.`);
            for (const file of matches) {
                if (matches.length !== 1 || protectedPaths.has(file.path)) preserved.set(file.path, { ...file, reason: matches.length !== 1 ? 'ambiguous reference' : 'used by another collection' });
                else targets.set(file.path, file);
            }
        }
        for (const path of preserved.keys()) targets.delete(path);
        const collectionTarget = { directory: selected.directory, name, handle: selected.handle, path: `collections/${name}` };
        const infoTarget = pair.companion && { directory: selected.directory, ...pair.companion, path: `collections/${pair.companion.name}` };
        const remove = [collectionTarget, ...(infoTarget ? [infoTarget] : []), ...targets.values()];
        for (const record of [...remove, ...preserved.values()]) {
            this.check(signal); record.fingerprint = await this.fingerprints(await record.handle.getFile(), signal);
        }
        return { root, name, metadata: scan.metadata, remove, preserved: [...preserved.values()], skipped };
    }
    static signature(preview) {
        return { metadata: preview.metadata.map(record => [record.name, Array.from(record.bytes)]),
            remove: preview.remove.map(record => [record.path, record.fingerprint]), preserved: preview.preserved.map(record => [record.path, record.fingerprint]) };
    }

    /** Concurrent metadata edits must not introduce a new owner during a long deletion. */
    static async assertReferences(preview, removed) {
        const expected = preview.metadata.filter(record => !removed.includes(`collections/${record.name}`));
        const directory = preview.metadata[0].directory, names = [];
        for await (const [name, handle] of directory.entries()) {
            if (handle.kind === 'file' && !name.toLowerCase().endsWith('.info')) names.push(name);
        }
        if (!this.same(names.sort(), expected.map(record => record.name).sort())) throw new Error('Collection set changed during deletion.');
        for (const record of expected) {
            const handle = await directory.getFileHandle(record.name);
            if (!await handle.isSameEntry(record.handle) || !this.support().equal(await this.support().bytes(handle), record.bytes)) throw new Error('Collection references changed during deletion.');
        }
    }

    /** Rebuild the exact preview before removal; no recursion or orphan cleanup is permitted. */
    static async remove(preview, { signal, progress = () => {} } = {}) {
        return this.operation(preview.root, async () => {
            await this.permission(preview.root);
            const current = await this.preview(preview.root, preview.name, { signal });
            if (!this.same(this.signature(preview), this.signature(current))) throw new Error('Files or references changed. Review a new deletion preview.');
            for (let index = 0; index < current.remove.length; index++) if (!await current.remove[index].handle.isSameEntry(preview.remove[index].handle)) throw new Error('File identity changed. Review a new deletion preview.');
            const removed = [];
            try {
                for (const record of current.remove) {
                    this.check(signal); await this.assertReferences(current, removed); progress(`Removing ${record.path}`);
                    const matches = await this.matches(record.directory, record.name);
                    if (matches.length !== 1 || !await record.handle.isSameEntry(matches[0].handle)) throw new Error('File identity changed before deletion.');
                    if (!this.same(record.fingerprint, await this.fingerprints(await record.handle.getFile(), signal))) throw new Error('File changed before deletion.');
                    await record.directory.removeEntry(record.name); removed.push(record.path);
                }
                for (const record of current.remove) if ((await this.matches(record.directory, record.name)).length) throw new Error('Deleted file is still present.');
                for (const record of current.preserved) {
                    if (!(await this.matches(record.directory, record.name)).length || !this.same(record.fingerprint, await this.fingerprints(await record.handle.getFile(), signal))) throw new Error('A protected file changed or disappeared.');
                }
                return await this.reader().scan(preview.root, { signal });
            } catch (error) {
                throw new Error(`Deletion did not complete. ${error.message}\nRemoved:\n${removed.join('\n') || 'None'}\nRemaining / review:\n${current.remove.filter(record => !removed.includes(record.path)).map(record => record.path).join('\n') || 'Verify the folder again.'}`);
            }
        });
    }
}
if (typeof module !== 'undefined') module.exports = { Tb2FigureEditing };
