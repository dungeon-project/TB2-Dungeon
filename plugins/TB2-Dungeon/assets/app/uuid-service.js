/** One UUID owner for manual entry, archives, hardware and optional scanners. */
class DungeonUuidService {
    constructor(context) {
        this.context = context;
        this.serialNumberKey = 'tonie_uuid_serial_number_v1';
        this.revision = 0;
        this.value = this.normalizeSerialNumberInput(localStorage.getItem(this.serialNumberKey));
    }

    /** Preserve the established normalization and storage format. */
    normalizeSerialNumberInput(value) {
        return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 16);
    }
    get scanner() { return this.context.provider('tile-cracker-pane'); }
    get available() { return true; }
    get currentInput() { return this.value; }
    /** Without the scanner, only the current managed image's saved box key is usable. */
    get normalizedValue() {
        if (this.scanner) return this.value;
        const managed = this.context.manager?.imageManager?.loadedArchiveImage();
        const identity = this.context.identity?.imageState;
        return managed && identity?.image === this.context.image.current && !identity.error &&
            identity.box?.id === managed.boxId && identity.box.uuid === this.value ? this.value : '';
    }
    get persistedValue() { return localStorage.getItem(this.serialNumberKey) || ''; }
    get saveDisabled() { return !/^500100[0-9A-F]{10}$/.test(this.value); }
    get searchBusy() { return !!(this.scanner?._searchTask || this.scanner?._resetting || this.scanner?.app?.running); }
    get searchReport() {
        const report = this.scanner?.successfulSearch;
        return report?.uuid === this.value ? report : null;
    }
    get storageKeys() {
        return [this.serialNumberKey, ...['checkpointKey', 'algorithmKey', 'batchSizeKey', 'workgroupSizeKey', 'tuningKey']
            .map(name => this.scanner?.[name]).filter(Boolean)];
    }

    /** Source actions advance the revision even when the resulting key is unchanged. */
    setSerialNumberField(value, persist) {
        const normalized = this.normalizeSerialNumberInput(value);
        const previous = this.value;
        this.value = normalized;
        if (persist) {
            this.revision++;
            if (normalized) localStorage.setItem(this.serialNumberKey, normalized);
            else localStorage.removeItem(this.serialNumberKey);
            if (previous !== normalized) this.context.manager?.broadcastUpdate();
            this.context.emit('uuid', normalized);
        }
        return normalized;
    }

    /** An absent scanner has no task or checkpoint lifecycle to cancel. */
    resetSearch(...args) {
        if (this.scanner) return this.scanner.resetSearch(...args);
        if (args[0] !== false) this.setSerialNumberField('', true);
        return Promise.resolve();
    }
    refreshUuidSaveButton() { this.scanner?.refreshUuidSaveButton(); }
    /** Notify an optional scanner after an explicit crypto action needs a missing UUID. */
    requestAttention() { this.scanner?.requestAttention?.(); }
    update() { this.scanner?.update(); }
    isEnabled() { return this.scanner?.isEnabled() || false; }
    enable() { this.scanner?.enable(); }
    disable() { this.scanner?.disable(); }
    updateStyles() { this.scanner?.updateStyles(); }
}
