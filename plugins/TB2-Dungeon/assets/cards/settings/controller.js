/* Settings controller. Shared services are supplied by the card context. */
(() => {
// === Settings editor: UI state -> typed values -> records -> LittleFSParser ===

class CardController extends Tile {
    /** Report a local draft without transferring its ownership. */
    hasDraft() { return !!this._dirty; }

    /** Bind controls; row edits remain drafts until Apply to working image succeeds. @returns {void} */
    init() {
        this.element.querySelector('.js-enable-edit').addEventListener('click', () => this.context.image.setEditMode('rw-buffered'));
        this.gridEl = this.element.querySelector('.js-settings-grid');
        this.saveBtn = this.element.querySelector('.js-settings-save-btn');
        this.reloadBtn = this.element.querySelector('.js-settings-reload-btn');
        this.addBtn = this.element.querySelector('.js-settings-add-btn');
        this.errorEl = this.element.querySelector('.js-settings-error');
        this.statusEl = this.element.querySelector('.js-settings-status');
        this.records = [];
        this._latestByKey = new Map();
        this._editState = new Map();
        this._deletedKeys = new Set();
        this._addedRows = [];
        this._nextRowId = 0;
        this._dirty = false;
        this._busy = false;
        this._loaded = false;
        this._loadedImage = null;
        this._sourceBytes = null;
        this._loadToken = 0;
        this._hasUnseenSelection = false;
        this._seenSelectionRevision = Number(window.AppState.settingsSelectionRevision || 0);
        this._seenInterfaceRevision = Number(window.AppState.interfaceRevision || 0);
        for (const [button, action] of [
            [this.saveBtn, () => this.writeSettings()],
            [this.reloadBtn, () => { if (!this._dirty || window.confirm('Discard the Settings draft and reload?')) this.reloadFromFile(); }],
            [this.addBtn, () => this.addRow()]
        ]) {
            button.addEventListener('click', event => {
                event.stopPropagation();
                action();
            });
        }
        this.lifecycleSelect = this.element.querySelector('.js-settings-lifecycle');
        this.lifecycleSelect?.addEventListener('change', () => {
            if (!this._loaded || this._busy || window.interface?.readOnly || !this.lifecycleReadable()) return;
            const state = this._getSettingsState(FirmwareImage.LIFECYCLE_KEY);
            state.type = 'u8'; state.value = this.lifecycleSelect.value; state.touched = true;
            this._markSettingsDirty(); this.renderEditor();
        });
        this.update();
    }

    /**
     * Acknowledge attention state and focus this tile.
     * @returns {void}
     */
    focus() {
        super.focus();
        this._hasUnseenSelection = false;
        this._seenSelectionRevision = Number(window.AppState.settingsSelectionRevision || 0);
        this.updateStyles();
        // Opening Settings selects the logical file through the existing explorer state.
        this.context.filesystem?.selectSettingsForEditor(this).catch(error => {
            if (this.isFocused) this.showError(error.message || String(error));
        });
    }

    /**
     * Show the supplied failure message in the settings error panel.
     * @param {unknown} message
     * @returns {void}
     */
    showError(message) {
        if (!this.errorEl) {
            return;
        }
        this.errorEl.innerText = String(message || 'Unknown error');
        this.errorEl.classList.remove('hidden');
    }

    /**
     * Clear and hide the settings error panel.
     * @returns {void}
     */
    hideError() {
        if (!this.errorEl) {
            return;
        }
        this.errorEl.classList.add('hidden');
        this.errorEl.innerText = '';
    }

    /**
     * Check the file-manager selection against both supported settings paths.
     * @returns {boolean}
     */
    isSettingsSelected() {
        const selectedPath = String(window.AppState.fileManagerSelectedPath || '');
        return selectedPath === '/settings' || selectedPath === 'settings';
    }

    /** Preserve unsaved edits while tracking source changes. @returns {void} */
    update() {
        const image = window.interface;
        const selected = this.isSettingsSelected() || (this._loaded && this._loadedImage === image);
        const selectionRevision = Number(window.AppState.settingsSelectionRevision || 0);
        const imageRevision = Number(window.AppState.interfaceRevision || 0);
        if (!image || !selected) {
            if (this.enabled) this.disable();
            this._loadToken++;
            this._loaded = false;
            this._busy = false;
            this._loadedImage = null;
            this._sourceBytes = null;
            this.records = [];
            this._latestByKey = new Map();
            this._resetDrafts();
            this.gridEl.replaceChildren();
            this._hasUnseenSelection = false;
            this._seenSelectionRevision = selectionRevision;
            this._seenInterfaceRevision = imageRevision;
            this.statusEl.innerText = image ? 'Waiting for /settings.' : 'Load an image to edit its settings.';
            this._updateSettingsButtons();
            this.updateStyles();
            return;
        }
        if (!this.enabled) this.enable();
        if (this.isFocused) this._hasUnseenSelection = false;
        else if (selectionRevision > this._seenSelectionRevision) this._hasUnseenSelection = true;
        const changedImage = this._loadedImage !== null && this._loadedImage !== image;
        const changedRevision = imageRevision > this._seenInterfaceRevision;
        this._seenSelectionRevision = selectionRevision;
        this._seenInterfaceRevision = imageRevision;
        if (changedImage) {
            this._loadToken++;
            this._loaded = false;
            this._busy = false;
            this._resetDrafts();
        }
        if (!this._busy && (!this._loaded || (changedRevision && !this._dirty))) {
            this.reloadFromFile();
        } else if (changedRevision && this._dirty) {
            this.statusEl.innerText =
                'IMAGE_CHANGED: drafts retained; source checked before writing';
        }
        this._updateSettingsButtons();
        this.updateStyles();
    }

    /**
     * Evaluate this component's attention condition.
     * @returns {boolean}
     */
    isFlashing() {
        return this.enabled && !this.isFocused && this.isSettingsSelected()
            && this._hasUnseenSelection;
    }

    /**
     * Describe the current attention condition for diagnostic logging.
     * @returns {string}
     */
    getBlinkReason() {
        if (!this.isSettingsSelected()) {
            return '/settings not selected in file manager';
        }
        if (!this._hasUnseenSelection) {
            return 'settings tile already acknowledged';
        }
        return '/settings selected and awaiting focus';
    }

    // === Parser access ===

    /**
     * Reuse the current image parser, or initialize it at partition offset 0x820000.
     * @returns {Promise<LittleFSParser>}
     */
    async getParser() {
        if (!window.interface || typeof LittleFSParser === 'undefined') {
            throw new Error('No loaded interface image.');
        }
        if (window.AppState.littlefsParser
            && window.AppState.littlefsParserSource === window.interface) {
            return window.AppState.littlefsParser;
        }
        const parser = new LittleFSParser(window.interface, 0x820000,
            window.interface.size - 0x820000);
        await parser.initialize();
        window.AppState.littlefsParser = parser;
        window.AppState.littlefsParserSource = window.interface;
        return parser;
    }

    // === Binary settings codec ===

    /**
     * Decode length-prefixed key/value records, preserving order and duplicate keys.
     * Each header is uint16 little-endian; values remain opaque byte arrays.
     * @param {BinaryInput} buffer
     * @returns {SettingsRecord[]}
     */
    parseSettingsBuffer(buffer) {
        const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
        const records = [];
        let offset = 0;
        let index = 0;
        while (offset < bytes.length) {
            if (offset + 2 > bytes.length) {
                throw new Error(`Truncated settings header at 0x${offset.toString(16)}`);
            }
            const payloadLength = bytes[offset] | (bytes[offset + 1] << 8);
            const payloadStart = offset + 2;
            const payloadEnd = payloadStart + payloadLength;
            if (payloadEnd > bytes.length) {
                throw new Error(`Settings record overrun at 0x${offset.toString(16)}`);
            }
            const payload = bytes.slice(payloadStart, payloadEnd);
            const separatorIndex = payload.indexOf(0x3d);
            if (separatorIndex < 0) {
                throw new Error(`Missing '=' in settings record #${index}`);
            }
            const key = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
                payload.slice(0, separatorIndex));
            const valueBytes = payload.slice(separatorIndex + 1);
            records.push({ index, offset, len: payloadLength, key, valueBytes });
            offset = payloadEnd;
            index += 1;
        }
        return records;
    }

    /**
     * Encode one UTF-8 key and raw value with a uint16 little-endian payload length.
     * @param {unknown} key
     * @param {Uint8Array} valueBytes
     * @returns {Uint8Array}
     */
    encodeRecord(key, valueBytes) {
        const keyBytes = new TextEncoder().encode(String(key));
        const payload = new Uint8Array(keyBytes.length + 1 + valueBytes.length);
        payload.set(keyBytes, 0);
        payload[keyBytes.length] = 0x3d;
        payload.set(valueBytes, keyBytes.length + 1);
        const payloadLength = payload.length;
        if (payloadLength > 0xffff) {
            throw new Error(`Record too large: ${key}`);
        }
        const encodedRecord = new Uint8Array(2 + payloadLength);
        encodedRecord[0] = payloadLength & 0xff;
        encodedRecord[1] = (payloadLength >>> 8) & 0xff;
        encodedRecord.set(payload, 2);
        return encodedRecord;
    }

    /**
     * Serialize every record in input order without collapsing duplicate keys.
     * @param {SettingsRecord[]} records
     * @returns {Uint8Array}
     */
    serializeRecords(records) {
        const chunks = records.map((r) => this.encodeRecord(r.key, r.valueBytes));
        const totalLength = chunks.reduce((n, c) => n + c.length, 0);
        const serialized = new Uint8Array(totalLength);
        let outputOffset = 0;
        for (const chunk of chunks) {
            serialized.set(chunk, outputOffset);
            outputOffset += chunk.length;
        }
        return serialized;
    }

    /**
     * Format bytes as lowercase, space-separated hexadecimal pairs.
     * @param {Iterable<number>} bytes
     * @returns {string}
     */
    toHex(bytes) {
        return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    }

    /**
     * Decode hexadecimal pairs after removing whitespace; reject invalid input.
     * @param {unknown} text
     * @returns {Uint8Array}
     */
    fromHex(text) {
        const clean = String(text || '').replace(/\s+/g, '').toLowerCase();
        if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
            throw new Error('Invalid hex input');
        }
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i += 1) {
            out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    // === Typed editor representation ===

    /**
     * Apply the existing key-to-type rules; unknown keys remain hexadecimal.
     * @param {string} key
     * @returns {SettingsType}
     */
    inferTypeForKey(key) {
        if (key === 'app/error_reboot_count') {
            return 'u32le';
        }
        if (key === 'toniebox/lifecycle_state') {
            return 'u8';
        }
        if (key === 'app/first_time_enduser') {
            return 'u8';
        }
        if (key === 'toniebox/color') {
            return 'u8';
        }
        if (key === 'toniebox/age_mode') {
            return 'u8';
        }
        if (/^wifi\/profile\/\d+\/last_used$/.test(key)) {
            return 'u16le';
        }
        if (key.startsWith('toniebox/battery_config_version/')) {
            if (key.endsWith('/major')) {
                return 'u16le';
            }
            return 'u8';
        }
        if (key === 'mop/enabled' || key === 'mop/performed') {
            return 'booltf';
        }
        if (key === 'toniebox/id' ||
            key.startsWith('toniebox/hw_revision_') ||
            key === 'toniebox/lang_code') {
            return 'cstring';
        }
        if (key === 'wifi/region' || key.endsWith('/security')) {
            return 'ascii';
        }
        if (/^wifi\/profile\/\d+\/(ssid|psk)$/.test(key)) {
            return 'utf8';
        }
        return 'hex';
    }

    /**
     * Render bytes using the selected type; short numeric values fall back to hex.
     * @param {string} key
     * @param {SettingsType} type
     * @param {Uint8Array} valueBytes
     * @returns {string}
     */
    decodeForInput(key, type, valueBytes) {
        if (type === 'u8' && valueBytes.length >= 1) {
            return String(valueBytes[0]);
        }
        if (type === 'u16le' && valueBytes.length >= 2) {
            return String(valueBytes[0] | (valueBytes[1] << 8));
        }
        if (type === 'u32le' && valueBytes.length >= 4) {
            const unsignedValue = (valueBytes[0]) | (valueBytes[1] << 8) | (valueBytes[2] << 16)
                | (valueBytes[3] << 24);
            return String(unsignedValue >>> 0);
        }
        if (type === 'cstring') {
            const terminatorIndex = valueBytes.indexOf(0x00);
            const stringBytes = terminatorIndex >= 0 ? valueBytes.slice(0,
                terminatorIndex) : valueBytes;
            return new TextDecoder().decode(stringBytes);
        }
        if (type === 'ascii' || type === 'utf8' || type === 'booltf') {
            return new TextDecoder().decode(valueBytes);
        }
        return this.toHex(valueBytes);
    }

    /**
     * Validate and encode an editor value using the existing type-specific rules.
     * The ascii and utf8 labels both use TextEncoder, as in the original implementation.
     * @param {SettingsType} type
     * @param {unknown} rawValue
     * @returns {Uint8Array}
     */
    encodeTyped(type, rawValue) {
        const raw = String(rawValue == null ? '' : rawValue);
        if (type === 'u8') {
            const numericValue = Number(raw);
            if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 255) {
                throw new Error('u8 out of range');
            }
            return new Uint8Array([numericValue]);
        }
        if (type === 'u16le') {
            const numericValue = Number(raw);
            if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 65535) {
                throw new Error('u16le out of range');
            }
            return new Uint8Array([numericValue & 0xff, (numericValue >>> 8) & 0xff]);
        }
        if (type === 'u32le') {
            const numericValue = Number(raw);
            if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 0xffffffff) {
                throw new Error('u32le out of range');
            }
            return new Uint8Array([
                numericValue & 0xff,
                (numericValue >>> 8) & 0xff,
                (numericValue >>> 16) & 0xff,
                (numericValue >>> 24) & 0xff,
            ]);
        }
        if (type === 'cstring') {
            const body = new TextEncoder().encode(raw);
            const out = new Uint8Array(body.length + 1);
            out.set(body, 0);
            out[out.length - 1] = 0;
            return out;
        }
        if (type === 'ascii' || type === 'utf8') {
            return new TextEncoder().encode(raw);
        }
        if (type === 'booltf') {
            const booleanText = raw.toLowerCase();
            if (booleanText === 'true' || booleanText === 't' || booleanText === '1') {
                return new Uint8Array([0x74]);
            }
            if (booleanText === 'false' || booleanText === 'f' || booleanText === '0') {
                return new Uint8Array([0x66]);
            }
            throw new Error('booltf accepts true/false, t/f, 1/0');
        }
        if (type === 'hex') {
            return this.fromHex(raw);
        }
        throw new Error(`Unsupported type: ${type}`);
    }

    // === Record indexing and rendering ===

    /**
     * Index the last record for each key without changing the original record array.
     * @param {SettingsRecord[]} records
     * @returns {Map<string, SettingsRecord>}
     */
    buildLatestMap(records) {
        const latest = new Map();
        for (const record of records) {
            latest.set(record.key, record);
        }
        return latest;
    }

    /** Render visible settings and newly added rows, including an empty editable file. */
    renderEditor() {
        const scrollTop = this.gridEl.scrollTop;
        const fragment = document.createDocumentFragment();
        const header = document.createElement('div');
        header.className = 'settings-row settings-head';
        for (const label of ['KEY', 'TYPE', 'VALUE', 'ACTION']) {
            const cell = document.createElement('div');
            cell.textContent = label;
            header.appendChild(cell);
        }
        fragment.appendChild(header);
        const keys = [...this._latestByKey.keys()].filter(key => !this._deletedKeys.has(key))
            .sort((left, right) => left.localeCompare(right));
        for (const key of keys) {
            fragment.appendChild(this._createSettingsRow(key, this._getSettingsState(key), false));
        }
        for (const state of this._addedRows) {
            fragment.appendChild(this._createSettingsRow(state.key, state, true));
        }
        if (!keys.length && !this._addedRows.length) {
            const empty = document.createElement('div');
            empty.className = 'settings-empty';
            empty.textContent =
                'No rows. Add Row creates a setting; Apply to working image saves an empty file.';
            fragment.appendChild(empty);
        }
        this.gridEl.replaceChildren(fragment);
        this.gridEl.scrollTop = scrollTop;
        this._updateSettingsButtons();
    }

    // === Read / write orchestration ===

    /** Load one consistent source snapshot; stale async results cannot replace a newer image. */
    async reloadFromFile() {
        if ((!this.isSettingsSelected() && !this._loaded) || this._busy) return;
        const image = window.interface;
        const token = ++this._loadToken;
        this._busy = true;
        this._loadedImage = image;
        this._updateSettingsButtons();
        try {
            this.hideError();
            this.statusEl.innerText = window.DEV_MODE ? 'READING_/settings...' : 'Loading settings...';
            const parser = await this.getParser();
            const data = await parser.readFile('/settings');
            if (token !== this._loadToken || image !== window.interface) return;
            this.records = this.parseSettingsBuffer(data);
            this._sourceBytes = data.slice();
            this._latestByKey = this.buildLatestMap(this.records);
            this._resetDrafts();
            this._loaded = true;
            this.renderEditor();
            this.statusEl.innerText = `SETTINGS_READY: ${this.records.length} records, ` +
                `${this._latestByKey.size} keys, ${data.length} bytes`;
        } catch (error) {
            if (token !== this._loadToken || image !== window.interface) return;
            this._loaded = false;
            this.records = [];
            this._latestByKey = new Map();
            this._resetDrafts();
            this.renderEditor();
            this.statusEl.innerText = window.DEV_MODE ? 'SETTINGS_READ_FAILED' : 'Could not load settings';
            this.showError('SETTINGS_READ_FAILED\n' + String(error.message || error));
        } finally {
            if (token === this._loadToken) {
                this._busy = false;
                this._updateSettingsButtons();
            }
        }
    }

    /** Write the draft with source-conflict checking and retain it on every failed transaction. */
    async writeSettings() {
        if (!this._loaded || this._busy) return;
        if (window.interface?.readOnly) {
            this.statusEl.innerText = window.DEV_MODE ? 'READ_ONLY_SOURCE' : 'Enable Read / Write first';
            this.showError('READ_ONLY_SOURCE\nLive Flipper USB bridge SparseImage writes are disabled.');
            return;
        }
        const image = this._loadedImage;
        const token = this._loadToken;
        if (image !== window.interface) return;
        let lease;
        this._busy = true;
        this._updateSettingsButtons();
        try {
            lease = this.context.operations.beginImageEdit(this, image, () => {
                if (this._loadedImage !== image || this._loadToken !== token) throw new Error('Settings selection changed; reload before saving.');
            });
            this.hideError();
            this.statusEl.innerText = window.DEV_MODE ? 'VALIDATING_AND_WRITING_/settings...' : 'Saving settings to buffered changes...';
            const serialized = this.serializeRecords(this._buildNextSettingsRecords());
            const parser = await this.getParser();
            if (parser.sparseImage !== image) {
                throw new Error('Source image changed; reload settings.');
            }
            lease.assertCurrent();
            const result = await parser.writeFileChecked(
                '/settings', serialized, this._sourceBytes);
            if (!result?.success) throw new Error(result?.error || 'Unknown write error');
            if (image !== window.interface) return;
            const verification = await parser.readFile('/settings');
            lease.assertCurrent();
            if (!this._settingsBytesEqual(verification, serialized)) {
                throw new Error('Read-back verification failed. Do not export this image.');
            }
            this.records = this.parseSettingsBuffer(verification);
            this._sourceBytes = verification.slice();
            this._latestByKey = this.buildLatestMap(this.records);
            this._resetDrafts();
            this.renderEditor();
            this.statusEl.innerText = window.DEV_MODE
                ? (result.changed
                    ? `SETTINGS_WRITTEN_AND_VERIFIED: ${serialized.length} bytes (${result.storage})`
                    : 'SETTINGS_UNCHANGED')
                : (result.changed ? 'Settings saved · pending flash write' : 'Settings unchanged');
            if (result.changed) {
                window.AppState.interfaceRevision =
                    Number(window.AppState.interfaceRevision || 0) + 1;
                window.AppState.settingsSelectionRevision =
                    Number(window.AppState.settingsSelectionRevision || 0) + 1;
                this._seenInterfaceRevision = window.AppState.interfaceRevision;
                this._seenSelectionRevision = window.AppState.settingsSelectionRevision;
                if (this.tileManager) this.tileManager.broadcastUpdate(this);
            }
        } catch (error) {
            if (image === window.interface) {
                this.statusEl.innerText = window.DEV_MODE ? 'SETTINGS_WRITE_FAILED' : 'Settings save failed';
                this.showError('SETTINGS_WRITE_FAILED\n' + String(error.message || error));
            }
        } finally {
            lease?.release();
            if (token === this._loadToken) {
                this._busy = false;
                this._updateSettingsButtons();
            }
            this.tileManager?.broadcastUpdate(this);
        }
    }

    /** @returns {void} */
    _resetDrafts() {
        this._editState = new Map();
        this._deletedKeys = new Set();
        this._addedRows = [];
        this._dirty = false;
    }

    /** @returns {void} */
    _updateSettingsButtons() {
        const sourceReadOnly = !!window.interface?.readOnly;
        const editable = this._loaded && !this._busy
            && !sourceReadOnly;
        this.saveBtn.disabled = !editable;
        this.addBtn.disabled = !editable;
        this.reloadBtn.disabled = this._busy || !window.interface;
        for (const control of this.gridEl.querySelectorAll('input, select, textarea, button')) {
            control.disabled = !editable;
        }
        this.refreshLifecycle(editable);
        // Reload is a read operation and remains available on read-only live sources.
        this.reloadBtn.disabled = this._busy || !window.interface;
    }

    /** Reject missing or malformed binary records before offering a mode edit. */
    lifecycleReadable() {
        try { return UpdateImageLifecycle.inspect(this._sourceBytes); }
        catch { return null; }
    }

    /** The convenient selector and raw editor share the same latest-record draft. */
    refreshLifecycle(editable) {
        if (!this.lifecycleSelect) return;
        const current = this._loaded && this.lifecycleReadable();
        const status = this.element.querySelector('.js-settings-lifecycle-status');
        let value = current?.value;
        try {
            const draft = current && this._getSettingsState(FirmwareImage.LIFECYCLE_KEY);
            if (draft?.touched) {
                const bytes = this.encodeTyped(draft.type, draft.value);
                value = bytes.length === 1 ? bytes[0] : undefined;
            }
        } catch { value = undefined; }
        this.lifecycleSelect.replaceChildren();
        if (!Object.hasOwn(UpdateImageLifecycle.MODES, value)) {
            this.lifecycleSelect.add(new Option(UpdateImageLifecycle.label(value), String(value)));
        }
        for (const mode of [4, 2, 1]) this.lifecycleSelect.add(new Option(UpdateImageLifecycle.label(mode), String(mode)));
        this.lifecycleSelect.value = String(value);
        this.lifecycleSelect.disabled = !editable || !current || this._deletedKeys.has(FirmwareImage.LIFECYCLE_KEY);
        status.textContent = current ? `Current image: ${UpdateImageLifecycle.label(current.value)}. ` +
            (value === 1 ? 'Service / manufacturing mode; not normal operation.' : value === 2 ? 'Delivery state.' : '')
            : 'Unknown — lifecycle setting is missing or unreadable.';
    }

    /** @returns {void} */
    _markSettingsDirty() {
        this._dirty = true;
        this.statusEl.innerText = 'Draft — not applied';
        this.refreshLifecycle(this._loaded && !this._busy && !window.interface?.readOnly);
    }

    /**
     * Preserve every unedited byte, including unusual encodings and C-string suffixes.
     * @param {string} key @returns {object}
     */
    _getSettingsState(key) {
        if (this._editState.has(key)) return this._editState.get(key);
        const bytes = this._latestByKey.get(key).valueBytes;
        let type = this.inferTypeForKey(key);
        let value = this.decodeForInput(key, type, bytes);
        try {
            if (!this._settingsBytesEqual(this.encodeTyped(type, value), bytes)) type = 'hex';
        } catch (_error) {
            type = 'hex';
        }
        if (type === 'hex') value = this.toHex(bytes);
        const state = { type, value, touched: false };
        this._editState.set(key, state);
        return state;
    }

    /** @param {Uint8Array} left @param {Uint8Array} right @returns {boolean} */
    _settingsBytesEqual(left, right) {
        if (left.length !== right.length) return false;
        for (let index = 0; index < left.length; index++) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }

    /** Add an editable key/type/value row without changing the image. @returns {void} */
    addRow() {
        if (!this._loaded || this._busy) return;
        const state = { id: ++this._nextRowId, key: '', type: 'hex', value: '', touched: true };
        this._addedRows.push(state);
        this._markSettingsDirty();
        this.renderEditor();
        const input = this.gridEl.querySelector(`[data-new-row="${state.id}"] .settings-key-input`);
        if (input) {
            input.focus();
            input.scrollIntoView({ block: 'nearest' });
        }
    }

    /**
     * Remove every historical record for this visible key so an older value cannot reappear.
     * @param {string} key @returns {void}
     */
    deleteRow(key) {
        if (!this._loaded || this._busy || !this._latestByKey.has(key)) return;
        this._deletedKeys.add(key);
        this._editState.delete(key);
        this._markSettingsDirty();
        this.renderEditor();
    }

    /** @param {number} id @returns {void} */
    _deleteAddedRow(id) {
        if (this._busy) return;
        this._addedRows = this._addedRows.filter(row => row.id !== id);
        this._markSettingsDirty();
        this.renderEditor();
    }

    /**
     * Build one row using DOM text properties; keys/values are never interpreted as HTML.
     * @param {string} key @param {object} state @param {boolean} isNew
     * @returns {HTMLDivElement}
     */
    _createSettingsRow(key, state, isNew) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        row.dataset.key = key;
        if (isNew) row.dataset.newRow = String(state.id);
        const keyControl = document.createElement(isNew ? 'input' : 'div');
        keyControl.className = isNew ? 'settings-key-input' : 'settings-key';
        keyControl.title = isNew ? 'New settings key' : key;
        if (isNew) {
            keyControl.type = 'text';
            keyControl.placeholder = 'section/new_key';
            keyControl.value = state.key;
            keyControl.setAttribute('aria-label', 'New settings key');
            keyControl.addEventListener('input', () => {
                state.key = keyControl.value;
                this._markSettingsDirty();
            });
        } else keyControl.textContent = key;
        const typeSelect = document.createElement('select');
        typeSelect.className = 'settings-type';
        typeSelect.setAttribute('aria-label', `Value type: ${key || 'new key'}`);
        for (const type of ['u8', 'u16le', 'u32le', 'ascii', 'utf8', 'cstring', 'booltf', 'hex']) {
            const option = document.createElement('option');
            option.value = type;
            option.textContent = type;
            option.selected = state.type === type;
            typeSelect.appendChild(option);
        }
        const valueInput = document.createElement('textarea');
        valueInput.className = 'settings-value';
        valueInput.rows = 1;
        valueInput.spellcheck = false;
        valueInput.value = state.value;
        valueInput.setAttribute('aria-label', `Value: ${key || 'new key'}`);
        valueInput.addEventListener('input', () => {
            state.value = valueInput.value;
            state.touched = true;
            this._markSettingsDirty();
        });
        typeSelect.addEventListener('change', () => {
            const previousType = state.type;
            try {
                const newType = typeSelect.value;
                const blankNewRow = isNew && state.value === '';
                const bytes = this.encodeTyped(previousType, state.value);
                let value = this.decodeForInput(key, newType, bytes);
                if (blankNewRow) {
                    value = ['u8', 'u16le', 'u32le'].includes(newType) ? '0' :
                        newType === 'booltf' ? 'f' : '';
                } else if (!this._settingsBytesEqual(this.encodeTyped(newType, value), bytes)) {
                    throw new Error(
                        'Type conversion would change bytes; use hex to edit explicitly.');
                }
                state.type = newType;
                state.value = value;
                valueInput.value = value;
                this.hideError();
                if (blankNewRow) state.touched = true;
            } catch (error) {
                typeSelect.value = previousType;
                this.showError(String(error.message || error));
            }
        });
        const deleteButton = document.createElement('button');
        deleteButton.type = 'button';
        deleteButton.className = 'settings-delete-btn';
        deleteButton.textContent = 'Delete row';
        deleteButton.title = 'Stage removal; Reload discards unsaved changes';
        deleteButton.setAttribute('aria-label', `Delete setting: ${key || 'new row'}`);
        deleteButton.addEventListener('click', event => {
            event.stopPropagation();
            if (isNew) this._deleteAddedRow(state.id);
            else this.deleteRow(key);
        });
        row.append(keyControl, typeSelect, valueInput, deleteButton);
        return row;
    }

    /** @param {string} key @returns {void} */
    _validateNewSettingsKey(key) {
        const encoded = new TextEncoder().encode(key);
        const decoded = new TextDecoder('utf-8', { ignoreBOM: true }).decode(encoded);
        if (decoded !== key) throw new Error('A new key must contain valid Unicode.');
        if (!key || /[=\x00-\x1f\x7f]/.test(key)) {
            throw new Error(
                'A new key must not be empty or contain "=", NUL, or control characters.');
        }
    }

    /**
     * Keep existing order/history; edit only changed latest records and remove all deleted keys.
     * The 16-bit record-length limit remains mandatory, independent of filesystem block size.
     * @returns {SettingsRecord[]}
     */
    _buildNextSettingsRecords() {
        const latestIndexes = new Map();
        this.records.forEach((record, index) => latestIndexes.set(record.key, index));
        const result = [];
        const keys = new Set();
        for (const [index, record] of this.records.entries()) {
            if (this._deletedKeys.has(record.key)) continue;
            keys.add(record.key);
            const state = this._editState.get(record.key);
            const changed = state?.touched && latestIndexes.get(record.key) === index;
            const valueBytes = changed
                ? this.encodeTyped(state.type, state.value) : record.valueBytes;
            result.push({ ...record, valueBytes });
        }
        for (const state of this._addedRows) {
            this._validateNewSettingsKey(state.key);
            if (keys.has(state.key)) throw new Error(`Duplicate settings key: ${state.key}`);
            keys.add(state.key);
            result.push({ key: state.key, valueBytes: this.encodeTyped(state.type, state.value) });
        }
        return result;
    }
}
CoreFlasherApp.cardControllers["tile-settings-editor"] = CardController;
})();
