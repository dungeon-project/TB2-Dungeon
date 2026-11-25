/** Public catalog only: collection IDs are matched in memory and are never sent to the server. */
class Tb2TonieCatalog {
    static URL = 'https://raw.githubusercontent.com/toniebox-reverse-engineering/tonies-json/release/tonies.json';
    static MAX_BYTES = 16 * 1024 * 1024;
    static TIMEOUT_MS = 20000;
    constructor(baseUrl, storage = globalThis.caches, fetcher = globalThis.fetch.bind(globalThis)) {
        this.cacheName = 'core-flasher-teddybench-catalog-v1:' + new URL('.', baseUrl).pathname;
        this.storage = storage; this.fetcher = fetcher; this.index = new Map();
        this.loaded = false; this.pending = null; this.generation = 0; this.abort = null;
    }
    static id(value) { return typeof value === 'string' ? value.trim() : Number.isSafeInteger(value) ? String(value) : ''; }

    /** Duplicate models remain ambiguous, even when one entry has a missing title. */
    static parse(text) {
        const rows = JSON.parse(text);
        if (!Array.isArray(rows) || !rows.length) throw new Error('Catalog is not a valid article list.');
        const index = new Map();
        for (const row of rows) {
            if (!row || typeof row !== 'object') continue;
            const id = this.id(row.model); if (!id) continue;
            const title = typeof row.title === 'string' ? row.title.trim() : '';
            index.set(id, index.has(id) ? null : title && title.length <= 300 && !/[\x00-\x1f]|:\/\//.test(title) ? title : null);
        }
        if (!index.size) throw new Error('Catalog contains no article models.');
        return index;
    }

    /** Apply the same bounded read to cached and network responses. */
    static async responseText(response) {
        if (!response.ok || !response.body) throw new Error('Catalog download failed.');
        const reader = response.body.getReader(), chunks = []; let size = 0;
        try {
            while (true) {
                const next = await reader.read(); if (next.done) break;
                size += next.value.byteLength;
                if (size > this.MAX_BYTES) throw new Error('Catalog exceeds the supported size.');
                chunks.push(next.value);
            }
            return await new Blob(chunks).text();
        } catch (error) { await reader.cancel().catch(() => {}); throw error; }
        finally { reader.releaseLock(); }
    }

    /** A cached lookup never initiates a network request. */
    readCached() {
        if (this.pending) return this.pending;
        const generation = this.generation;
        this.pending = (async () => {
            await Promise.resolve(); // Publish the pending promise before any synchronous early return.
            try {
                if (!this.storage || !(await this.storage.keys()).includes(this.cacheName)) return 'Catalog not loaded.';
                const cache = await this.storage.open(this.cacheName), response = await cache.match(Tb2TonieCatalog.URL);
                if (!response) return 'Catalog not loaded.';
                const index = Tb2TonieCatalog.parse(await Tb2TonieCatalog.responseText(response));
                if (generation === this.generation) { this.index = index; this.loaded = true; }
                return 'Cached catalog ready.';
            } catch { return 'Cached catalog unavailable. Load the catalog to try again.'; }
            finally { this.pending = null; }
        })();
        return this.pending;
    }

    /** Only an explicit button click downloads; failed updates retain the last valid catalog. */
    update() {
        if (this.pending) return this.pending;
        const generation = this.generation, abort = new AbortController(); this.abort = abort;
        this.pending = (async () => {
            const timer = setTimeout(() => abort.abort(), Tb2TonieCatalog.TIMEOUT_MS);
            try {
                const response = await this.fetcher(Tb2TonieCatalog.URL, { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', signal: abort.signal });
                const text = await Tb2TonieCatalog.responseText(response), index = Tb2TonieCatalog.parse(text);
                if (generation !== this.generation) return 'Catalog loading cancelled.';
                let cached = false;
                try {
                    if (this.storage) {
                        const cache = await this.storage.open(this.cacheName);
                        await cache.put(Tb2TonieCatalog.URL, new Response(text, { headers: { 'Content-Type': 'application/json' } }));
                        cached = true;
                    }
                } catch { /* Keep usable public metadata in memory when persistent storage is unavailable. */ }
                if (generation === this.generation) { this.index = index; this.loaded = true; }
                return cached ? 'Catalog ready and cached locally.' : 'Catalog ready for this session only; browser storage is unavailable.';
            } catch { return this.loaded ? 'Catalog update failed. Keeping the previous catalog.' : 'Catalog could not be loaded. Existing collection names are unchanged.'; }
            finally { clearTimeout(timer); this.abort = null; this.pending = null; }
        })();
        return this.pending;
    }

    /** Await in-flight cache.put before deleting, so late downloads cannot undo an app reset. */
    async clear() {
        ++this.generation; this.abort?.abort();
        await Promise.allSettled([this.pending]);
        this.index.clear(); this.loaded = false;
        if (this.storage) await this.storage.delete(this.cacheName);
    }
    apply(collections) {
        for (const collection of collections) collection.title = this.index.get(Tb2TonieCatalog.id(collection.salesId)) || collection.baseTitle || collection.title;
    }
}

if (typeof module !== 'undefined') module.exports = { Tb2TonieCatalog };
