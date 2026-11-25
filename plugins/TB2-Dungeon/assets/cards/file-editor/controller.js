/* File Editor controller. Shared services are supplied by the card context. */
(() => {
class CardController extends Tile {
    /** Report a local draft without transferring its ownership. */
    hasDraft() { return !!this.dirty; }
    init() {
        this.element.querySelector('.js-enable-edit').addEventListener('click', () => this.context.image.setEditMode('rw-buffered'));
        this.pathEl = this.element.querySelector('.js-file-editor-path');
        this.kindEl = this.element.querySelector('.js-file-editor-kind');
        this.cryptPanel = this.element.querySelector('.js-file-editor-crypt-panel');
        this.decryptBtn = this.element.querySelector('.js-file-editor-decrypt');
        this.textEl = this.element.querySelector('.js-file-editor-text');
        this.reloadBtn = this.element.querySelector('.js-file-editor-reload');
        this.saveBtn = this.element.querySelector('.js-file-editor-save');
        this.dirtyEl = this.element.querySelector('.js-file-editor-dirty');
        this.statusEl = this.element.querySelector('.js-file-editor-status');
        this.errorEl = this.element.querySelector('.js-file-editor-error');

        this.path = null;
        this.isCrypt = false;
        this.decrypted = false;
        this.loading = false;
        this.dirty = false;
        this.originalStoredBytes = null;
        this.originalPlainBytes = null;
        this.originalText = '';
        this.cryptoUuid = null;
        this.editorMode = 'text';
        this._seenSelectionRevision = -1;
        this._seenInterfaceRevision = -1;

        this.textEl.addEventListener('input', () => {
            if (this.loading || !this.path || (this.isCrypt && !this.decrypted)) return;
            this.dirty = this.textEl.value !== this.originalText;
            this.refreshControls();
        });

        this.decryptBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await this.decryptCurrent();
        });

        this.reloadBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            if (this.dirty &&
                !window.confirm('Discard unsaved editor changes and reload the file?')) {
                return;
            }
            await this.loadSelection(true);
        });

        this.saveBtn.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            await this.saveBuffered();
        });

        this.update();
    }

    showError(message) {
        this.errorEl.textContent = String(message || 'Unknown error');
        this.errorEl.classList.remove('hidden');
    }

    hideError() {
        this.errorEl.textContent = '';
        this.errorEl.classList.add('hidden');
    }

    normalizeUuid(value) {
        return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 16);
    }

    validUuid(value) {
        return /^500100[0-9A-F]{10}$/.test(this.normalizeUuid(value));
    }

    getFileManager() {
        return this.context.filesystem || null;
    }

    async getParser() {
        const image = window.interface;
        if (!image || typeof LittleFSParser === 'undefined') {
            throw new Error('No LittleFS image is available.');
        }
        if (window.AppState.littlefsParser &&
            window.AppState.littlefsParserSource === image) {
            return window.AppState.littlefsParser;
        }
        const parser = new LittleFSParser(image, 0x820000, image.size - 0x820000);
        await parser.initialize();
        window.AppState.littlefsParser = parser;
        window.AppState.littlefsParserSource = image;
        return parser;
    }

    decodeText(bytes) {
        if (!(bytes instanceof Uint8Array)) {
            throw new Error('TEXT_DECODE_FAILED: invalid byte source.');
        }
        for (const byte of bytes) {
            if (byte === 0x00) {
                throw new Error('TEXT_DECODE_FAILED: file contains NUL bytes.');
            }
            if (byte < 0x20 && ![0x09, 0x0A, 0x0D].includes(byte)) {
                throw new Error('TEXT_DECODE_FAILED: file contains binary control bytes.');
            }
        }
        try {
            return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        catch (_error) {
            throw new Error('TEXT_DECODE_FAILED: content is not valid UTF-8 text.');
        }
    }

    isTextBytes(bytes) {
        try {
            this.decodeText(bytes);
            return true;
        }
        catch (_error) {
            return false;
        }
    }

    formatHex(bytes) {
        const lines = [];
        for (let offset = 0; offset < bytes.length; offset += 16) {
            lines.push(
                Array.from(bytes.subarray(offset, offset + 16))
                    .map(byte => byte.toString(16).padStart(2, '0').toUpperCase())
                    .join(' ')
            );
        }
        return lines.join('\n');
    }

    parseHexEditor(text) {
        const compact = String(text || '').replace(/\s+/g, '');
        if (compact.length % 2 !== 0 || /[^0-9a-f]/i.test(compact)) {
            throw new Error('HEX_EDITOR_INVALID: use hexadecimal byte pairs only.');
        }
        const bytes = new Uint8Array(compact.length / 2);
        for (let index = 0; index < bytes.length; index++) {
            bytes[index] = parseInt(compact.slice(index * 2, index * 2 + 2), 16);
        }
        return bytes;
    }

    refreshControls() {
        const hasPath = !!this.path;
        const contentReady = hasPath && (!this.isCrypt || this.decrypted);
        const buffered =
            window.AppState.interfaceMode === 'rw-buffered' &&
            !!window.interface &&
            !window.interface.readOnly;

        this.textEl.disabled = !contentReady || this.loading;
        this.reloadBtn.disabled = !hasPath || this.loading;
        this.decryptBtn.disabled = !this.isCrypt || this.decrypted || this.loading;
        this.saveBtn.disabled =
            !contentReady || !this.dirty || !buffered || this.loading;

        this.dirtyEl.classList.toggle('hidden', !this.dirty);
        this.cryptPanel.classList.toggle('hidden', !this.isCrypt);
        this.kindEl.textContent = this.isCrypt
            ? (this.decrypted
                ? (this.editorMode === 'hex' ? 'CRYPT / HEX' : 'CRYPT / DECRYPTED')
                : 'CRYPT')
            : (this.editorMode === 'hex' ? 'HEX' : 'TEXT');

        if (hasPath && contentReady && this.dirty && !buffered) {
            this.statusEl.textContent =
                'EDITED_IN_RAM — ENABLE_READ_WRITE_BUFFERED_TO_SAVE';
        }
    }

    async loadSelection(force = false) {
        if (this._saveLease) return;
        const nextPath = window.AppState.fileEditorSelectedPath || null;
        const sourceImage = window.interface;
        const sourceRevision = Number(window.AppState.interfaceRevision || 0);
        const loadToken = this._selectionLoadToken = (this._selectionLoadToken || 0) + 1;
        const ownsLoad = () => loadToken === this._selectionLoadToken;
        const current = () => ownsLoad() && sourceImage === window.interface &&
            sourceRevision === Number(window.AppState.interfaceRevision || 0) &&
            nextPath === window.AppState.fileEditorSelectedPath;
        // A newer selection owns the loading flag, including an empty or retained draft.
        this.loading = false;
        if (this.dirty && nextPath !== this.path) {
            if (!nextPath) { this.refreshControls(); return; }
            if (!window.confirm('Replace the editor draft with the selected file? Unapplied edits will be discarded.')) {
                window.AppState.fileEditorSelectedPath = this.path;
                this.refreshControls();
                return;
            }
        }
        if (!nextPath) {
            this.path = null;
            this.textEl.value = '';
            this.pathEl.textContent = 'NO_FILE_SELECTED';
            this.statusEl.textContent = window.DEV_MODE ? 'SELECT_TEXT_OR_CRYPT_IN_FILE_MANAGER' : 'Select a text or .crypt file in File Manager';
            this.isCrypt = false;
            this.decrypted = false;
            this.dirty = false;
            this.originalStoredBytes = null;
            this.originalPlainBytes = null;
            this.originalText = '';
            this.cryptoUuid = null;
            this.editorMode = 'text';
            this.refreshControls();
            return;
        }

        if (!force && nextPath === this.path && this.dirty) {
            this.refreshControls();
            return;
        }

        this.loading = true;
        this.hideError();
        this.refreshControls();

        try {
            const parser = await this.getParser();
            const raw = await parser.readFile(nextPath);
            if (!current()) return;

            this.path = nextPath;
            this.pathEl.textContent = nextPath;
            this.isCrypt = /\.crypt$/i.test(nextPath);
            this.decrypted = false;
            this.dirty = false;
            this.originalStoredBytes = raw.slice();
            this.originalPlainBytes = null;
            this.originalText = '';
            this.cryptoUuid = null;
            this.editorMode = 'text';

            if (this.isCrypt) {
                this.textEl.value = '';
                this.statusEl.textContent = window.DEV_MODE ? 'ENCRYPTED — DECRYPT_WITH_UUID' : 'Encrypted · decrypt with UUID to edit';
            }
            else {
                const decoded = this.decodeText(raw);
                this.textEl.value = decoded;
                this.originalText = decoded;
                this.originalPlainBytes = raw.slice();
                this.statusEl.textContent = `TEXT_READY · ${raw.length} bytes`;
            }
        }
        catch (error) {
            if (!current()) return;
            this.textEl.value = '';
            this.showError(error?.message || error);
            this.statusEl.textContent = window.DEV_MODE ? 'EDITOR_LOAD_FAILED' : 'Could not load file';
        }
        finally {
            if (ownsLoad()) {
                this.loading = false;
                this.refreshControls();
            }
        }
    }

    async decryptCurrent() {
        if (this.loading || !this.path || !this.isCrypt ||
            !(this.originalStoredBytes instanceof Uint8Array)) return;

        const uuid = this.normalizeUuid(
            this.context.uuid.normalizedValue || ''
        );
        if (!this.validUuid(uuid)) {
            this.statusEl.textContent = window.DEV_MODE ? 'UUID_REQUIRED_FOR_DECRYPT' : 'UUID required to decrypt';
            this.context.uuid.requestAttention();
            return;
        }

        const manager = this.getFileManager();
        if (!manager ||
            typeof manager.hexToBytes !== 'function' ||
            typeof manager.decryptCryptBlob !== 'function') {
            this.showError('CRYPT_HELPER_UNAVAILABLE');
            return;
        }

        const sourceImage = window.interface, path = this.path, storedBytes = this.originalStoredBytes;
        const sourceRevision = Number(window.AppState.interfaceRevision || 0);
        const selectionRevision = window.AppState.fileEditorSelectionRevision;
        const uuidRevision = this.context.uuid.revision;
        const loadToken = this._selectionLoadToken = (this._selectionLoadToken || 0) + 1;
        const snapshot = storedBytes.slice();
        const ownsLoad = () => loadToken === this._selectionLoadToken;
        const current = () => ownsLoad() && sourceImage === window.interface && path === this.path &&
            path === window.AppState.fileEditorSelectedPath &&
            sourceRevision === Number(window.AppState.interfaceRevision || 0) &&
            selectionRevision === window.AppState.fileEditorSelectionRevision &&
            uuidRevision === this.context.uuid.revision && uuid === this.normalizeUuid(this.context.uuid.normalizedValue) &&
            storedBytes === this.originalStoredBytes && storedBytes.length === snapshot.length &&
            storedBytes.every((value, index) => value === snapshot[index]);

        this.loading = true;
        this.hideError();
        this.refreshControls();

        try {
            const uuidBytes = manager.hexToBytes(uuid);
            const salt = manager.hexToBytes('bc21551317da981e5e4650a7d238ea2c');
            const info = manager.hexToBytes('2469031c2490ad3f3bd1b05cfd5c6681');
            const plain = await manager.decryptCryptBlob(
                snapshot,
                uuidBytes,
                salt,
                info
            );
            if (!current()) return;

            this.cryptoUuid = uuid;
            this.originalPlainBytes = plain.slice();
            this.decrypted = true;
            this.dirty = false;

            if (this.isTextBytes(plain)) {
                const decoded = this.decodeText(plain);
                this.editorMode = 'text';
                this.originalText = decoded;
                this.textEl.value = decoded;
                this.statusEl.textContent =
                    `DECRYPTED_TEXT_WITH_UUID ${uuid} · ${plain.length} bytes`;
            }
            else {
                const hex = this.formatHex(plain);
                this.editorMode = 'hex';
                this.originalText = hex;
                this.textEl.value = hex;
                this.statusEl.textContent =
                    `DECRYPTED_BINARY_WITH_UUID ${uuid} · ${plain.length} bytes · HEX_EDITOR`;
            }
        }
        catch (error) {
            if (!current()) return;
            this.decrypted = false;
            this.textEl.value = '';
            this.showError(error?.message || error);
            this.statusEl.textContent = window.DEV_MODE ? 'DECRYPT_FAILED' : 'Decrypt failed';
        }
        finally {
            if (ownsLoad()) {
                this.loading = false;
                this.refreshControls();
            }
        }
    }

    async saveBuffered() {
        if (!this.path || this.loading) return;

        const image = window.interface;
        if (!image ||
            window.AppState.interfaceMode !== 'rw-buffered' ||
            image.readOnly) {
            this.statusEl.textContent = window.DEV_MODE ? 'READ_WRITE_BUFFERED_REQUIRED' : 'Enable Read / Write first';
            this.refreshControls();
            return;
        }
        if (this.isCrypt && !this.decrypted) {
            this.statusEl.textContent = window.DEV_MODE ? 'DECRYPT_BEFORE_SAVE' : 'Decrypt the file before saving';
            return;
        }
        if (!this.dirty) {
            this.statusEl.textContent = window.DEV_MODE ? 'UNCHANGED — SAVE_IGNORED' : 'No changes to save';
            return;
        }

        const path = this.path, editorMode = this.editorMode, isCrypt = this.isCrypt;
        const sourceBytes = this.originalStoredBytes, sourceText = this.textEl.value;
        const selectionRevision = window.AppState.fileEditorSelectionRevision;
        let lease;

        this.loading = true;
        this.hideError();
        this.refreshControls();

        try {
            lease = this.context.operations.beginImageEdit(this, image, () => {
                if (this.path !== path || window.AppState.fileEditorSelectedPath !== path ||
                    window.AppState.fileEditorSelectionRevision !== selectionRevision) throw new Error('File selection changed; reload before saving.');
            });
            this._saveLease = lease;
            const parser = await this.getParser();
            lease.assertCurrent();
            if (parser.sparseImage !== image) throw new Error('The source image changed; reload before saving.');
            const plainBytes = editorMode === 'hex'
                ? this.parseHexEditor(sourceText)
                : new TextEncoder().encode(sourceText);
            let storedBytes = plainBytes;

            if (isCrypt) {
                const uuid = this.normalizeUuid(
                    this.context.uuid.normalizedValue || ''
                );
                if (!this.validUuid(uuid)) {
                    this.context.uuid.requestAttention();
                    throw new Error('UUID_REQUIRED_FOR_ENCRYPT');
                }
                if (uuid !== this.cryptoUuid) {
                    throw new Error('UUID_CHANGED_REDECRYPT_REQUIRED');
                }

                const manager = this.getFileManager();
                if (!manager ||
                    typeof manager.encryptPlainAsCryptBlob !== 'function') {
                    throw new Error('CRYPT_HELPER_UNAVAILABLE');
                }

                const uuidBytes = manager.hexToBytes(uuid);
                const salt = manager.hexToBytes('bc21551317da981e5e4650a7d238ea2c');
                const info = manager.hexToBytes('2469031c2490ad3f3bd1b05cfd5c6681');

                storedBytes = await manager.encryptPlainAsCryptBlob(
                    plainBytes,
                    uuidBytes,
                    salt,
                    info
                );
            }

            lease.assertCurrent();
            const result = await parser.writeFileChecked(
                path,
                storedBytes,
                sourceBytes
            );
            if (!result?.success) {
                throw new Error(result?.error || 'BUFFERED_SAVE_FAILED');
            }

            const verification = await parser.readFile(path);
            lease.assertCurrent();
            const equal =
                verification.length === storedBytes.length &&
                verification.every((value, index) => value === storedBytes[index]);
            if (!equal) throw new Error('BUFFERED_SAVE_VERIFY_FAILED');

            this.originalStoredBytes = storedBytes.slice();
            this.originalPlainBytes = plainBytes.slice();
            if (editorMode === 'hex') {
                this.textEl.value = this.formatHex(plainBytes);
            }
            this.originalText = this.textEl.value;
            this.dirty = false;

            window.AppState.interfaceRevision =
                Number(window.AppState.interfaceRevision || 0) + 1;
            this._seenInterfaceRevision = window.AppState.interfaceRevision;
            this.tileManager?.broadcastUpdate(this);

            this.statusEl.textContent = this.isCrypt
                ? 'CRYPT_REENCRYPTED_AND_SAVED_BUFFERED'
                : 'TEXT_SAVED_BUFFERED';
        }
        catch (error) {
            this.showError(error?.message || error);
            this.statusEl.textContent = window.DEV_MODE ? 'BUFFERED_SAVE_FAILED' : 'Save failed';
        }
        finally {
            lease?.release();
            this._saveLease = null;
            this.loading = false;
            this.refreshControls();
            this.tileManager?.broadcastUpdate(this);
        }
    }

    focus() {
        super.focus();
        this.loadSelection(false);
    }

    update() {
        if (this._draftImage !== window.interface) {
            this._draftImage = window.interface;
            this.dirty = false;
            this._selectionLoadToken = (this._selectionLoadToken || 0) + 1;
        }
        const selectionRevision =
            Number(window.AppState.fileEditorSelectionRevision || 0);
        const interfaceRevision =
            Number(window.AppState.interfaceRevision || 0);
        const selectedPath =
            window.AppState.fileEditorSelectedPath || null;

        const pathChanged =
            selectedPath !== this.path ||
            selectionRevision !== this._seenSelectionRevision;
        const imageChanged =
            interfaceRevision !== this._seenInterfaceRevision;

        this._seenSelectionRevision = selectionRevision;
        this._seenInterfaceRevision = interfaceRevision;

        if (!selectedPath) {
            this.loadSelection(true);
            return;
        }
        if (pathChanged) {
            // Reselecting a file or returning from another card keeps its draft.
            this.loadSelection(false);
            return;
        }
        if (imageChanged && !this.dirty) {
            this.loadSelection(true);
            return;
        }
        this.refreshControls();
    }

    isFlashing() {
        return false;
    }
}
CoreFlasherApp.cardControllers["tile-file-editor"] = CardController;
})();
