/** Buffered offline-mode control. The image is the only source of truth. */
class OfflineModeSettings {
    static KEY = 'app/offline_mode';
    static supported(image) {
        if (!CoreFlasherDumpUi.complete(image) || image.size !== FirmwareImage.SIZE) return false;
        try { return WifiImage.version(image) !== '0.40.8'; }
        catch { return false; } // An unknown primary header is not a compatibility claim.
    }

    /** Validate every record before choosing the latest one; never patch raw dump matches. */
    static inspect(bytes) {
        let offset = 0, valueOffset = -1;
        const decoder = new TextDecoder('utf-8', { fatal: true });
        while (offset < bytes.length) {
            if (offset + 2 > bytes.length) throw new Error('Settings contain a truncated record.');
            const start = offset + 2, end = start + (bytes[offset] | bytes[offset + 1] << 8);
            if (end > bytes.length) throw new Error('Settings contain a truncated record.');
            const separator = bytes.indexOf(0x3d, start);
            if (separator < start || separator >= end || separator === start) throw new Error('Settings contain an invalid record.');
            const key = decoder.decode(bytes.subarray(start, separator));
            if (key === this.KEY) {
                if (end - separator - 1 !== 1 || ![0, 1].includes(bytes[separator + 1])) throw new Error('Offline mode has an unsupported value.');
                valueOffset = separator + 1;
            }
            offset = end;
        }
        return valueOffset < 0 ? null : { value: bytes[valueOffset] === 1, valueOffset };
    }
    static patch(bytes, enabled) {
        if (typeof enabled !== 'boolean') throw new Error('Invalid offline-mode selection.');
        const setting = this.inspect(bytes);
        if (!setting) throw new Error('Offline mode is not configured in this image.');
        const result = bytes.slice(); result[setting.valueOffset] = enabled ? 1 : 0;
        return result;
    }

    /** Stage on a private snapshot, read back and recheck live permission before publishing. */
    static async apply(image, original, enabled, current) {
        const writable = () => this.supported(image) && !image.readOnly && window.AppState.interfaceMode === 'rw-buffered' && current();
        if (!writable()) throw new Error('Working image changed or is read-only.');
        const desired = this.patch(original, enabled), baseline = image.subarray(0, image.size).slice();
        const staged = SparseImage.fromBuffer(baseline.slice()), parser = await WifiImage.parser(staged);
        const result = await parser.writeFileChecked('/settings', desired, original);
        if (!result?.success) throw new Error('Settings changed or could not be written.');
        const candidate = staged.subarray(0, staged.size).slice();
        const verifier = await WifiImage.parser(SparseImage.fromBuffer(candidate));
        if (!FirmwareImage.equal(await verifier.readFile('/settings'), desired)) throw new Error('Offline-mode readback failed.');
        if (!writable() || !FirmwareImage.equal(image.subarray(0, image.size), baseline)) throw new Error('Working image changed. Reload its offline-mode setting.');
        if (result.changed) image.writeBuffer = FirmwareImage.stage(image, candidate);
        return !!result.changed;
    }
}

/** Small footer controller; no preference storage and no hardware commands. */
class OfflineModeController {
    constructor(tile) {
        this.tile = tile;
        this.root = tile.element.querySelector('.js-offline-mode');
        this.toggle = this.root.querySelector('button');
        this.status = this.root.querySelector('[role="status"]');
        this.image = null; this.revision = -1; this.generation = 0;
        this.record = null; this.original = null; this.error = ''; this.loading = false; this.saving = false;
        this.toggle.addEventListener('click', event => { event.stopPropagation(); this.apply(); });
        this.timer = setInterval(() => this.update(), 500);
        this.update();
    }
    current(image = this.image, revision = this.revision) {
        return image === window.interface && revision === Number(window.AppState.interfaceRevision || 0);
    }
    blocked() {
        return CoreFlasherDumpUi.busy() || !!this.tile.tileManager?.tiles.some(tile =>
            tile.operationRunning || tile.packageBusy || tile._busy || tile.loading || tile._isOpening);
    }
    writable() { return !this.image?.readOnly && window.AppState.interfaceMode === 'rw-buffered'; }

    /** Invalidate immediately on source changes; old asynchronous results cannot revive a toggle. */
    update() {
        if (this.saving) { this.render(); return; }
        const image = window.interface, revision = Number(window.AppState.interfaceRevision || 0);
        if (!this.current(image, this.revision) || this.image !== image) {
            ++this.generation; this.loading = false; this.record = this.original = null; this.error = '';
            this.image = image; this.revision = revision; this.loaded = false;
        }
        if (!OfflineModeSettings.supported(image)) { this.root.hidden = true; return; }
        if (!this.loaded && !this.loading && !this.blocked()) this.load();
        this.render();
    }
    render() {
        this.root.hidden = !this.record && !this.error;
        this.toggle.hidden = !!this.error || !this.record;
        this.toggle.disabled = this.saving || this.loading || this.blocked() || !this.current() || !this.writable();
        this.toggle.setAttribute('aria-checked', String(!!this.record?.value));
        this.toggle.textContent = this.record?.value ? 'On' : 'Off';
        this.status.textContent = this.error || (this.saving ? 'Updating working image…' :
            !this.writable() ? 'Enable Read / Write to change this setting.' : '');
    }
    async load() {
        const image = this.image, revision = this.revision, generation = ++this.generation;
        this.loading = true;
        try {
            const parser = await WifiImage.parser(image), bytes = await parser.readFile('/settings');
            const record = OfflineModeSettings.inspect(bytes);
            if (!this.current(image, revision) || generation !== this.generation) return;
            this.record = record; this.original = bytes.slice(); this.error = ''; this.loaded = true;
        } catch (error) {
            if (!this.current(image, revision) || generation !== this.generation) return;
            this.record = null; this.error = `Offline mode unavailable: ${error.message}`; this.loaded = true;
        } finally {
            if (generation === this.generation) { this.loading = false; this.render(); }
        }
    }

    /** One click is one transaction; existing operation gates cover export, flash and reset. */
    async apply() {
        if (this.saving || this.loading || this.blocked() || !this.record || !this.current() || !this.writable()) return;
        const image = this.image, revision = this.revision, generation = this.generation;
        let lease;
        this.saving = true;
        try {
            lease = this.tile.context.operations.beginImageEdit(this.tile, image);
            window.AppState.offlineModeBusy = true;
            this.tile._dumpUi.refresh(); this.render();
            const changed = await OfflineModeSettings.apply(image, this.original, !this.record.value,
                () => this.current(image, revision) && generation === this.generation);
            if (changed) {
                window.AppState.interfaceRevision = revision + 1;
                window.AppState.settingsSelectionRevision = Number(window.AppState.settingsSelectionRevision || 0) + 1;
                window.AppState.littlefsParser = null; window.AppState.littlefsParserSource = null;
                if (typeof LFS_IMAGE_PARSERS !== 'undefined') LFS_IMAGE_PARSERS.delete(image);
            }
            this.loaded = false;
        } catch (error) { this.error = `Offline mode was not changed: ${error.message}`; }
        finally {
            lease?.release();
            this.saving = false; window.AppState.offlineModeBusy = false;
            this.tile.tileManager?.broadcastUpdate(this.tile); this.tile._dumpUi.refresh(); this.update();
        }
    }
}
if (typeof module !== 'undefined') module.exports = { OfflineModeSettings, OfflineModeController };
