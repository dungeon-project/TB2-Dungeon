const Tb2CollectionSupport = typeof module !== 'undefined' ? require('./content-collection.js') : { Tb2CollectionEditing, Tb2TonieCatalog };

/** TB2 collection lookup. References are lookup keys, never network URLs. */
class Tb2ContentReader {
    static MAX_COLLECTION_BYTES = 2 * 1024 * 1024;
    static YIELD_EVERY = 32;
    static TYPES = new Set(['content_tonie', 'audio_feedback', 'purchasable', 'tonieplay']);

    /** Accept canonical Base64 with optional padding and decode UTF-8 without guessing paths. */
    static decodeName(name) {
        if (!/^[A-Za-z0-9+/]+={0,2}$/.test(name) || name.length % 4 === 1) return null;
        try {
            const bytes = Uint8Array.from(atob(name), character => character.charCodeAt(0));
            if (btoa(String.fromCharCode(...bytes)).replace(/=+$/, '') !== name.replace(/=+$/, '')) return null;
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        } catch { return null; } // Ordinary filenames need not be encoded references.
    }

    /** Only human-readable labels enter the UI; IDs and URL-shaped names use honest fallbacks. */
    static label(value, fallback) {
        if (typeof value !== 'string') return fallback;
        const text = value.trim();
        if (!text || text.length > 160 || /[\x00-\x1f]|:\/\/|[\\/]|[?&=]/.test(text) ||
            /^[0-9a-f-]{16,}$/i.test(text)) return fallback;
        return text;
    }

    /** Retain all matches so duplicate or conflicting references cannot silently select a file. */
    static resolve(entry, index) {
        const references = [...new Set([entry.url, entry.name].filter(value => typeof value === 'string' && value))];
        const matches = new Set();
        let duplicate = false;
        for (const reference of references) {
            const candidates = index.get(reference) || [];
            duplicate ||= candidates.length > 1;
            for (const candidate of candidates) matches.add(candidate);
        }
        if (duplicate || matches.size > 1) return { issue: 'Ambiguous local file reference.' };
        if (!matches.size) return { issue: 'Local file is missing.' };
        return { file: [...matches][0] };
    }

    /** Convert only allowlisted metadata; auth and raw references never leave this method. */
    static collection(data, index, number) {
        const fallback = `Collection ${String(number).padStart(3, '0')}`;
        const result = { title: fallback, type: 'unknown', tracks: [], details: [], issue: '' };
        if (!data || typeof data !== 'object' || !Array.isArray(data.content)) {
            result.issue = 'Invalid collection: expected a content list.';
            return result;
        }
        result.title = this.label(data.title, this.label(data.name, fallback));
        result.baseTitle = result.title;
        result.salesId = Tb2CollectionSupport.Tb2TonieCatalog.id(data.tonieSalesId);
        result.type = this.TYPES.has(data.contentType) ? data.contentType : 'unknown';
        if (result.type === 'unknown') result.issue = 'Unknown collection type; entries are shown in details.';
        for (const [position, entry] of data.content.entries()) {
            if (!entry || typeof entry !== 'object') {
                result.details.push(`Entry ${position + 1}: invalid metadata.`); continue;
            }
            if (entry.type !== 'audio' || result.type === 'unknown') {
                const kind = ['tonieplay-mpy', 'gamedata', 'audio'].includes(entry.type) ? entry.type : 'unknown type';
                result.details.push(`Entry ${position + 1}: ${kind} (not played).`); continue;
            }
            // Array order is the stored playback order; never sort tracks by filenames or labels.
            const resolved = this.resolve(entry, index);
            const declaredSize = Number.isSafeInteger(entry.fileSize) && entry.fileSize >= 0 ? entry.fileSize : null;
            const fallbackTitle = this.label(entry.filename, `Track ${String(position + 1).padStart(2, '0')}`);
            const track = { title: this.label(entry.title, this.label(entry.name, fallbackTitle)),
                position: position + 1, declaredSize, file: resolved.file || null, issue: resolved.issue || '', warning: '' };
            if (track.file?.error) track.issue = 'Local file could not be read.';
            if (track.file && declaredSize !== null && track.file.size !== declaredSize) {
                track.warning = 'Declared and actual file sizes differ; completeness is unverified.';
            }
            result.tracks.push(track);
        }
        return result;
    }

