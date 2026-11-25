/* File Manager controller. Shared services are supplied by the card context. */
(() => {
// === File manager: selection -> optional crypto -> filesystem operations ===

class CardController extends Tile {

    /**
     * Initialize component fields, event handlers, and state synchronization.
     * @returns {void}
     */
    init() {
        this.treeEl = this.element.querySelector('.js-replace-file-tree');
        this.saveBtn = this.element.querySelector('.js-replace-save-btn');
        this.replaceBtn = this.element.querySelector('.js-replace-replace-btn');
        this.replaceInput = this.element.querySelector('.js-replace-input');
        this.statusEl = this.element.querySelector('.js-replace-status');
        this.errorEl = this.element.querySelector('.js-replace-error');
        this.listen(this.element.querySelector('.js-detect-uuid'), 'click', event => {
            event.stopPropagation();
            if (CoreFlasherApp.extensions.has('uuid-scanner')) this.context.navigation.moveToCard('tile-cracker-pane');
            else this.tileManager.openImageManager();
        });
        this.selectedPath = null;
        this.files = [];
        this.parser = null;
        this.hasBeenEnabled = false;
        this._decryptableFiles = new Set();
        this._lastVerifyUuid = null;
        this._decryptCheckTimer = null;
        this._decryptScanGeneration = 0;
        this._refreshExplorerPromise = null;
        this._refreshExplorerRequested = false;
        this._selectionGeneration = 0;
        this._selectionImage = window.interface || null;
        this._recentlyReplacedPath = null;
        this._recentlyReplacedTimer = null;
        this._lastSeenSparseRevision = Number(window.AppState.interfaceRevision || 0);
        this._hasUnseenSparseChange = false;

        /**
         * Publish file selection and synchronize settings-tile availability.
         * @param {string|null} path
         * @returns {void}
         */
        this.publishSelectedPath = (path) => {
            const normalized = path || null;
            const prev = window.AppState.fileManagerSelectedPath || null;
            window.AppState.fileManagerSelectedPath = normalized;
            if (prev !== normalized) {
                window.AppState.settingsSelectionRevision = Number(
                    window.AppState.settingsSelectionRevision || 0) + 1;
            }
            if (!this.tileManager) {
                return;
            }
            const settingsTile = this.context.settings.available ? this.context.settings : null;
            if (!settingsTile) {
                return;
            }
            if (normalized === '/settings' || normalized === 'settings') {
                if (!settingsTile.isEnabled()) {
                    settingsTile.enable();
                }
            }
            else if (settingsTile.isEnabled()) {
                settingsTile.disable();
            }
            settingsTile.update();
            settingsTile.updateStyles();
        };
        const FIXED_SALT = this.hexToBytes('bc21551317da981e5e4650a7d238ea2c');
        const FIXED_INFO = this.hexToBytes('2469031c2490ad3f3bd1b05cfd5c6681');

        /**
         * Normalize a persisted UUID to at most 16 uppercase hex characters.
         * @param {unknown} value
         * @returns {string}
         */
        const normalizeUuid = (value) => String(value || '').replace(/[^0-9a-f]/gi,
            '').toUpperCase().slice(0, 16);

        /**
         * Check the existing 500100-prefixed UUID pattern.
         * @param {string} uuidHex
         * @returns {boolean}
         */
        const isValidUuid = (uuidHex) => /^500100[0-9A-F]{10}$/.test(uuidHex);

        /**
         * Check for the case-insensitive encrypted-file extension.
         * @param {unknown} path
         * @returns {boolean}
         */
        const isCrypt = (path) => /\.crypt$/i.test(String(path || ''));

        /**
         * Clear and hide the settings error panel.
         * @returns {void}
         */
        const hideError = () => {
            if (!this.errorEl) {
                return;
            }
            this.errorEl.classList.add('hidden');
            this.errorEl.innerText = '';
        };

        /**
         * Show the supplied failure message in the settings error panel.
         * @param {unknown} message
         * @returns {void}
         */
        const showError = (message) => {
            if (!this.errorEl) {
                return;
            }
            this.errorEl.innerText = String(message || 'Unknown error');
            this.errorEl.classList.remove('hidden');
        };

        /**
         * Read the shared UUID without creating a second editable source.
         * @returns {string}
         */
        const applyUuidState = () => {
            return normalizeUuid(this.context.uuid.normalizedValue);
        };

        /**
         * Reflect the current file selection without changing optional scanner state.
         * @returns {void}
         */
        const updateButtons = () => {
            const hasSelection = Boolean(this.selectedPath);
            const sourceReadOnly = !!window.interface?.readOnly;
            this.saveBtn.disabled = !hasSelection;
            this.replaceBtn.disabled = !hasSelection || sourceReadOnly;

            const needsUuid = isCrypt(this.selectedPath);
            const exportMode = this.element.querySelector('.js-file-export-mode');
            exportMode.hidden = !needsUuid;
            this.saveBtn.textContent = needsUuid ? (exportMode.value === 'decrypted' ? 'Download decrypted file' : 'Download original file') : 'Download file';
        };
        this._updateFileManagerButtons = () => { updateButtons(); this.updateUuidGuidance(); };
        this.element.querySelector('.js-file-export-mode').addEventListener('change', updateButtons);
        this.saveBtn.addEventListener('click', async () => {
            if (!this.selectedPath || !this.parser) {
                return;
            }
            const image = window.interface, parser = this.parser, path = this.selectedPath;
            const generation = this._selectionGeneration, revision = window.AppState.interfaceRevision;
            const exportMode = this.element.querySelector('.js-file-export-mode').value;
            const decrypt = isCrypt(path) && exportMode === 'decrypted';
            const uuidHex = applyUuidState(), uuidRevision = this.context.uuid.revision;
            const current = () => image === window.interface && parser === this.parser &&
                path === this.selectedPath && generation === this._selectionGeneration &&
                revision === window.AppState.interfaceRevision &&
                exportMode === this.element.querySelector('.js-file-export-mode').value &&
                (!decrypt || (uuidRevision === this.context.uuid.revision && uuidHex === applyUuidState()));
            try {
                hideError();
                const raw = await parser.readFile(path);
                if (!current()) return;
                let out = raw;
                let name = path.split('/').pop() || 'file.bin';
                if (decrypt) {
                    if (!isValidUuid(uuidHex)) {
                        this.statusEl.innerText = 'UUID_REQUIRED_FOR_DECRYPT';
                        this.context.uuid.requestAttention();
                        return;
                    }
                    const uuidBytes = this.hexToBytes(uuidHex);
                    out = await this.decryptCryptBlob(raw, uuidBytes, FIXED_SALT, FIXED_INFO);
                    if (!current()) return;
                    name = name.replace(/\.crypt$/i, '');
                }
                this.downloadBytes(out, name || 'export.bin');
                this.statusEl.innerText = `EXPORTED: ${path}`;
            }
            catch (err) {
                if (!current()) return;
                this.statusEl.innerText = window.DEV_MODE ? 'EXPORT_FAILED' : 'Export failed';
                showError('EXPORT_FAILED\n' + String((err && err.message) ? err.message : err));
                console.error('Save selected file failed:', err);
            }
        });
        this.replaceBtn.addEventListener('click', () => {
            if (CoreFlasherDumpUi.busy() || this.context.operations.otherCardBusy(this)) return;
            if (window.interface?.readOnly) {
                this.statusEl.innerText = window.DEV_MODE ? 'READ_ONLY_SOURCE' : 'Enable Read / Write first';
                return;
            }
            this.replaceInput.value = '';
            this.replaceInput.click();
        });
        this.replaceInput.addEventListener('change', async () => {
            if (window.interface?.readOnly) {
                this.replaceInput.value = '';
                this.statusEl.innerText = window.DEV_MODE ? 'READ_ONLY_SOURCE' : 'Enable Read / Write first';
                return;
            }
            const file = this.replaceInput.files && this.replaceInput.files.length > 0
                ? this.replaceInput.files[0] : null;
            if (!file || !this.selectedPath || !this.parser) {
                this.replaceInput.value = '';
                return;
            }
            const image = window.interface, parser = this.parser, selectedPath = this.selectedPath;
            const selectionGeneration = this._selectionGeneration;
            let lease;
            try {
                lease = this.context.operations.beginImageEdit(this, image, () => {
                    if (parser !== this.parser || parser.sparseImage !== image || this.selectedPath !== selectedPath ||
                        this._selectionGeneration !== selectionGeneration) throw new Error('File selection changed; choose the replacement again.');
                });
                hideError();
                let payload = new Uint8Array(await file.arrayBuffer());
                lease.assertCurrent();
                if (isCrypt(selectedPath) && !isCrypt(file.name)) {
                    const uuidHex = applyUuidState();
                    if (!isValidUuid(uuidHex)) {
                        this.statusEl.innerText = 'UUID_REQUIRED_FOR_ENCRYPT';
                        this.context.uuid.requestAttention();
                        return;
                    }
                    const uuidBytes = this.hexToBytes(uuidHex);
                    payload = await this.encryptPlainAsCryptBlob(payload, uuidBytes, FIXED_SALT,
                        FIXED_INFO);
                }
                lease.assertCurrent();
                const res = await parser.writeFile(selectedPath, payload);
                if (!res || !res.success) {
                    throw new Error(res && res.error ? res.error : 'Unknown write error');
                }
                lease.assertCurrent();
                window.AppState.interfaceRevision = Number(window.AppState.interfaceRevision || 0)
                    + 1;
                if (this.tileManager) {
                    this.tileManager.broadcastUpdate(this);
                }
                this.statusEl.innerText = window.DEV_MODE ? `REPLACED: ${selectedPath}` : `Replaced ${selectedPath} · pending write`;
                const replacedPath = selectedPath;
                await this.refreshExplorer();
                this.markRecentlyReplaced(replacedPath);
            }
            catch (err) {
                this.statusEl.innerText = window.DEV_MODE ? 'REPLACE_FAILED' : 'Replace failed';
                showError('REPLACE_FAILED\n' + String((err && err.message) ? err.message : err));
                console.error('Replace selected file failed:', err);
            }
            finally {
                lease?.release();
                this.replaceInput.value = '';
                this.tileManager?.broadcastUpdate(this);
            }
        });
        this._refreshTimer = setInterval(() => {
            const currentUuid = this.context.uuid.normalizedValue;
            if (currentUuid !== this._observedUuid) {
                this._observedUuid = currentUuid;
                this._scheduleDecryptCheck();
            }
            updateButtons();
            this.updateUuidGuidance();
        }, 2500);
        this.update();
    }

    /**
     * Acknowledge attention state and focus this tile.
     * @returns {void}
     */
    focus() {
        super.focus();
        this._hasUnseenSparseChange = false;
        this._lastSeenSparseRevision = Number(window.AppState.interfaceRevision || 0);
        this.updateStyles();
    }

    /**
     * Synchronize this component with the shared application state.
     * @returns {void}
     */
    update() {
        const hasImage = !!window.interface;
        if (this._selectionImage !== (window.interface || null)) {
            this._selectionImage = window.interface || null;
            this._selectionGeneration++;
            this.selectedPath = null;
            this.parser = null;
            this._parserRevision = null;
            this.files = [];
            this.renderFiles();
        }
        const currentRevision = Number(window.AppState.interfaceRevision || 0);
        if (this.isFocused) {
            this._hasUnseenSparseChange = false;
            this._lastSeenSparseRevision = currentRevision;
        }
        else if (hasImage && currentRevision > this._lastSeenSparseRevision) {
            this._hasUnseenSparseChange = true;
        }
        if (!hasImage) {
            this._hasUnseenSparseChange = false;
            this._lastSeenSparseRevision = currentRevision;
        }
        const needsParserRefresh =
            this.enabled &&
            hasImage &&
            (
                !this.parser ||
                this.parser.sparseImage !== window.interface ||
                this._parserRevision !== currentRevision
            );

        if (needsParserRefresh) {
            // Important for live WebUSB: the File Manager may already be open when
            // setInterfaceImage() publishes the first live SparseImage. In that case
            // this.parser is still null and must be initialized immediately.
            this.refreshExplorer();
        }
        else {
            this._scheduleDecryptCheck();
        }
        this._updateFileManagerButtons?.();
        this.updateStyles();
    }

    /**
     * Enable this tile and preserve its existing update sequence.
     * @returns {void}
     */
    enable() {
        super.enable();
        if (!this.hasBeenEnabled) {
            this.hasBeenEnabled = true;
        }
        this.refreshExplorer();
    }

    /**
     * Evaluate this component's attention condition.
     * @returns {boolean}
     */
    isFlashing() {
        return this.enabled && !this.isFocused && !!window.interface && this._hasUnseenSparseChange;
    }

    /**
     * Describe the current attention condition for diagnostic logging.
     * @returns {string}
     */
    getBlinkReason() {
        const currentRevision = Number(window.AppState.interfaceRevision || 0);
        if (!window.interface) {
            return 'no SparseImage loaded';
        }
        if (!this._hasUnseenSparseChange) {
            return 'no unseen SparseImage changes for file manager';
        }
        return `unseen SparseImage change for file manager (revision ${currentRevision} > seen ${this._lastSeenSparseRevision})`;
    }

    /**
     * Refresh the current image listing and verify encrypted-file accessibility.
     * @returns {Promise<void>}
     */
    async refreshExplorer() {
        this._refreshExplorerRequested = true;
        if (this._refreshExplorerPromise) return this._refreshExplorerPromise;

        // Start on the next microtask so reentrant broadcasts see the same promise.
        const run = Promise.resolve().then(async () => {
            do {
                this._refreshExplorerRequested = false;
                await this._refreshExplorerUnlocked();
            } while (this._refreshExplorerRequested);
        });
        this._refreshExplorerPromise = run;
        try {
            return await run;
        }
        finally {
            if (this._refreshExplorerPromise === run) this._refreshExplorerPromise = null;
        }
    }

    /** Show key guidance separately from filesystem/read errors. */
    updateUuidGuidance() {
        const hint = this.element.querySelector('.js-uuid-guidance');
        if (!hint) return;
        const encrypted = /\.crypt$/i.test(this.selectedPath || '');
        const known = /^500100[0-9A-F]{10}$/.test(this.context.uuid.normalizedValue);
        const mismatch = known && this._lastVerifyUuid === this.context.uuid.normalizedValue &&
            this._keyMismatches?.has(this.selectedPath);
        hint.hidden = !encrypted || (known && !mismatch);
        const scannerInstalled = CoreFlasherApp.extensions.has('uuid-scanner');
        hint.querySelector('.js-detect-uuid').textContent = scannerInstalled ? 'Go to Detect UUID' : 'Open Image Manager';
        hint.querySelector('span').textContent = mismatch
            ? 'This image does not match the current UUID. Detect the correct UUID.'
            : 'Detect the UUID first to decrypt this file.';
        if (!scannerInstalled) hint.querySelector('span').textContent = mismatch
            ? 'This image does not match its saved box UUID. Review Box details in Image Manager.'
            : 'Load or save this image in Image Manager and save its box UUID to decrypt this file.';
    }

    /** Select the existing settings file when its editor opens, without writing the image. */
    async selectSettingsForEditor(editor) {
        const image = window.interface;
        if (!image) return;
        if (!this.parser || this.parser.sparseImage !== image ||
            this._parserRevision !== Number(window.AppState.interfaceRevision || 0)) await this.refreshExplorer();
        // A late filesystem read must not select a file in another image or after leaving Settings.
        if (window.interface !== image || !editor.isFocused) return;
        const file = this.files.find(entry => entry.path === '/settings' || entry.path === 'settings');
        if (!file) throw new Error('The loaded image does not contain /settings.');
        if (this.selectedPath === file.path) { this.publishSelectedPath(file.path); return; }
        this._selectionGeneration++;
        this.selectedPath = file.path;
        this.publishSelectedPath(file.path);
        this.renderFiles();
        await this.syncEditorTileAvailability();
    }

    /** Publish only a listing from the current image/revision. */
    async _refreshExplorerUnlocked() {
        this._syncUuidFromStorage();
        const image = window.interface;
        const revision = Number(window.AppState.interfaceRevision || 0);
        const current = () => image === window.interface &&
            revision === Number(window.AppState.interfaceRevision || 0);
        if (!image || typeof LittleFSParser === 'undefined') {
            this.files = [];
            this.parser = null;
            this.renderFiles();
            this.statusEl.innerText = window.DEV_MODE ? 'AWAITING_INTERFACE_IMAGE' : 'Load or connect an image to browse files';
            return;
        }
        try {
            let parser = this.parser;
            if (!parser || parser.sparseImage !== image || this._parserRevision !== revision) {
                parser = new LittleFSParser(image, 0x820000, image.size - 0x820000);
                await parser.initialize();
                if (!current()) { this._refreshExplorerRequested = true; return; }
                this.parser = parser;
                this._parserRevision = revision;
                window.AppState.littlefsParser = parser;
                window.AppState.littlefsParserSource = image;
            }
            this.files = (parser.flatFiles || []).filter(file => !file.isDirectory);
            if (!current()) { this._refreshExplorerRequested = true; return; }
            this.renderFiles();
            await this._verifyDecryptableFiles(true);
            if (!current()) { this._refreshExplorerRequested = true; return; }
            this.statusEl.innerText = window.DEV_MODE ? `LITTLEFS_READY: ${this.files.length} files` : `${this.files.length} files`;
        }
        catch (error) {
            if (!current()) { this._refreshExplorerRequested = true; return; }
            this.files = [];
            this.parser = null;
            this.renderFiles();
            this.statusEl.innerText = window.DEV_MODE ? 'LITTLEFS_PARSE_FAILED' : 'Could not read the filesystem';
            console.error('File Manager refresh failed:', error);
        }
    }

    /**
     * Render files, preserve selection, and synchronize dependent tiles.
     * @returns {void}
     */
    renderFiles() {
        this.treeEl.innerHTML = '';
        const sorted = [...this.files].sort((a, b) => {
            const ac = /\.crypt$/i.test(a.path);
            const bc = /\.crypt$/i.test(b.path);
            if (ac !== bc) {
                return ac ? -1 : 1;
            }
            return a.path.localeCompare(b.path);
        });
        if (sorted.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'p-4 text-zinc-500 font-mono text-xs';
            empty.innerText = 'No files available';
            this.treeEl.appendChild(empty);
            this.selectedPath = null;
            this.saveBtn.disabled = true;
            this.replaceBtn.disabled = true;
            this.publishSelectedPath(null);
            this._updateFileManagerButtons?.();
            this.syncEditorTileAvailability();
            return;
        }
        sorted.forEach((f) => {
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'file-tree-item';
            row.dataset.path = f.path;
            if (/\.crypt$/i.test(f.path)) {
                row.classList.add('file-crypt');
                if (this._decryptableFiles && this._decryptableFiles.has(f.path)) {
                    row.classList.add('file-crypt-ok');
                }
            }
            if (this.selectedPath === f.path) {
                row.classList.add('selected');
            }
            if (this._recentlyReplacedPath && this._recentlyReplacedPath === f.path) {
                row.classList.add('replaced-recent');
            }
            row.innerHTML =
                `<span>${f.path}</span><span class="text-[10px] text-zinc-500">${f.size} B</span>`;
            row.addEventListener('click', async (e) => {
                e.stopPropagation();
                this._selectionGeneration++;
                this.selectedPath = f.path;
                this.publishSelectedPath(this.selectedPath);
                this.renderFiles();
                await this.syncEditorTileAvailability();
            });
            this.treeEl.appendChild(row);
        });
        const hasSelection = sorted.some((f) => f.path === this.selectedPath);
        if (!hasSelection) {
            this.selectedPath = null;
            this.publishSelectedPath(null);
        }
        else {
            this.publishSelectedPath(this.selectedPath);
        }
        this._updateFileManagerButtons?.();
        this._scheduleDecryptCheck();
        this.updateUuidGuidance();
        this.syncEditorTileAvailability();
    }

    /**
     * Return true for UTF-8 text that can be round-tripped safely through the editor.
     * Empty files count as text; NUL and non-text control bytes reject the file.
     * @param {Uint8Array} bytes
     * @returns {boolean}
     */
    isEditorTextBytes(bytes) {
        if (!(bytes instanceof Uint8Array)) return false;
        for (const byte of bytes) {
            if (byte === 0x00) return false;
            if (byte < 0x20 && ![0x09, 0x0A, 0x0D].includes(byte)) return false;
        }
        try {
            new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            return true;
        }
        catch (_error) {
            return false;
        }
    }

    /**
     * Enable the editor tile only for a selected UTF-8 text file or any .crypt file.
     * @returns {Promise<void>}
     */
    async syncEditorTileAvailability() {
        if (!this.tileManager) return;
        const editor = this.context.navigation.editor.available ? this.context.navigation.editor : null;
        if (!editor) return;

        const path = this.selectedPath || null;
        const image = window.interface, parser = this.parser, generation = this._selectionGeneration;
        const revision = window.AppState.interfaceRevision;
        const current = () => path === (this.selectedPath || null) && image === window.interface &&
            parser === this.parser && generation === this._selectionGeneration &&
            revision === window.AppState.interfaceRevision;
        let eligible = false;

        if (path && this.parser) {
            if (/\.crypt$/i.test(path)) {
                eligible = true;
            }
            else {
                try {
                    const bytes = await parser.readFile(path);
                    eligible = this.isEditorTextBytes(bytes);
                }
                catch (_error) {
                    eligible = false;
                }
            }
        }

        if (!current()) return;
        const previous = window.AppState.fileEditorSelectedPath || null;
        const next = eligible ? path : null;
        window.AppState.fileEditorSelectedPath = next;

        if (previous !== next) {
            window.AppState.fileEditorSelectionRevision =
                Number(window.AppState.fileEditorSelectionRevision || 0) + 1;
        }

        if (eligible) {
            if (!editor.isEnabled()) editor.enable();
        }
        else if (editor.isEnabled()) {
            editor.disable();
        }

        editor.update();
        editor.updateStyles();
    }

    /**
     * Highlight the replaced path and clear the highlight after the existing delay.
     * @param {string|null} path
     * @returns {void}
     */
    markRecentlyReplaced(path) {
        clearTimeout(this._recentlyReplacedTimer);
        this._recentlyReplacedPath = path || null;
        this.renderFiles();
        this._recentlyReplacedTimer = setTimeout(() => {
            this._recentlyReplacedPath = null;
            this.renderFiles();
        }, 1000);
    }

    // === Encrypted blob format and CPU cryptography ===

    /**
     * Decode hexadecimal input using this component's existing validation rules.
     * @param {unknown} hex
     * @returns {Uint8Array}
     */
    hexToBytes(hex) {
        const clean = String(hex || '').replace(/\s+/g, '').toLowerCase();
        if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
            throw new Error('Invalid hex input');
        }
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i += 1) {
            out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /**
     * Split a blob into its padding byte, 16-byte IV, and block-aligned ciphertext.
     * @param {Uint8Array} blobBytes
     * @returns {CryptBlob}
     */
    parseBlob(blobBytes) {
        if (!(blobBytes instanceof Uint8Array) || blobBytes.length < 33) {
            throw new Error('CRYPT_FORMAT_INVALID: need pad_len + 16-byte IV + at least one AES block.');
        }
        const padding = blobBytes[0];
        const iv = blobBytes.slice(1, 17);
        const ciphertext = blobBytes.slice(17);
        if ((ciphertext.length % 16) !== 0) {
            throw new Error('CRYPT_FORMAT_INVALID: ciphertext is not AES block-aligned.');
        }
        if (padding > 16) {
            throw new Error(`CRYPT_FORMAT_INVALID: pad_len ${padding} exceeds one AES block.`);
        }
        return { padding, iv, ciphertext };
    }

    /**
     * Derive the existing extractable AES-CBC-128 key with HKDF-SHA-256.
     * @param {Uint8Array} uuidInput
     * @param {Uint8Array} saltBytes
     * @param {Uint8Array} infoBytes
     * @returns {Promise<CryptoKey>}
     */
    async deriveKeyHkdf(uuidInput, saltBytes, infoBytes) {
        if (!(uuidInput instanceof Uint8Array) || uuidInput.length !== 8) {
            throw new Error('UUID_KEY_INPUT_INVALID: UUID must decode to exactly 8 raw bytes.');
        }
        const inputKeyMaterial = await crypto.subtle.importKey(
            'raw', uuidInput, 'HKDF', false, ['deriveBits']
        );
        const keyBits = await crypto.subtle.deriveBits({
            name: 'HKDF',
            hash: 'SHA-256',
            salt: saltBytes,
            info: infoBytes
        }, inputKeyMaterial, 128);
        return crypto.subtle.importKey(
            'raw',
            keyBits,
            { name: 'AES-CBC' },
            false,
            ['decrypt', 'encrypt']
        );
    }

    /**
     * Recover raw AES-CBC plaintext without interpreting TB2's own trailing padding bytes.
     * WebCrypto always performs PKCS#7 handling, so a synthetic final block is appended only
     * to make WebCrypto return every plaintext byte from the original ciphertext unchanged.
     * @param {CryptoKey} aesKey
     * @param {Uint8Array} iv
     * @param {Uint8Array} ciphertext
     * @returns {Promise<Uint8Array>}
     */
    async decryptAesCbcRaw(aesKey, iv, ciphertext) {
        const lastBlock = ciphertext.slice(ciphertext.length - 16);
        const paddingBlock = new Uint8Array(16).fill(0x10);
        const encryptedPadding = await crypto.subtle.encrypt({ name: 'AES-CBC', iv: lastBlock },
            aesKey, paddingBlock);
        const syntheticFinalBlock = new Uint8Array(encryptedPadding).slice(0, 16);
        const extendedCiphertext = new Uint8Array(ciphertext.length + 16);
        extendedCiphertext.set(ciphertext, 0);
        extendedCiphertext.set(syntheticFinalBlock, ciphertext.length);
        const paddedPlaintext = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, aesKey,
            extendedCiphertext);
        return new Uint8Array(paddedPlaintext);
    }

    /**
     * Derive the key, reject inconsistent zero padding, then remove its declared count.
     * @param {Uint8Array} blobBytes
     * @param {Uint8Array} uuidInput
     * @param {Uint8Array} salt
     * @param {Uint8Array} info
     * @returns {Promise<Uint8Array>}
     */
    async decryptCryptBlob(blobBytes, uuidInput, salt, info) {
        const parsed = this.parseBlob(blobBytes);
        const key = await this.deriveKeyHkdf(uuidInput, salt, info);
        const padded = await this.decryptAesCbcRaw(key, parsed.iv, parsed.ciphertext);
        if (parsed.padding > padded.length) {
            throw new Error(
                `CRYPT_FORMAT_INVALID: pad_len ${parsed.padding} exceeds decrypted length ${padded.length}.`
            );
        }
        if (parsed.padding > 0 && !this.validateZeroPadding(padded, parsed.padding)) {
            throw new Error('UUID_MISMATCH: the file does not match this UUID or its encrypted data is damaged.');
        }
        return parsed.padding === 0
            ? padded
            : padded.slice(0, padded.length - parsed.padding);
    }

    /**
     * Encode the existing zero-padded CBC blob layout with a random IV.
     * @param {Uint8Array} plainBytes
     * @param {Uint8Array} uuidInput
     * @param {Uint8Array} salt
     * @param {Uint8Array} info
     * @returns {Promise<Uint8Array>}
     */
    async encryptPlainAsCryptBlob(plainBytes, uuidInput, salt, info) {
        const key = await this.deriveKeyHkdf(uuidInput, salt, info);
        let padding = (16 - (plainBytes.length % 16)) % 16;
        if (padding === 0) {
            padding = 16;
        }
        const padded = new Uint8Array(plainBytes.length + padding);
        padded.set(plainBytes, 0);
        const iv = crypto.getRandomValues(new Uint8Array(16));
        const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key,
            padded));
        const ciphertext = encrypted.slice(0, padded.length);
        const encryptedBlob = new Uint8Array(1 + 16 + ciphertext.length);
        encryptedBlob[0] = padding & 0xff;
        encryptedBlob.set(iv, 1);
        encryptedBlob.set(ciphertext, 17);
        return encryptedBlob;
    }

    /**
     * Download a byte array through a temporary object URL.
     * @param {Uint8Array} bytes
     * @param {string} name
     * @returns {void}
     */
    downloadBytes(bytes, name) {
        const blob = new Blob([bytes], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /**
     * Check the declared trailing zero padding using the original acceptance rules.
     * @param {Uint8Array} padded
     * @param {number} padding
     * @returns {boolean}
     */
    validateZeroPadding(padded, padding) {
        if (padding === 0 || padding > padded.length) {
            return false;
        }
        for (let i = padded.length - padding; i < padded.length; i++) {
            if (padded[i] !== 0x00) {
                return false;
            }
        }
        return true;
    }

    // === UUID synchronization and verification ===

    /**
     * Debounce encrypted-file verification with the existing 200 ms delay.
     * @returns {void}
     */
    _scheduleDecryptCheck() {
        clearTimeout(this._decryptCheckTimer);
        const requestedGeneration = ++this._decryptScanGeneration;
        this._decryptCheckTimer = setTimeout(
            () => this._verifyDecryptableFiles(false, requestedGeneration),
            200
        );
    }

    /**
     * Normalize the stored UUID, update its input, and return it.
     * @returns {string}
     */
    _syncUuidFromStorage() {

        /**
         * Normalize a persisted UUID to at most 16 uppercase hex characters.
         * @param {unknown} value
         * @returns {string}
         */
        const normalizeUuid = (value) => String(value || '').replace(/[^0-9a-f]/gi,
            '').toUpperCase().slice(0, 16);
        return normalizeUuid(this.context.uuid.normalizedValue);
    }

    /**
     * Reflect the verified-path set in encrypted-file row classes.
     * @returns {void}
     */
    _updateCryptFileClasses() {
        if (!this.treeEl) {
            return;
        }
        const rows = this.treeEl.querySelectorAll('.file-tree-item[data-path]');
        rows.forEach(row => {
            const path = row.dataset.path;
            if (/\.crypt$/i.test(path)) {
                row.classList.toggle('file-crypt-ok', this._decryptableFiles.has(path));
            }
        });
    }

    /**
     * Verify that every .crypt file can be parsed and decrypted with the currently selected UUID.
     *
     * UUID hex -> raw bytes -> HKDF-SHA256(16 bytes) -> AES-128-CBC.
     * Green marking additionally validates the TB2 trailing-zero padding criterion used by
     * UUID detection. The editor itself still removes exactly pad_len bytes after decrypt.
     *
     * Results are published atomically only if UUID, parser, image revision and scan generation
     * still match. This prevents older overlapping scans from changing green file rows.
     *
     * @param {boolean} [forceRescan=false]
     * @param {number|null} [requestedGeneration=null]
     * @returns {Promise<void>}
     */
    async _verifyDecryptableFiles(forceRescan = false, requestedGeneration = null) {
        const scanGeneration = requestedGeneration ?? ++this._decryptScanGeneration;
        if (scanGeneration > this._decryptScanGeneration) {
            this._decryptScanGeneration = scanGeneration;
        }

        const uuidHex = String(this.context.uuid.normalizedValue || '')
            .replace(/[^0-9a-f]/gi, '')
            .toUpperCase();
        const isValidUuid = /^500100[0-9A-F]{10}$/.test(uuidHex);
        const foundCard = this.element.querySelector('.found-card');

        if (foundCard) {
            foundCard.classList.toggle('valid', isValidUuid);
        }

        if (!isValidUuid || !this.parser) {
            if (scanGeneration === this._decryptScanGeneration) {
                this._decryptableFiles = new Set();
                this._lastVerifyUuid = null;
                this._updateCryptFileClasses();
            }
            return;
        }

        const parser = this.parser;
        const image = window.interface;
        const interfaceRevision = Number(window.AppState.interfaceRevision || 0);

        if (!forceRescan &&
            uuidHex === this._lastVerifyUuid &&
            this._lastVerifyRevision === interfaceRevision) {
            this._updateCryptFileClasses();
            return;
        }

        const FIXED_SALT = this.hexToBytes('bc21551317da981e5e4650a7d238ea2c');
        const FIXED_INFO = this.hexToBytes('2469031c2490ad3f3bd1b05cfd5c6681');
        const uuidBytes = this.hexToBytes(uuidHex);

        const newDecryptable = new Set();
        const keyMismatches = new Set();
        const cryptFiles = this.files.filter(file => /\.crypt$/i.test(file.path));

        try {
            for (const file of cryptFiles) {
                if (scanGeneration !== this._decryptScanGeneration) return;
                if (this.parser !== parser ||
                    window.interface !== image ||
                    Number(window.AppState.interfaceRevision || 0) !== interfaceRevision ||
                    String(this.context.uuid.normalizedValue || '').replace(/[^0-9a-f]/gi, '').toUpperCase() !== uuidHex) {
                    return;
                }

                try {
                    const blobBytes = await parser.readFile(file.path);
                    const parsed = this.parseBlob(blobBytes);
                    const key = await this.deriveKeyHkdf(uuidBytes, FIXED_SALT, FIXED_INFO);
                    const padded = await this.decryptAesCbcRaw(
                        key, parsed.iv, parsed.ciphertext
                    );

                    // The green marker is a UUID/key plausibility check, not merely
                    // "AES-CBC returned bytes". TB2 cracking already uses the declared
                    // trailing zero padding as the key-validation criterion.
                    if (this.validateZeroPadding(padded, parsed.padding)) {
                        newDecryptable.add(file.path);
                    } else { keyMismatches.add(file.path); }
                }
                catch (error) {
                    if (error.name === 'OperationError') keyMismatches.add(file.path);
                    // Read and parse failures are not misreported as mismatching UUIDs.
                }
            }
        }
        catch (_error) {
            return;
        }

        if (scanGeneration !== this._decryptScanGeneration ||
            this.parser !== parser ||
            window.interface !== image ||
            Number(window.AppState.interfaceRevision || 0) !== interfaceRevision ||
            String(this.context.uuid.normalizedValue || '').replace(/[^0-9a-f]/gi, '').toUpperCase() !== uuidHex) {
            return;
        }

        this._keyMismatches = keyMismatches;
        this._decryptableFiles = newDecryptable;
        this._lastVerifyUuid = uuidHex;
        this._lastVerifyRevision = interfaceRevision;
        this.updateUuidGuidance();
        this._updateCryptFileClasses();
    }
}
CoreFlasherApp.cardControllers["tile-file-manager"] = CardController;
})();
