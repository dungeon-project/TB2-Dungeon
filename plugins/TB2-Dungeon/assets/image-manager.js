/* Complete image archives. Storage is supplied by the same-origin TC plugin. */
'use strict';
const ArchiveBoxIdentity = typeof module !== 'undefined' ? require('./box-identity.js').BoxIdentity : window.BoxIdentity;
class ImageArchive {
    static SIZE = 16 * 1024 * 1024;
    static DEFAULT_LIMIT = 1024 * 1024 * 1024;
    static ROOT = 'firmware';
    // TC interprets .json as audio metadata; keep our JSON in a separate extension.
    static CONFIG = 'firmware/manager-settings.cfmeta';
    static SUFFIX = '.cfmeta';
    static META_LIMIT = 32768;
    /**
     * @param {object} storage Same-origin archive adapter: list/read/write/move/remove/mkdir.
     * @param {Function} inspect Read-only firmware inspection returning firmware labels and warning.
     */
    constructor(storage, inspect = async () => ({ firmware: [], warning: 'Firmware could not be identified.' })) {
        this.storage = storage;
        this.inspect = inspect;
        this.busy = false;
        this.entries = [];
        this.boxProfiles = [];
        this.files = [];
        this.limit = ImageArchive.DEFAULT_LIMIT;
        this.used = 0;
        this.progress = () => {};
    }
    static bytes(value) { return new TextEncoder().encode(JSON.stringify(value, null, 2)); }
    static same(leftBytes, rightBytes) {
        return leftBytes.length === rightBytes.length && leftBytes.every((byte, index) => byte === rightBytes[index]);
    }
    static async hash(bytes) {
        return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2, '0')).join('');
    }
    static slug(value) { return String(value).normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24).toLowerCase() || 'image'; }
    static path(value) {
        if (typeof value !== 'string' || value.length > 220 || !value.startsWith('firmware/') ||
            value.split('/').some(part => !part || part === '.' || part === '..' || /[\\\x00-\x1f]/.test(part))) throw new Error('Invalid archive path.');
        return value;
    }
    static parse(bytes) {
        if (bytes.length > this.META_LIMIT) throw new Error('Image details are too large.');
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    }
    static metadata(value) {
        if (!value || value.format !== 1 || typeof value.id !== 'string' || !/^[a-z0-9-]{1,50}$/i.test(value.id) ||
            value.size !== this.SIZE || !/^[a-f0-9]{64}$/.test(value.sha256) || typeof value.protected !== 'boolean' ||
            !['Original','Modified','Unknown'].includes(value.type) || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 ||
            typeof value.notes !== 'string' || value.notes.length > 2000 || typeof value.versionNote !== 'string' || value.versionNote.length > 100 ||
            !value.box || typeof value.box.id !== 'string' || value.box.id.length > 80 || typeof value.box.name !== 'string' || value.box.name.length > 100 ||
            !Array.isArray(value.firmware) || value.firmware.some(item => typeof item !== 'string' || item.length > 100) ||
            typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) throw new Error('Invalid image details. Refresh and review this entry.');
        return value;
    }
    static details(input) {
        const fields = { name: String(input.name || '').trim(), type: input.type, notes: String(input.notes || ''),
            versionNote: String(input.versionNote || ''), protected: !!input.protected,
            box: { id: String(input.box?.id || ''), name: String(input.box?.name || 'Unassigned') } };
        if (!fields.name || fields.name.length > 100 || fields.notes.length > 2000 || fields.versionNote.length > 100 ||
            fields.box.id.length > 80 || !fields.box.name.trim() || fields.box.name.length > 100 || !['Original','Modified','Unknown'].includes(fields.type)) throw new Error('Enter a name, box and valid image details.');
        return fields;
    }
    /** Reuse a stable box directory even when its display name has changed. */
    async folder(box) {
        if (!box.id) return 'firmware/unassigned';
        const profile = this.boxProfiles.find(item => item.value.id === box.id);
        if (profile) return profile.path.slice(0, profile.path.lastIndexOf('/'));
        const existing = this.entries.find(entry => entry.meta?.box.id === box.id && entry.path.split('/').length === 3);
        if (existing) return existing.path.slice(0, existing.path.lastIndexOf('/'));
        return `firmware/${ImageArchive.slug(box.name)}--${(await ImageArchive.hash(new TextEncoder().encode(box.id))).slice(0, 12)}`;
    }
    checkpoint() { if (this.signal?.aborted) throw new Error('Operation cancelled.'); }
    /** Own the operation state until completion, including verified rollback of new files. */
    async run(action, options = {}) {
        if (this.busy) throw new Error('Another image archive operation is running.');
        this.busy = true;
        this.signal = options.signal;
        this.progress = options.progress || (() => {});
        this.touched = [];
        this.created = new Map();
        this.cleanNewFiles = !!options.cleanNewFiles;
        try {
            this.checkpoint();
            const result = await action();
            this.checkpoint();
            return result;
        }
        catch (error) {
            // Roll back only new files whose bytes still match this operation; retain uncertain writes.
            if (this.cleanNewFiles) for (const [path, expected] of [...this.created].reverse()) {
                try {
                    if (ImageArchive.same(await this.storage.read(path, expected.length), expected)) {
                        await this.storage.remove(path);
                        this.touched = this.touched.filter(item => item !== path);
                    }
                } catch { /* A lost device or changed file is reported below; never guess ownership. */ }
            }
            const suffix = this.touched.length ? ` Review these archive files: ${[...new Set(this.touched)].join(', ')}. Refresh before retrying.` : '';
            throw new Error(error.message + suffix, { cause: error });
        } finally {
            this.busy = false;
            this.signal = null;
        }
    }
    /** Read the archive only; unrelated TC content and box overlays are never enumerated. */
    async refresh() {
        const files = [], visit = async (folder, depth = 0) => {
            if (depth > 6) throw new Error('Archive folder nesting is too deep.');
            const items = await this.storage.list(folder);
            for (const item of items) {
                const path = ImageArchive.path(`${folder}/${item.name}`);
                if (item.isDir) await visit(path, depth + 1); else files.push({ ...item, path });
            }
        };
        await visit(ImageArchive.ROOT);
        const entries = [], config = files.find(file => file.path === ImageArchive.CONFIG);
        let limit = ImageArchive.DEFAULT_LIMIT;
        if (config) {
            const parsed = ImageArchive.parse(await this.storage.read(config.path, ImageArchive.META_LIMIT));
            if (parsed.format !== 1 || !Number.isSafeInteger(parsed.limitBytes) || parsed.limitBytes < ImageArchive.SIZE) throw new Error('Invalid archive size limit.');
            limit = parsed.limitBytes;
        }
        for (const file of files.filter(file => /\.bin$/i.test(file.path))) {
            const entry = { ...file, metaPath: file.path.replace(/\.bin$/i, ImageArchive.SUFFIX), meta: null, raw: null };
            if (files.some(item => item.path === entry.metaPath)) {
                const bytes = await this.storage.read(entry.metaPath, ImageArchive.META_LIMIT);
                try { entry.meta = ImageArchive.metadata(ImageArchive.parse(bytes)); entry.raw = bytes; }
                catch { entry.warning = 'Unmanaged: invalid image details. Review and adopt before deleting.'; }
            }
            entries.push(entry);
        }
        // Profiles are independent of images; invalid records block UUID use rather than falling back.
        const profiles = [];
        for (const file of files.filter(file => file.name.toLowerCase() === 'box.cfmeta')) {
            const raw = await this.storage.read(file.path, ImageArchive.META_LIMIT);
            profiles.push({ path: file.path, raw, value: ImageArchive.boxProfile(ImageArchive.parse(raw)) });
        }
        if (new Set(profiles.map(item => item.value.id)).size !== profiles.length ||
            new Set(profiles.map(item => item.value.tcId).filter(Boolean)).size !== profiles.filter(item => item.value.tcId).length)
            throw new Error('Duplicate box profiles. Resolve the archive conflict before loading a UUID.');
        // Ambiguous identifiers stay editable; only automatic matching rejects them.
        // Orphan sidecars retain restored descriptions when their binary was not backed up.
        for (const file of files.filter(file => file.path.endsWith(ImageArchive.SUFFIX) &&
            file.path !== ImageArchive.CONFIG && file.name.toLowerCase() !== 'box.cfmeta' &&
            !entries.some(entry => entry.metaPath === file.path))) {
            const raw = await this.storage.read(file.path, ImageArchive.META_LIMIT);
            try {
                const meta = ImageArchive.metadata(ImageArchive.parse(raw));
                entries.push({ path: file.path.replace(/\.cfmeta$/, '.bin'), metaPath: file.path,
                    raw, meta, missing: true, size: meta.size, warning: 'Image file missing' });
            } catch { /* Unrecognized sidecars remain untouched and are not managed images. */ }
        }
        this.boxProfiles = profiles;
        this.files = files; this.entries = entries; this.limit = limit;
        this.used = files.reduce((sum, file) => sum + file.size, 0);
        return entries;
    }
    /** A box UUID is archive metadata, never a firmware edit or a device identity proof. */
    static boxProfile(value) {
        if (!value || value.format !== 1 || typeof value.id !== 'string' || !value.id || value.id.length > 80 ||
            typeof value.name !== 'string' || !value.name.trim() || value.name.length > 100 ||
            typeof value.uuid !== 'string' || (value.uuid && !/^500100[0-9A-F]{10}$/.test(value.uuid)) ||
            typeof value.tcId !== 'string' || (value.tcId && !value.tcId.startsWith('tc:')) || value.tcId.length > 80)
            throw new Error('Invalid box details. Review the box profile before loading its UUID.');
        if (value.flashChipId !== undefined && value.flashChipId !== '' &&
            !ImageArchive.validChipId(value.flashChipId)) throw new Error('Invalid flash chip ID in box details.');
        if (value.boxSerialNumber !== undefined && ArchiveBoxIdentity.serial(value.boxSerialNumber) !== value.boxSerialNumber)
            throw new Error('Box serial number must not contain surrounding whitespace.');
        if (value.uuidSearch !== undefined) {
            const records = typeof CoreFlasherUuidRecord !== 'undefined' ? CoreFlasherUuidRecord : require('./uuid-search-record.js');
            records.validateReport(value.uuidSearch);
        }
        return value;
    }
    /** Flash identity is distinct from the MCU UUID and has no manufacturer prefix. */
    static validChipId(value) {
        return typeof value === 'string' && /^[0-9A-F]{16}$/.test(value) &&
            value !== '0000000000000000' && value !== 'FFFFFFFFFFFFFFFF';
    }

    /** Fresh reads prevent a cached UUID from accompanying a newly loaded image. */
    async boxUuid(boxId) {
        await this.refresh();
        return boxId ? ArchiveBoxIdentity.resolve(this.boxProfiles, {boxId})?.uuid || '' : '';
    }

    /** Reuse checked metadata publication and retain the stable directory across renames. */
    async saveBox(value, expected = null, options = {}) {
        const profile = ImageArchive.boxProfile({ ...value, format: 1 });
        return this.run(async () => {
            await this.ensureRoot();
            await this.refresh();
            const current = this.boxProfiles.find(item => item.value.id === profile.id);
            if (!!current !== !!expected || (current && !ImageArchive.same(current.raw, expected.raw)))
                throw new Error('Box details changed elsewhere. Refresh before saving.');
            if (profile.tcId && this.boxProfiles.some(item => item.value.id !== profile.id && item.value.tcId === profile.tcId))
                throw new Error('This TeddyCloud box is already linked to another box profile.');
            if (profile.flashChipId && this.boxProfiles.some(item => item.value.id !== profile.id && item.value.flashChipId === profile.flashChipId))
                throw new Error('This flash chip is already assigned to another box. Remove that assignment first.');
            for (const field of ['uuid', 'boxSerialNumber']) if (profile[field] &&
                this.boxProfiles.some(item => item.value.id !== profile.id && item.value[field] === profile[field]))
                throw new Error(`This ${field} is already assigned to another box. Remove that assignment first.`);
            const path = current?.path || `${await this.folder(profile)}/box.cfmeta`;
            const bytes = ImageArchive.bytes(profile);
            await this.quota(bytes.length);
            await this.storage.mkdir(path.slice(0, path.lastIndexOf('/')));
            if (current) await this.replace(path, bytes, current.raw);
            else await this.checkedWrite(path, bytes);
            await this.refresh();
            return this.boxProfiles.find(item => item.value.id === profile.id);
        }, options);
    }

    async ensureRoot() { await this.storage.mkdir(ImageArchive.ROOT); }
    async absent(path) {
        const parent = path.slice(0, path.lastIndexOf('/')), name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
        if ((await this.storage.list(parent)).some(entry => entry.name.toLowerCase() === name)) throw new Error('Archive filename already exists. Nothing was overwritten.');
    }
    async fresh(entry) {
        if (!entry.meta || !entry.raw) throw new Error('Review and adopt this unmanaged image first.');
        const bytes = await this.storage.read(entry.metaPath, ImageArchive.META_LIMIT);
        const metadata = ImageArchive.metadata(ImageArchive.parse(bytes));
        if (!ImageArchive.same(bytes, entry.raw)) throw new Error('Image details changed elsewhere. Refresh before continuing.');
        return metadata;
    }
    async verified(entry) {
        const meta = await this.fresh(entry);
        const bytes = await this.storage.read(entry.path, ImageArchive.SIZE);
        if (bytes.length !== ImageArchive.SIZE || await ImageArchive.hash(bytes) !== meta.sha256) throw new Error('Image checksum does not match. Loading or downloading was stopped.');
        return bytes;
    }
    async quota(extra) {
        await this.refresh(); this.checkpoint();
        if (this.used + extra > this.limit) throw new Error('Archive size limit reached. Delete an unprotected image or increase the limit.');
    }
    /** Register ownership before writing; failed readback keeps uncertain bytes for review. */
    async checkedWrite(path, bytes) {
        this.checkpoint();
        await this.absent(path);
        this.touched.push(path);
        this.created.set(path, bytes);
        await this.storage.write(path, bytes, this.progress);
        const actual = await this.storage.read(path, bytes.length);
        if (!ImageArchive.same(bytes, actual)) throw new Error('Uploaded file failed readback verification.');
        this.checkpoint();
    }
    async move(source, target) {
        this.checkpoint(); await this.absent(target); this.touched.push(source, target);
        await this.storage.move(source, target);
        if (this.created.has(source)) { this.created.set(target, this.created.get(source)); this.created.delete(source); }
        this.touched = this.touched.filter(path => path !== source);
    }
    /** Publish binary first, metadata last. No existing binary is ever replaced. */
    async save(bytes, input, options = {}) {
        return this.run(async () => {
            if (!(bytes instanceof Uint8Array) || bytes.length !== ImageArchive.SIZE) throw new Error('Select a complete 16 MiB image.');
            const details = ImageArchive.details(input);
            await this.ensureRoot();
            await this.refresh();
            const sha256 = await ImageArchive.hash(bytes);
            const duplicate = this.entries.find(entry => entry.meta?.sha256 === sha256 && entry.meta.box.id === details.box.id);
            if (duplicate) { await this.verified(duplicate); return { entry: duplicate, duplicate: true }; }
            // Inspect only after duplicate verification; an existing match is returned unchanged.
            this.progress('Inspecting firmware…');
            const facts = await this.inspect(bytes);
            const id = crypto.randomUUID();
            const createdAt = new Date().toISOString();
            const meta = ImageArchive.metadata({ format: 1, id, ...details, firmware: facts.firmware, createdAt, size: bytes.length, sha256 });
            const metadataBytes = ImageArchive.bytes(meta);
            const folder = await this.folder(details.box);
            await this.quota(bytes.length + metadataBytes.length);
            await this.storage.mkdir(folder);
            const stem = `${folder}/${createdAt.slice(0, 16).replace(/[-:T]/g, '')}_${ImageArchive.slug(details.name)}--${id.slice(0, 8)}`;
            const binary = stem + '.bin', metaPath = stem + ImageArchive.SUFFIX, temporary = stem + '.upload';
            // Stage and read back the binary before publishing the archive entry.
            this.progress('Uploading image…');
            await this.checkedWrite(temporary, bytes);
            await this.quota(metadataBytes.length); // Concurrent clients may have consumed the remaining budget.
            await this.move(temporary, binary);
            this.progress('Saving image details…');
            await this.checkedWrite(metaPath, metadataBytes);
            await this.refresh();
            const entry = this.entries.find(archiveEntry => archiveEntry.path === binary);
            await this.verified(entry);
            return { entry, warning: facts.warning || '' };
        }, { ...options, cleanNewFiles: true });
    }
    /** Metadata replacement keeps a recovery copy until the new bytes have been verified. */
    async replace(path, bytes, expected) {
        const temporary = path + '.' + crypto.randomUUID().slice(0, 8) + '.new', previous = temporary + '.previous';
        await this.checkedWrite(temporary, bytes);
        const current = await this.storage.read(path, ImageArchive.META_LIMIT);
        if (!ImageArchive.same(current, expected)) throw new Error('Details changed elsewhere. Refresh before continuing.');
        await this.move(path, previous); await this.move(temporary, path);
        if (!ImageArchive.same(await this.storage.read(path, ImageArchive.META_LIMIT), bytes)) throw new Error('Saved details failed verification.');
        this.checkpoint();
        if (!ImageArchive.same(await this.storage.read(previous, ImageArchive.META_LIMIT), expected)) throw new Error('Recovery details changed. They were retained.');
        await this.storage.remove(previous);
    }
    async update(entry, input, options = {}) {
        return this.run(async () => {
            const before = await this.fresh(entry), details = ImageArchive.details(input);
            if (before.protected && !details.protected && !options.confirmedUnprotect) throw new Error('Confirm removing image protection first.');
            if (entry.missing) {
                await this.absent(entry.path);
                const bytes = ImageArchive.bytes(ImageArchive.metadata({...before, ...details}));
                await this.quota(bytes.length);
                await this.replace(entry.metaPath, bytes, entry.raw);
                await this.refresh();
                return this.entries.find(item => item.metaPath === entry.metaPath);
            }
            const bytes = await this.verified(entry), folder = await this.folder(details.box);
            const next = { ...before, ...details }, encoded = ImageArchive.bytes(next);
            // Protection must remain removable even when an administrator reduced the limit.
            if (before.protected && !details.protected) { await this.refresh(); this.checkpoint(); }
            else await this.quota(encoded.length);
            await this.fresh(entry);
            if (entry.path.slice(0, entry.path.lastIndexOf('/')) !== folder) {
                await this.storage.mkdir(folder);
                const target = `${folder}/${entry.path.split('/').pop()}`, metaPath = target.replace(/\.bin$/i, ImageArchive.SUFFIX);
                await this.absent(metaPath); await this.move(entry.path, target);
                if (!ImageArchive.same(await this.storage.read(target, ImageArchive.SIZE), bytes)) throw new Error('Moved image failed verification.');
                await this.checkedWrite(metaPath, encoded); await this.fresh(entry); this.checkpoint();
                await this.storage.remove(entry.metaPath);
                await this.refresh(); return this.entries.find(e => e.path === target);
            }
            await this.replace(entry.metaPath, encoded, entry.raw); await this.refresh();
            return this.entries.find(e => e.path === entry.path);
        }, options);
    }
    async adopt(entry, input, options = {}) {
        return this.run(async () => {
            const bytes = await this.storage.read(entry.path, ImageArchive.SIZE);
            if (bytes.length !== ImageArchive.SIZE) throw new Error('Only complete 16 MiB images can be adopted.');
            const listing = await this.storage.list(entry.path.slice(0, entry.path.lastIndexOf('/')));
            const hasSidecar = listing.some(file => file.name === entry.metaPath.split('/').pop());
            const invalidBytes = hasSidecar ? await this.storage.read(entry.metaPath, ImageArchive.META_LIMIT) : null;
            if (invalidBytes) {
                let valid = false; try { ImageArchive.metadata(ImageArchive.parse(invalidBytes)); valid = true; } catch { /* Preserve invalid bytes below. */ }
                if (valid) throw new Error('This image was adopted elsewhere. Refresh first.');
            }
            const details = ImageArchive.details(input), facts = await this.inspect(bytes);
            if (invalidBytes) details.protected = true;
            const meta = ImageArchive.metadata({ format: 1, id: crypto.randomUUID(), ...details, firmware: facts.firmware,
                createdAt: new Date().toISOString(), size: bytes.length, sha256: await ImageArchive.hash(bytes) });
            const encoded = ImageArchive.bytes(meta); await this.quota(encoded.length);
            const folder = await this.folder(details.box), target = `${folder}/${entry.path.split('/').pop()}`;
            const metaPath = target.replace(/\.bin$/i, ImageArchive.SUFFIX);
            await this.storage.mkdir(folder);
            if (target !== entry.path) { await this.absent(target); await this.absent(metaPath); }
            if (!ImageArchive.same(await this.storage.read(entry.path, ImageArchive.SIZE), bytes)) throw new Error('Image changed during adoption.');
            if (invalidBytes) {
                if (!ImageArchive.same(await this.storage.read(entry.metaPath, ImageArchive.META_LIMIT), invalidBytes)) throw new Error('Image details changed during adoption.');
                await this.move(entry.metaPath, entry.metaPath + '.' + crypto.randomUUID().slice(0, 8) + '.recovered');
            }
            if (target !== entry.path) await this.move(entry.path, target);
            await this.checkedWrite(metaPath, encoded); await this.refresh();
            const adopted = this.entries.find(e => e.path === target); await this.verified(adopted);
            return adopted;
        }, options);
    }
    async delete(entry, options = {}) {
        return this.run(async () => {
            if (entry.missing) {
                const meta = await this.fresh(entry);
                if (meta.protected) throw new Error('Remove image protection before deleting.');
                await this.absent(entry.path);
                await this.storage.remove(entry.metaPath);
                await this.refresh();
                if (this.files.some(file => file.path === entry.metaPath)) throw new Error('Image details remain.');
                return;
            }
            await this.verified(entry); const meta = await this.fresh(entry);
            if (meta.protected) throw new Error('Remove image protection before deleting.');
            this.checkpoint(); this.touched.push(entry.path, entry.metaPath);
            await this.storage.remove(entry.path);
            // Retain metadata if someone changed it after the first deletion.
            await this.fresh(entry); this.checkpoint(); await this.storage.remove(entry.metaPath);
            const remaining = await this.storage.list(entry.path.slice(0, entry.path.lastIndexOf('/')));
            if (remaining.some(file => [entry.path.split('/').pop(), entry.metaPath.split('/').pop()].includes(file.name))) throw new Error('Some image files remain.');
            await this.refresh();
        }, options);
    }
    async setLimit(limitBytes, options = {}) {
        return this.run(async () => {
            if (!Number.isSafeInteger(limitBytes) || limitBytes < ImageArchive.SIZE) throw new Error('Set a limit of at least 16 MiB.');
            await this.ensureRoot(); await this.refresh();
            const encoded = ImageArchive.bytes({ format: 1, limitBytes });
            if (this.files.some(file => file.path === ImageArchive.CONFIG)) {
                const previous = await this.storage.read(ImageArchive.CONFIG, ImageArchive.META_LIMIT);
                await this.replace(ImageArchive.CONFIG, encoded, previous);
            } else await this.checkedWrite(ImageArchive.CONFIG, encoded);
            await this.refresh();
        }, options);
    }
}
if (typeof module !== 'undefined') module.exports = { ImageArchive };
if (typeof window !== 'undefined') window.ImageArchive = ImageArchive;