    /** Scan handles and small JSON only. Progress contains counts, never private filenames. */
    static async scan(root, { signal, progress = () => {}, result = { collections: [], files: 0, complete: false } } = {}) {
        const check = () => signal?.throwIfAborted();
        root = root.forScan ? root.forScan(signal) : root;
        if (await root.queryPermission({ mode: 'read' }) !== 'granted' &&
            await root.requestPermission({ mode: 'read' }) !== 'granted') throw new Error('Read access was denied.');
        check();
        let content, collections;
        try {
            content = await root.getDirectoryHandle('content');
            collections = await root.getDirectoryHandle('collections');
        } catch {
            throw new Error('Select the folder containing both collections and content.');
        }
        const index = new Map();
        result.referenceIndex = index; result.metadata = [];
        const report = async () => {
            progress({ files: result.files, collections: result.collections.length });
            await new Promise(resolve => setTimeout(resolve, 0));
            check();
        };
        // Iterative walking keeps deeply nested copies off the JavaScript call stack.
        const pending = [{ handle: content, path: 'content' }];
        let visited = 0;
        while (pending.length) {
            const directory = pending.pop();
            for await (const [name, handle] of directory.handle.entries()) {
                check();
                const relativePath = `${directory.path}/${name}`;
                if (handle.kind === 'directory') pending.push({ handle, path: relativePath });
                else if (handle.kind === 'file') {
                    const record = { handle, directory: directory.handle, name, path: relativePath, size: null, modified: null, error: false };
                    try { const file = await handle.getFile(); record.size = file.size; record.modified = file.lastModified; }
                    catch { record.error = true; }
                    const reference = this.decodeName(name);
                    if (reference !== null) {
                        const candidates = index.get(reference) || [];
                        candidates.push(record); index.set(reference, candidates);
                    }
                    result.files++;
                }
                if (++visited % this.YIELD_EVERY === 0) await report();
            }
        }
        // Sorting collection filenames makes generated labels stable without changing track order.
        const handles = [];
        for await (const [name, handle] of collections.entries()) {
            check();
            if (handle.kind === 'file' && !name.toLowerCase().endsWith('.info')) handles.push([name, handle]);
            if (++visited % this.YIELD_EVERY === 0) await report();
        }
        handles.sort(([left], [right]) => left.localeCompare(right));
        for (const [name, handle] of handles) {
            check();
            let parsed;
            const number = result.collections.length + 1;
            try {
                const file = await handle.getFile();
                if (file.size > this.MAX_COLLECTION_BYTES) {
                    parsed = this.collection(null, index, number);
                    parsed.issue = 'Collection exceeds the 2 MiB metadata limit.';
                } else {
                    const bytes = new Uint8Array(await file.slice(0, file.size).arrayBuffer());
                    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
                    parsed = this.collection(document, index, number);
                    parsed.sourceName = name;
                    result.metadata.push({ name, handle, directory: collections, bytes, document });
                    parsed.editing = await Tb2CollectionSupport.Tb2CollectionEditing.inspect(collections, name, bytes);
                }
            } catch {
                parsed = this.collection(null, index, number);
                parsed.issue = 'Collection could not be read or contains invalid JSON.';
            }
            check(); result.collections.push(parsed);
            await report();
        }
        result.metadataComplete = result.metadata.length === handles.length && result.metadata.every(record =>
            Array.isArray(record.document?.content) && record.document.content.every(entry => entry && typeof entry === 'object' &&
                ['name', 'url'].every(key => entry[key] === undefined || typeof entry[key] === 'string')));
        result.complete = true;
        return result;
    }

    /** Open a fresh snapshot and inspect only the Ogg identification header before playback. */
    static async open(track) {
        if (!track?.file || track.issue) throw new Error('This track has no readable, unambiguous local file.');
        let file;
        try { file = await track.file.handle.getFile(); }
        catch { throw new Error('The local file is unavailable. Reconnect the drive and refresh.'); }
        if (file.size !== track.file.size || file.lastModified !== track.file.modified) {
            throw new Error('The file changed since the scan. Refresh the folder before opening it.');
        }
        const bytes = new Uint8Array(await file.slice(0, 512).arrayBuffer());
        const text = new TextDecoder('ascii').decode(bytes);
        if (!text.startsWith('OggS') || !text.includes('OpusHead')) throw new Error('This file is not recognized as Ogg/Opus audio.');
        return file.asBlob ? await file.asBlob() : file;
    }
}

if (typeof module !== 'undefined') module.exports = { Tb2ContentReader };
