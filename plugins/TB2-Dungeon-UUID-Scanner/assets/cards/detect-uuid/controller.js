/* Detect UUID controller. Shared services are supplied by the card context. */
(() => {
// === UUID detection: input blob -> GPU candidates -> CPU verification ===

class CardController extends Tile {
    static LONG_SEARCH_NOTICE_SECONDS = 2 * 60 * 60;

    /**
     * Initialize component fields, event handlers, and state synchronization.
     * @returns {void}
     */
    init() {
        this.context.identity?.bindStatus(this);
        this.searchGeneration = 0;
        this.MAX_HITS = 256;
        this.ALLOWED_BATCH_SIZES = new Set(CoreFlasherUuidConfig.BATCH_SIZES);
        this.UUID_BYTES = 8;
        this.FIXED_SALT_HEX = 'bc21551317da981e5e4650a7d238ea2c';
        this.FIXED_INFO_HEX = '2469031c2490ad3f3bd1b05cfd5c6681';
        this.checkpointKey = 'tonie_uuid_bruteforce_checkpoint_v1';
        this.serialNumberKey = 'tonie_uuid_serial_number_v1';
        this.algorithmKey = CoreFlasherStartup.key('uuid-scan-algorithm');
        this.batchSizeKey = CoreFlasherStartup.key('uuid-scan-batch-size');
        this.workgroupSizeKey = CoreFlasherStartup.key('uuid-scan-workgroup-size');
        this.tuningKey = CoreFlasherStartup.key('uuid-scan-tuning-v1');
        this.algorithm = this.readAlgorithm();
        this._startupCheckpoint = this.readCheckpoint();
        this.FIXED_SALT = this.hexToBytes(this.FIXED_SALT_HEX);
        this.FIXED_INFO = this.hexToBytes(this.FIXED_INFO_HEX);
        this.ui = {
            mask: document.getElementById('ci-mask'),
            algorithm: document.getElementById('ci-algorithm'),
            batchSize: document.getElementById('ci-batchSize'),
            workgroupSize: document.getElementById('ci-workgroupSize'),
            effectiveConfig: document.getElementById('ci-effectiveConfig'),
            performanceDetails: document.getElementById('ci-performanceDetails'),
            recalibrateBtn: document.getElementById('ci-recalibrateBtn'),
            resetTuningBtn: document.getElementById('ci-resetTuningBtn'),
            startBtn: document.getElementById('ci-startBtn'),
            pauseBtn: document.getElementById('ci-pauseBtn'),
            state: document.getElementById('ci-state'),
            rate: document.getElementById('ci-rate'),
            current: document.getElementById('ci-current'),
            eta: document.getElementById('ci-eta'),
            status: document.getElementById('ci-status'),
            progressBar: document.getElementById('ci-progressBar'),
            foundCard: document.getElementById('ci-foundCard'),
            foundUuid: document.getElementById('ci-foundUuid'),
            saveUuidBtn: document.getElementById('ci-saveUuidBtn')
        };
        if (window.DEV_MODE === true && this.ui.performanceDetails) {
            this.ui.performanceDetails.textContent = 'Start a search to measure throughput. Auto changes only settings explicitly set to Auto.';
        }
        this.app = {
            gpu: { session: null, device: null, blobInfo: null, parsed: null, parsedSources: null },
            running: false, paused: false, pauseRequested: false,
            pauseCheckpoint: null, search: null,
            loadedInputBytes: null, imageDirty: false,
            littlefs: { detected: false, cryptFiles: [], parser: null },
            counters: {
                checked: 0, total: 0, startedAt: 0, lastTickAt: 0, lastTickChecked: 0
            }
        };
        this.caSource = { image: undefined, revision: undefined, input: null, generation: 0, task: null };
        this.scannerAttention = false;
        this.ui.source = document.getElementById('uuid-ca-source');
        this.ui.algorithm.value = this.algorithm;
        this.ui.batchSize.value = this.readSearchPreference(this.batchSizeKey,
            [...CoreFlasherUuidConfig.BATCH_SIZES.map(String), 'auto'], String(CoreFlasherUuidConfig.DEFAULTS.batchSize));
        this.ui.workgroupSize.value = this.readSearchPreference(this.workgroupSizeKey,
            [...CoreFlasherUuidConfig.WORKGROUP_SIZES.map(String), 'auto'], String(CoreFlasherUuidConfig.DEFAULTS.workgroupSize));
        for (const name of ['algorithm', 'batchSize', 'workgroupSize']) this.bindSearchPreference(name);
        this.listen(this.ui.recalibrateBtn, 'click', event => {
            event.stopPropagation();
            if (this._searchTask || this._resetting || this.app.running) return;
            this.skipTuningProfile = true;
            this.ui.effectiveConfig.textContent = 'Recalibration requested for the next search. Manual settings remain fixed.';
        });
        this.listen(this.ui.resetTuningBtn, 'click', event => {
            event.stopPropagation();
            if (this._searchTask || this._resetting || this.app.running) return;
            this.resetTuning();
        });
        const showSelectedSettings = () => {
            if (this.app.running) return;
            const algorithm = this.ui.algorithm.options[this.ui.algorithm.selectedIndex]?.textContent || this.algorithm;
            this.ui.effectiveConfig.textContent = `${algorithm} · ${this.ui.batchSize.value === 'auto' ? 'Auto batch' : Number(this.ui.batchSize.value) / (2 ** 20) + 'M batch'} · ${this.ui.workgroupSize.value} threads`;
        };
        for (const name of ['algorithm', 'batchSize', 'workgroupSize']) this.ui[name].addEventListener('change', showSelectedSettings);
        showSelectedSettings();
        this.ui.startBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!this.sourceAllowed()) return;
            try {
                if (this.app.paused) {
                    const checkpoint = this.getStoredCheckpoint();
                    if (!checkpoint) throw new Error('No checkpoint available. Reset scan to start again.');
                    this.ui.mask.value = checkpoint.mask;
                    this.app.pauseRequested = false;
                    await this.startSearch(checkpoint.next);
                } else await this.startSearch();
            }
            catch (err) {
                this.log('Start failed: ' + String(err.message || err), 'bad');
                this.setState('error');
                this.setControlsRunning(false);
            }
        });
        this.ui.pauseBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!this.sourceAllowed()) return;
            if (this.app.running) {
                this.app.pauseRequested = true;
                this.app.running = false;
                this.setState('pausing');
                this.ui.pauseBtn.disabled = true;
                this.log('Pausing search and saving checkpoint...', 'warn');
                return;
            }
            if (this.app.paused) {
                try {
                    const cp = this.getStoredCheckpoint();
                    if (!cp) {
                        throw new Error('No checkpoint available for resume.');
                    }
                    this.ui.mask.value = cp.mask;
                    // A paused search may resume with another batch size or kernel.
                    this.app.paused = true;
                    this.app.pauseRequested = false;
                    await this.startSearch(cp.next);
                }
                catch (err) {
                    this.log('Resume failed: ' + String(err.message || err), 'bad');
                    this.setState('error');
                    this.setControlsRunning(false);
                }
            }
        });
        this.ui.foundUuid.addEventListener('input', () => {
            const before = this.ui.foundUuid.value;
            const normalized = this.setSerialNumberField(before, true);
            if (before !== normalized) {
                const caret = this.ui.foundUuid.selectionStart;
                this.ui.foundUuid.value = normalized;
                if (typeof caret === 'number') {
                    const nextCaret = Math.min(caret, normalized.length);
                    this.ui.foundUuid.setSelectionRange(nextCaret, nextCaret);
                }
            }
            this.refreshUuidSaveButton();
        });

        this.ui.saveUuidBtn?.addEventListener('click', async (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.tileManager.openImageManager({ uuidMode: 'save', uuid: this.ui.foundUuid.value });
        });

        this.listen(this.element.querySelector('#ci-loadUuidBtn'), 'click', event => {
            event.stopPropagation();
            this.tileManager.openImageManager({ uuidMode: 'load' });
        });
        this.listen(this.element.querySelector('#ci-resetBtn'), 'click', event => {
            event.stopPropagation();
            if (!this.app.running && !this._searchTask && !this._resetting) {
                this._startupCheckpoint = null;
                this.resetSearch(true);
            }
        });
        this.loadStoredSerialNumber();
        this.refreshUuidSaveButton();
        this.refreshActionButtons();
        this._syncTimer = setInterval(() => {
            this.syncCaSource();
            if (!this.enabled) {
                return;
            }
            const stored = this.normalizeSerialNumberInput(localStorage.getItem(
                this.serialNumberKey) || '');
            if (stored && stored !== this.ui.foundUuid.value) {
                this.ui.foundUuid.value = stored;
            }
            this.refreshUuidSaveButton();
        }, 700);
        this.syncCaSource();
    }

    /** Only search actions need an image; archive UUID controls remain available without one. */
    updateStyles() {
        super.updateStyles();
        for (const child of this.element.children) child.inert = false;
        this.element.removeAttribute('aria-disabled');
        if (this.ui) { this.refreshActionButtons(); this.refreshUuidSaveButton(); }
    }

    /**
     * Acknowledge attention state and focus this tile.
     * @returns {void}
     */
    focus() {
        super.focus();
        this.scannerAttention = false;
        this.syncCaSource();
        this.updateStyles();
    }

    /**
     * Check the normalized input or stored value against the existing UUID pattern.
     * @returns {boolean}
     */
    isUuidKnown() {
        const value = this.normalizeSerialNumberInput(this.ui.foundUuid.value
            || localStorage.getItem(this.serialNumberKey) || '');
        return /^500100[0-9A-F]{10}$/.test(value);
    }

    /**
     * Evaluate this component's attention condition.
     * @returns {boolean}
     */
    isFlashing() {
        return this.enabled && this.scannerAttention && !this.isUuidKnown();
    }

    /**
     * Describe the current attention condition for diagnostic logging.
     * @returns {string}
     */
    getBlinkReason() {
        return this.isFlashing() ? 'CA source ready or explicit UUID request' : 'no scanner attention request';
    }

    /** Highlight the scanner only for an explicit operation that needs an unknown UUID. */
    requestAttention() {
        if (this.isUuidKnown()) return;
        this.scannerAttention = true;
        this.updateStyles();
    }

    // === Input lifecycle ===

    /**
     * Reset search state and GPU resources when the CA source changes.
     * The name parameter is retained for compatibility; it is not consumed.
     * @param {Uint8Array|null} bytes
     * @param {string|null} name
     * @returns {void}
     */
    loadBlob(bytes, name) {
        this.resetSearch(false);
        this.app.loadedInputBytes = bytes || null;
        this.app.imageDirty = false;
        this.app.gpu.blobInfo = null;
        this.app.gpu.parsed = null;
        this.app.gpu.parsedSources = null;
        this.app.littlefs.parser = null;
        this.app.paused = false;
        this.app.pauseRequested = false;
        this.app.pauseCheckpoint = null;
        this.removeCheckpoint();
        this.stopWebGPU();
        this.refreshActionButtons();
        if (bytes && this._startupCheckpoint) this.validatePendingCheckpoint(bytes);
    }

    /**
     * Check whether the current image revision has a validated CA blob.
     * @returns {boolean}
     */
    hasInputFile() {
        return !!this.caSource.input?.bytes && this.caSource.image === window.interface
            && this.caSource.revision === Number(window.AppState.interfaceRevision || 0);
    }

    /**
     * Parse the CA blob and return the existing single-source collection.
     * @returns {Promise<BlobSource[]>}
     */
    async resolveSelectedBlobSources() {
        const input = this.caSource.input;
        if (!this.hasInputFile()) {
            throw new Error(`No usable ${CoreFlasherUuidConfig.CA_CRYPT_PATH} is available in the current image.`);
        }
        const blobBytes = input.bytes;
        const parsed = this.parseBlob(blobBytes);
        return [{ name: CoreFlasherUuidConfig.CA_CRYPT_PATH, bytes: blobBytes, parsed }];
    }

    /** Display the scanner-owned source state without changing File Manager selection. */
    setCaSourceStatus(message) {
        if (this.ui.source && this.ui.source.textContent !== message) this.ui.source.textContent = message;
    }

    /** Read only the CA blob for the current image revision; discard late reads. */
    async syncCaSource() {
        const image = window.interface || null;
        const revision = Number(window.AppState.interfaceRevision || 0);
        const source = this.caSource;
        if (source.image === image && source.revision === revision) return source.task;

        source.image = image;
        source.revision = revision;
        const generation = ++source.generation;
        source.input = null;
        source.task = null;
        this.scannerAttention = false;
        this.loadBlob(null, null);
        const current = () => generation === source.generation && image === window.interface
            && revision === Number(window.AppState.interfaceRevision || 0);
        if (!image) {
            this.setCaSourceStatus(`Load an image to read ${CoreFlasherUuidConfig.CA_CRYPT_PATH}.`);
            this.updateStyles();
            return;
        }

        this.setCaSourceStatus(`Reading ${CoreFlasherUuidConfig.CA_CRYPT_PATH}...`);
        const task = (async () => {
            try {
                const parser = new LittleFSParser(image, FirmwareImage.LFS, image.size - FirmwareImage.LFS);
                await parser.initialize();
                if (!current()) return;
                const path = CoreFlasherUuidConfig.CA_CRYPT_PATH;
                if (!(await parser.fs._resolvePath(path))?.entry) {
                    throw new Error('CA file is missing.');
                }
                if (!current()) return;
                const bytes = await parser.readFile(path);
                if (!current()) return;
                CoreFlasherUuidSearch.validateBlob(this.parseBlob(bytes), this.FIXED_SALT, this.FIXED_INFO);
                source.input = { bytes, name: path };
                this.loadBlob(bytes, path);
                this.setCaSourceStatus(`Scanner source: ${path}`);
                this.scannerAttention = !this.isFocused && !this.isUuidKnown();
                this.updateStyles();
            } catch (error) {
                if (!current()) return;
                this.setCaSourceStatus(`Cannot use ${CoreFlasherUuidConfig.CA_CRYPT_PATH}: ${error.message || error}`);
                this.refreshActionButtons();
            }
        })();
        source.task = task.finally(() => {
            if (generation === source.generation) source.task = null;
        });
        return source.task;
    }

    // === Binary and display utilities ===

    /**
     * Decode hexadecimal input using this component's existing validation rules.
     * @param {unknown} hex
     * @returns {Uint8Array}
     */
    hexToBytes(hex) {
        const clean = String(hex || '').trim().toLowerCase().replace(/\s+/g, '');
        if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
            throw new Error('Invalid hex string: ' + hex);
        }
        const out = new Uint8Array(clean.length / 2);
        for (let i = 0; i < out.length; i++) {
            out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /**
     * Format bytes as lowercase hexadecimal without separators.
     * @param {Iterable<number>} bytes
     * @returns {string}
     */
    bytesToHex(bytes) {
        return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
    }

    /**
     * Split a blob into its padding byte, 16-byte IV, and block-aligned ciphertext.
     * @param {Uint8Array} blobBytes
     * @returns {CryptBlob}
     */
    parseBlob(blobBytes) {
        if (!blobBytes || blobBytes.length < 18) {
            throw new Error('Blob too small. Need at least 18 bytes.');
        }
        const padding = blobBytes[0];
        const iv = blobBytes.slice(1, 17);
        const ciphertext = blobBytes.slice(17);
        if (ciphertext.length % 16 !== 0) {
            throw new Error('Ciphertext length ' + ciphertext.length
                + ' is not AES-CBC block-aligned.');
        }
        return { padding, iv, ciphertext };
    }

    /**
     * Pack bytes into big-endian uint32 words, zero-filling an incomplete final word.
     * @param {Uint8Array} bytes
     * @returns {number[]}
     */
    bytesToWords(bytes) {
        const words = new Uint32Array(Math.ceil(bytes.length / 4));
        for (let i = 0; i < bytes.length; i++) {
            words[i >>> 2] |= bytes[i] << (24 - (i & 3) * 8);
        }
        return Array.from(words);
    }

    /**
     * Escape the five characters used in generated HTML text.
     * @param {unknown} text
     * @returns {string}
     */
    escapeHtml(text) {
        return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g,
            '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    /**
     * Format a nonnegative signed-32-bit-coerced duration as hours, minutes, and seconds.
     * @param {number} sec
     * @returns {string}
     */
    formatSeconds(sec) {
        const s = Math.max(0, sec | 0);
        return Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm ' + (s % 60) + 's';
    }

    // === Persistent UUID state ===

    /**
     * Remove non-hex characters, uppercase, and retain at most 16 characters.
     * @param {unknown} value
     * @returns {string}
     */
    normalizeSerialNumberInput(value) {
        return String(value || '').replace(/[^0-9a-f]/gi, '').toUpperCase().slice(0, 16);
    }

    /**
     * Update the UUID field and optionally persist and broadcast a changed value.
     * @param {unknown} value
     * @param {boolean} persist
     * @returns {string}
     */
    setSerialNumberField(value, persist) {
        const normalized = this.context.uuid.setSerialNumberField(value, persist);
        this.ui.foundUuid.value = normalized;
        this.ui.foundCard?.classList.toggle('valid', normalized.length === 16);
        this.refreshUuidSaveButton();
        return normalized;
    }

    /**
     * Load the persisted UUID without writing it back.
     * @returns {void}
     */
    loadStoredSerialNumber() {
        const stored = localStorage.getItem(this.serialNumberKey) || '';
        this.setSerialNumberField(stored, false);
    }

    /**
     * Synchronize this component with the shared application state.
     * @returns {void}
     */
    update() {
        this.syncCaSource();
        const stored = localStorage.getItem(this.serialNumberKey) || '';
        this.setSerialNumberField(stored, false);
        this.refreshUuidSaveButton();
    }

    /**
     * Archive actions need a plugin connection and a valid shared UUID, never image write mode.
     * @returns {void}
     */
    refreshUuidSaveButton() {
        const button = this.ui?.saveUuidBtn;
        if (!button) return;
        const available = typeof window.CoreFlasherImageStorage === 'function';
        button.classList.remove('hidden');
        button.disabled = !this.isUuidKnown() || !available || this.app.running || this._resetting || !!this._searchTask;
        button.title = available ? 'Save this UUID for a box in Image Manager.' : 'Available in the TeddyCloud plugin.';
        const load = this.element.querySelector('#ci-loadUuidBtn');
        if (load) { load.disabled = !available || this.app.running || this._resetting || !!this._searchTask; load.title = button.title; }
    }

    /** One task includes GPU preparation, searching and cleanup, so reset can await all of it. */
    async startSearch(counter) {
        if (this._searchTask || this._resetting) return;
        const generation = this.searchGeneration;
        const source = this.captureSearchSource();
        this._searchTask = (async () => {
            try {
                await this.initializeGpuForCurrentSelection(source);
                if (!this.isSearchCurrent(generation, source)) return;
                await this.runBruteforce(counter, source);
            } catch (error) {
                if (generation === this.searchGeneration) throw error;
            }
        })();
        this.refreshActionButtons();
        try { await this._searchTask; }
        finally {
            this.stopWebGPU();
            this._searchTask = null;
            if (generation === this.searchGeneration && !this.isSearchCurrent(generation, source)) this.resetSearch(false);
            this.refreshActionButtons();
            this.refreshUuidSaveButton();
        }
    }

    /** Guard the source directly as well as its UI generation; a delayed card refresh is not a lock. */
    captureSearchSource() {
        return { bytes: this.caSource.input?.bytes, inputVersion: this.caSource.generation,
            image: window.interface, revision: window.AppState.interfaceRevision };
    }
    isSearchCurrent(generation, source) {
        const current = this.captureSearchSource();
        return generation === this.searchGeneration && Object.keys(current).every(key => current[key] === source[key]);
    }

    /** Invalidate pending results before clearing UI; old finalizers cannot recreate a checkpoint. */
    resetSearch(clearUuid = true) {
        this.searchGeneration = (this.searchGeneration || 0) + 1;
        this.app.running = false;
        this.app.paused = false;
        this.app.pauseRequested = false;
        this.app.pauseCheckpoint = null;
        this.app.search = null;
        this.closeExpansionNotice();
        this.closeLongSearchNotice();
        this.longSearchNoticeShown = false;
        this.renderSearchStage();
        this.successfulSearch = null;
        this.performanceDisplay = null;
        this.removeCheckpoint();
        this.app.counters = { checked: 0, total: 0, startedAt: 0, lastTickAt: 0, lastTickChecked: 0 };
        this._resetting = !!this._searchTask;
        this.stopWebGPU();
        this.app.gpu.blobInfo = null;
        this.app.gpu.parsedSources = null;
        if (clearUuid) this.setSerialNumberField('', true);
        this.ui.status.textContent = '';
        this.ui.rate.textContent = '0';
        this.ui.eta.textContent = '-';
        this.ui.progressBar.style.width = '0%';
        if (this.ui.effectiveConfig) this.ui.effectiveConfig.textContent = 'Ready. Search settings and tuning profiles are unchanged.';
        if (this.ui.performanceDetails) this.ui.performanceDetails.textContent = window.DEV_MODE === true
            ? 'Start a search to measure throughput.' : '';
        this.renderCurrentUuid('-');
        this.setState('idle');
        this.setControlsRunning(false);
        // Allow a new run only after an old initialization or readback has released its resources.
        const pending = this._searchTask;
        if (pending) pending.catch(() => {}).finally(() => {
            this.stopWebGPU();
            this._resetting = false;
            this.refreshActionButtons();
            this.refreshUuidSaveButton();
        });
        this.refreshUuidSaveButton();
    }

    /**
     * Return the shared parser for the currently selected SparseImage.
     * @returns {Promise<LittleFSParser>}
     */
    async getUuidLittleFsParser() {
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

    /**
     * Save the normalized MCU UUID as the root LittleFS file /uuid.
     *
     * Missing file: create without warning.
     * Same content: no-op.
     * Different existing content: require explicit overwrite confirmation.
     *
     * The file contains exactly 16 uppercase ASCII hex characters, without a newline.
     * @returns {Promise<void>}
     */
    async saveUuidToLittleFs() {
        if (!this.sourceAllowed()) return;
        const uuid = this.normalizeSerialNumberInput(this.ui.foundUuid.value);
        if (!/^500100[0-9A-F]{10}$/.test(uuid)) {
            this.log('UUID file save refused: no recognized UUID.', 'warn');
            return { ok: false, status: 'invalid' };
        }

        const image = window.interface;
        if (!image || window.AppState.interfaceMode !== 'rw-buffered' || image.readOnly) {
            this.log('UUID file save requires Read / Write Buffered mode.', 'warn');
            this.refreshUuidSaveButton();
            return { ok: false, status: 'write-disabled' };
        }

        const button = this.ui.saveUuidBtn;
        if (button) button.disabled = true;

        try {
            const parser = await this.getUuidLittleFsParser();
            if (parser.sparseImage !== image) {
                throw new Error('Source image changed while preparing /uuid.');
            }

            const path = '/uuid';
            const desired = new TextEncoder().encode(uuid);
            const resolved = await parser.fs._resolvePath(path);
            let result;
            let action;

            if (resolved) {
                if (resolved.entry?.type !== 0x001) {
                    throw new Error('/uuid exists but is not a regular file.');
                }

                const existing = await parser.readFile(path);
                const identical =
                    existing.length === desired.length &&
                    existing.every((value, index) => value === desired[index]);

                if (identical) {
                    this.log(`UUID_FILE_UNCHANGED: ${path} already contains ${uuid}.`, 'ok');
                    return { ok: true, status: 'unchanged', path, uuid };
                }

                let existingText;
                try {
                    existingText = new TextDecoder().decode(existing);
                }
                catch (_error) {
                    existingText = Array.from(existing)
                        .map(byte => byte.toString(16).padStart(2, '0'))
                        .join(' ');
                }

                const confirmed = window.confirm(
                    `Warning: ${path} already exists with different content.\n\n` +
                    `Existing: ${existingText || '(empty)'}\n` +
                    `New UUID: ${uuid}\n\n` +
                    `Overwrite ${path} in the buffered LittleFS image?`
                );
                if (!confirmed) {
                    this.log('UUID_FILE_OVERWRITE_CANCELLED.', 'warn');
                    return { ok: false, status: 'cancelled', path, uuid };
                }

                result = await parser.writeFileChecked(path, desired, existing);
                action = 'overwritten';
            }
            else {
                result = await parser.addFile(path, desired);
                action = 'created';
            }

            if (!result?.success) {
                throw new Error(result?.error || `Failed to ${action} ${path}.`);
            }

            const verify = await parser.readFile(path);
            const verified =
                verify.length === desired.length &&
                verify.every((value, index) => value === desired[index]);
            if (!verified) {
                throw new Error('UUID_FILE_VERIFY_FAILED: buffered read-back differs.');
            }

            window.AppState.interfaceRevision =
                Number(window.AppState.interfaceRevision || 0) + 1;
            this.tileManager?.broadcastUpdate(this);

            this.log(
                action === 'created'
                    ? `UUID_FILE_CREATED_BUFFERED: ${path} = ${uuid}`
                    : `UUID_FILE_OVERWRITTEN_BUFFERED: ${path} = ${uuid}`,
                'ok'
            );
            return { ok: true, status: action, path, uuid };
        }
        catch (error) {
            this.log(`UUID_FILE_SAVE_FAILED: ${String(error?.message || error)}`, 'bad');
            return {
                ok: false,
                status: 'failed',
                error: String(error?.message || error)
            };
        }
        finally {
            this.refreshUuidSaveButton();
        }
    }

    // === Status output ===

    /**
     * Append a timestamped status line and scroll to the latest message.
     * @param {string} message
     * @param {'ok'|'bad'|'warn'|undefined} cssClass
     * @returns {void}
     */
    log(message, cssClass) {
        const line = '[' + new Date().toLocaleTimeString() + '] ' + message;
        const span = document.createElement('span');
        if (cssClass === 'ok') {
            span.className = 'ci-log-ok';
        }
        if (cssClass === 'bad') {
            span.className = 'ci-log-bad';
        }
        if (cssClass === 'warn') {
            span.className = 'ci-log-warn';
        }
        span.textContent = line + '\n';
        this.ui.status.appendChild(span);
        this.ui.status.scrollTop = this.ui.status.scrollHeight;
    }

    /**
     * Update the search state label.
     * @param {string} text
     * @returns {void}
     */
    setState(text) {
        this.ui.state.textContent = text;
    }

    // === Search configuration ===

    /**
     * Parse a 16-character hex/X mask with one to ten unknown nibbles.
     * @param {string} maskStr
     * @returns {ParsedMask}
     */
    parseMask(maskStr) {
        const normalizedMask = maskStr.trim().toUpperCase();
        if (normalizedMask.length !== 16) {
            throw new Error('UUID mask must be exactly 16 characters (got ' + normalizedMask.length
                + ').');
        }
        if (/[^0-9A-FX]/.test(normalizedMask)) {
            throw new Error(
                'UUID mask may only contain hex digits 0-9 A-F and X for unknown nibbles.');
        }
        const nibbles = [];
        const unknownPositions = [];
        for (let i = 0; i < 16; i++) {
            if (normalizedMask[i] === 'X') {
                nibbles.push(null);
                unknownPositions.push(i);
            }
            else {
                nibbles.push(normalizedMask[i].toLowerCase());
            }
        }
        if (unknownPositions.length === 0) {
            throw new Error('UUID mask has no unknown nibbles (X). Nothing to brute-force.');
        }
        if (unknownPositions.length > 10) {
            throw new Error(
                'UUID mask has more than 10 unknown nibbles. This build supports up to 40 bits.');
        }
        return { nibbles, unknownPositions };
    }

    /**
     * Substitute hexadecimal digits without truncating the combined 40-bit counter.
     * @param {UuidNibbles} nibbles
     * @param {number[]} unknownPositions
     * @param {number} counter
     * @returns {string}
     */
    buildUuidFromCounter(nibbles, unknownPositions, counter) {
        const uuidNibbles = nibbles.slice();
        const unknownCount = unknownPositions.length;
        for (let i = 0; i < unknownCount; i++) {
            const shift = unknownCount - 1 - i;
            const nibble = Math.floor(counter / (16 ** shift)) % 16;
            uuidNibbles[unknownPositions[i]] = nibble.toString(16);
        }
        return uuidNibbles.join('');
    }

    /**
     * Apply high hexadecimal digits before dispatching the remaining GPU nibbles.
     * @param {UuidNibbles} nibbles
     * @param {number[]} unknownPositions
     * @param {number} prefixNibbles
     * @param {number} prefixValue
     * @returns {UuidNibbles}
     */
    withPrefixFixed(nibbles, unknownPositions, prefixNibbles, prefixValue) {
        const prefixedNibbles = nibbles.slice();
        for (let i = 0; i < prefixNibbles; i++) {
            const shift = prefixNibbles - 1 - i;
            const nibble = Math.floor(prefixValue / (16 ** shift)) % 16;
            prefixedNibbles[unknownPositions[i]] = nibble.toString(16);
        }
        return prefixedNibbles;
    }

    /**
     * Select the trailing unknown positions affected by the batch span.
     * @param {number[]} unknownPositions
     * @param {number} batchCount
     * @returns {number[]}
     */
    computeBatchChangingPositions(unknownPositions, batchCount) {
        if (!Array.isArray(unknownPositions) || unknownPositions.length === 0 || batchCount <= 1) {
            return [];
        }
        const span = Math.max(2, Number(batchCount));
        const changingCount = Math.max(1, Math.ceil(Math.log(span) / Math.log(16)));
        const take = Math.min(unknownPositions.length, changingCount);
        return unknownPositions.slice(unknownPositions.length - take);
    }

    /**
     * Validate mask and batch settings and assemble the existing search configuration.
     * @returns {SearchConfig}
     */
    validateInputs() {
        const { nibbles, unknownPositions } = this.parseMask(this.ui.mask.value);
        const numUnknown = unknownPositions.length;
        const start = 0;
        const end = (16 ** numUnknown) - 1;
        const batchSize = this.ui.batchSize.value === 'auto' ? 'auto' : Number(this.ui.batchSize.value);
        if (batchSize !== 'auto' && (!Number.isInteger(batchSize) || !this.ALLOWED_BATCH_SIZES.has(batchSize))) {
            throw new Error('Batch size must be Auto or one of the preset values (4K..64M).');
        }
        const workgroupValue = this.ui.workgroupSize?.value || String(CoreFlasherUuidConfig.DEFAULTS.workgroupSize);
        const workgroupSize = workgroupValue === 'auto' ? 'auto' : Number(workgroupValue);
        if (workgroupSize !== 'auto' && !CoreFlasherUuidConfig.WORKGROUP_SIZES.includes(workgroupSize)) {
            throw new Error('Threads per workgroup must be Auto, 64, 128 or 256.');
        }
        if (this.algorithm !== 'auto' && !CoreFlasherUuidSearch.ALGORITHMS.includes(this.algorithm || 'legacy-v1')) {
            throw new Error('Unsupported UUID search algorithm.');
        }
        return {
            nibbles, unknownPositions, numUnknown, start, end, batchSize, workgroupSize, salt: this.FIXED_SALT,
                info: this.FIXED_INFO
        };
    }

    // === GPU mask packing ===

    /**
     * Pack fixed nibbles and unknown positions into the existing GPU mask words.
     * @param {UuidNibbles} nibbles
     * @param {number[]} unknownPositions
     * @returns {GpuMask}
     */
    packMaskForGPU(nibbles, unknownPositions) {
        let f0 = 0, f1 = 0;
        for (let i = 0; i < 8; i++) {
            const nibbleValue = nibbles[i] !== null ? parseInt(nibbles[i], 16) : 0;
            f0 = (f0 | (nibbleValue << ((7 - i) * 4))) >>> 0;
        }
        for (let i = 8; i < 16; i++) {
            const nibbleValue = nibbles[i] !== null ? parseInt(nibbles[i], 16) : 0;
            f1 = (f1 | (nibbleValue << ((15 - i) * 4))) >>> 0;
        }
        let xMask = 0;
        for (const pos of unknownPositions) {
            xMask = (xMask | (1 << pos)) >>> 0;
        }
        return { f0, f1, xMask };
    }

    // === WGSL source generation ===

    /**
     * Generate the original WGSL program with its constants and byte layout unchanged.
     * @param {number[]} cbcPairWords
     * @param {number} padding
     * @param {Uint8Array} salt
     * @param {Uint8Array} info
     * @param {number} f0
     * @param {number} f1
     * @param {number} xMask
     * @param {number} unknownCount
     * @returns {string}
     */
    makeShaderCode(cbcPairWords, padding, salt, info, f0, f1, xMask, unknownCount) {

        /**
         * Format numeric words as the original WGSL uint32 array literal.
         * @param {number[]} arr
         * @returns {string}
         */
        const wgslU32Array = (arr) => `array<u32,${arr.length}>(${arr.map(v => `0x${v.toString(
            16).padStart(8, '0')}u`).join(',')})`;
        if (cbcPairWords.length !== 8) {
            throw new Error(`Expected 8 u32 words for CBC pair, got ${cbcPairWords.length}.`);
        }
        const MAX_HITS = this.MAX_HITS;
        return `
struct Params { batchStart : u32, batchCount : u32, };
const FIXED_NIB0  : u32 = 0x${(f0 >>> 0).toString(16).padStart(8, '0')}u;
const FIXED_NIB1  : u32 = 0x${(f1 >>> 0).toString(16).padStart(8, '0')}u;
const UUID_XMASK  : u32 = 0x${(xMask >>> 0).toString(16).padStart(8, '0')}u;
const UUID_UNK_CNT: u32 = ${unknownCount >>> 0}u;
@group(0) @binding(0) var<uniform>            params : Params;
@group(0) @binding(1) var<storage,read_write> hits   : array<atomic<u32>>;
const K = array<u32,64>(
  0x428a2f98u,0x71374491u,0xb5c0fbcfu,0xe9b5dba5u,
  0x3956c25bu,0x59f111f1u,0x923f82a4u,0xab1c5ed5u,
  0xd807aa98u,0x12835b01u,0x243185beu,0x550c7dc3u,
  0x72be5d74u,0x80deb1feu,0x9bdc06a7u,0xc19bf174u,
  0xe49b69c1u,0xefbe4786u,0x0fc19dc6u,0x240ca1ccu,
  0x2de92c6fu,0x4a7484aau,0x5cb0a9dcu,0x76f988dau,
  0x983e5152u,0xa831c66du,0xb00327c8u,0xbf597fc7u,
  0xc6e00bf3u,0xd5a79147u,0x06ca6351u,0x14292967u,
  0x27b70a85u,0x2e1b2138u,0x4d2c6dfcu,0x53380d13u,
  0x650a7354u,0x766a0abbu,0x81c2c92eu,0x92722c85u,
  0xa2bfe8a1u,0xa81a664bu,0xc24b8b70u,0xc76c51a3u,
  0xd192e819u,0xd6990624u,0xf40e3585u,0x106aa070u,
  0x19a4c116u,0x1e376c08u,0x2748774cu,0x34b0bcb5u,
  0x391c0cb3u,0x4ed8aa4au,0x5b9cca4fu,0x682e6ff3u,
  0x748f82eeu,0x78a5636fu,0x84c87814u,0x8cc70208u,
  0x90befffau,0xa4506cebu,0xbef9a3f7u,0xc67178f2u
);
fn rotr32(x: u32, n: u32) -> u32 { return (x >> n) | (x << (32u - n)); }
fn ch(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (~x & z); }
fn maj(x: u32, y: u32, z: u32) -> u32 { return (x & y) ^ (x & z) ^ (y & z); }
fn Sigma0(x: u32) -> u32 { return rotr32(x,2u) ^ rotr32(x,13u) ^ rotr32(x,22u); }
fn Sigma1(x: u32) -> u32 { return rotr32(x,6u) ^ rotr32(x,11u) ^ rotr32(x,25u); }
fn sigma0(x: u32) -> u32 { return rotr32(x,7u) ^ rotr32(x,18u) ^ (x >> 3u); }
fn sigma1(x: u32) -> u32 { return rotr32(x,17u) ^ rotr32(x,19u) ^ (x >> 10u); }
fn sha256_block(state: ptr<function,array<u32,8>>, w_in: array<u32,16>) {
  var w: array<u32,64>;
  for (var i=0u; i<16u; i++) { w[i]=w_in[i]; }
  for (var i=16u; i<64u; i++) { w[i]=sigma1(w[i-2u])+w[i-7u]+sigma0(w[i-15u])+w[i-16u]; }
  var a=(*state)[0]; var b=(*state)[1]; var c=(*state)[2]; var d=(*state)[3];
  var e=(*state)[4]; var f=(*state)[5]; var g=(*state)[6]; var h=(*state)[7];
  for (var i=0u; i<64u; i++) {
    let T1=h+Sigma1(e)+ch(e,f,g)+K[i]+w[i]; let T2=Sigma0(a)+maj(a,b,c);
    h=g; g=f; f=e; e=d+T1; d=c; c=b; b=a; a=T1+T2;
  }
  (*state)[0]+=a; (*state)[1]+=b; (*state)[2]+=c; (*state)[3]+=d;
  (*state)[4]+=e; (*state)[5]+=f; (*state)[6]+=g; (*state)[7]+=h;
}
fn sha256_init(state: ptr<function,array<u32,8>>) {
  (*state)[0]=0x6a09e667u; (*state)[1]=0xbb67ae85u;
  (*state)[2]=0x3c6ef372u; (*state)[3]=0xa54ff53au;
  (*state)[4]=0x510e527fu; (*state)[5]=0x9b05688cu;
  (*state)[6]=0x1f83d9abu; (*state)[7]=0x5be0cd19u;
}
fn sha256_finalize_1block(state: ptr<function,array<u32,8>>, w_partial: array<u32,16>, msgLen: u32) {
  var w=w_partial;
  let blockOff=msgLen&63u; let byteOff=blockOff&3u; let wordOff=blockOff>>2u;
  w[wordOff]=w[wordOff]|(0x80u<<(24u-byteOff*8u));
  for (var i=wordOff+1u; i<14u; i++) { w[i]=0u; }
  w[14]=0u; w[15]=msgLen*8u;
  sha256_block(state,w);
}
fn sha256_64plus8(first_block: array<u32,16>, tail2: array<u32,2>) -> array<u32,8> {
  var state: array<u32,8>; sha256_init(&state); sha256_block(&state,first_block);
  var w: array<u32,16>; w[0]=tail2[0]; w[1]=tail2[1];
  sha256_finalize_1block(&state,w,72u); return state;
}
fn sha256_64plus32(first_block: array<u32,16>, inner: array<u32,8>) -> array<u32,8> {
  var state: array<u32,8>; sha256_init(&state); sha256_block(&state,first_block);
  var w: array<u32,16>;
  for (var i=0u; i<8u; i++) { w[i]=inner[i]; }
  sha256_finalize_1block(&state,w,96u); return state;
}
fn hmac_sha256_key16_msg8(key: array<u32,4>, msg: array<u32,2>) -> array<u32,8> {
  var ipad: array<u32,16>; var opad: array<u32,16>;
  for (var i=0u; i<16u; i++) { ipad[i]=0x36363636u; opad[i]=0x5c5c5c5cu; }
  for (var i=0u; i<4u; i++) { ipad[i]^=key[i]; opad[i]^=key[i]; }
  let inner=sha256_64plus8(ipad,msg);
  return sha256_64plus32(opad,inner);
}
fn hmac_sha256_key32_msg20(key: array<u32,8>, msg20: array<u32,5>) -> array<u32,8> {
  var ipad: array<u32,16>; var opad: array<u32,16>;
  for (var i=0u; i<16u; i++) { ipad[i]=0x36363636u; opad[i]=0x5c5c5c5cu; }
  for (var i=0u; i<8u; i++) { ipad[i]^=key[i]; opad[i]^=key[i]; }
  var state: array<u32,8>; sha256_init(&state); sha256_block(&state,ipad);
  var w2: array<u32,16>;
  for (var i=0u; i<5u; i++) { w2[i]=msg20[i]; }
  sha256_finalize_1block(&state,w2,81u);
  return sha256_64plus32(opad,state);
}
const SALT = ${wgslU32Array((() => {
            const a = [];
            for (let i = 0; i < salt.length; i += 4) {
                a.push(((salt[i] << 24) | (salt[i + 1] << 16) | (salt[i + 2] << 8) | salt[i
                    + 3]) >>> 0);
            }
            return a;
        })())};
const INFO_WORD0 = ${((i) => (i[0] << 24) | (i[1] << 16) | (i[2] << 8) | i[3])(info) >>> 0}u;
const INFO_WORD1 = ${((i) => (i[4] << 24) | (i[5] << 16) | (i[6] << 8) | i[7])(info) >>> 0}u;
const INFO_WORD2 = ${((i) => (i[8] << 24) | (i[9] << 16) | (i[10] << 8) | i[11])(info) >>> 0}u;
const INFO_WORD3 = ${((i) => (i[12] << 24) | (i[13] << 16) | (i[14] << 8) | i[15])(info) >>> 0}u;
const BLOB_PADDING : u32 = ${padding}u;
fn hkdf_extract(ikm: array<u32,2>) -> array<u32,8> { return hmac_sha256_key16_msg8(SALT,ikm); }
fn hkdf_expand_16(prk: array<u32,8>) -> array<u32,4> {
  var msg: array<u32,5>;
  msg[0]=INFO_WORD0; msg[1]=INFO_WORD1; msg[2]=INFO_WORD2; msg[3]=INFO_WORD3; msg[4]=0x01000000u;
  let t1=hmac_sha256_key32_msg20(prk,msg);
  return array<u32,4>(t1[0],t1[1],t1[2],t1[3]);
}
const SBOX = array<u32,256>(
  0x63u,0x7cu,0x77u,0x7bu,0xf2u,0x6bu,0x6fu,0xc5u,0x30u,0x01u,0x67u,0x2bu,0xfeu,0xd7u,0xabu,0x76u,
  0xcau,0x82u,0xc9u,0x7du,0xfau,0x59u,0x47u,0xf0u,0xadu,0xd4u,0xa2u,0xafu,0x9cu,0xa4u,0x72u,0xc0u,
  0xb7u,0xfdu,0x93u,0x26u,0x36u,0x3fu,0xf7u,0xccu,0x34u,0xa5u,0xe5u,0xf1u,0x71u,0xd8u,0x31u,0x15u,
  0x04u,0xc7u,0x23u,0xc3u,0x18u,0x96u,0x05u,0x9au,0x07u,0x12u,0x80u,0xe2u,0xebu,0x27u,0xb2u,0x75u,
  0x09u,0x83u,0x2cu,0x1au,0x1bu,0x6eu,0x5au,0xa0u,0x52u,0x3bu,0xd6u,0xb3u,0x29u,0xe3u,0x2fu,0x84u,
  0x53u,0xd1u,0x00u,0xedu,0x20u,0xfcu,0xb1u,0x5bu,0x6au,0xcbu,0xbeu,0x39u,0x4au,0x4cu,0x58u,0xcfu,
  0xd0u,0xefu,0xaau,0xfbu,0x43u,0x4du,0x33u,0x85u,0x45u,0xf9u,0x02u,0x7fu,0x50u,0x3cu,0x9fu,0xa8u,
  0x51u,0xa3u,0x40u,0x8fu,0x92u,0x9du,0x38u,0xf5u,0xbcu,0xb6u,0xdau,0x21u,0x10u,0xffu,0xf3u,0xd2u,
  0xcdu,0x0cu,0x13u,0xecu,0x5fu,0x97u,0x44u,0x17u,0xc4u,0xa7u,0x7eu,0x3du,0x64u,0x5du,0x19u,0x73u,
  0x60u,0x81u,0x4fu,0xdcu,0x22u,0x2au,0x90u,0x88u,0x46u,0xeeu,0xb8u,0x14u,0xdeu,0x5eu,0x0bu,0xdbu,
  0xe0u,0x32u,0x3au,0x0au,0x49u,0x06u,0x24u,0x5cu,0xc2u,0xd3u,0xacu,0x62u,0x91u,0x95u,0xe4u,0x79u,
  0xe7u,0xc8u,0x37u,0x6du,0x8du,0xd5u,0x4eu,0xa9u,0x6cu,0x56u,0xf4u,0xeau,0x65u,0x7au,0xaeu,0x08u,
  0xbau,0x78u,0x25u,0x2eu,0x1cu,0xa6u,0xb4u,0xc6u,0xe8u,0xddu,0x74u,0x1fu,0x4bu,0xbdu,0x8bu,0x8au,
  0x70u,0x3eu,0xb5u,0x66u,0x48u,0x03u,0xf6u,0x0eu,0x61u,0x35u,0x57u,0xb9u,0x86u,0xc1u,0x1du,0x9eu,
  0xe1u,0xf8u,0x98u,0x11u,0x69u,0xd9u,0x8eu,0x94u,0x9bu,0x1eu,0x87u,0xe9u,0xceu,0x55u,0x28u,0xdfu,
  0x8cu,0xa1u,0x89u,0x0du,0xbfu,0xe6u,0x42u,0x68u,0x41u,0x99u,0x2du,0x0fu,0xb0u,0x54u,0xbbu,0x16u
);
const INV_SBOX = array<u32,256>(
  0x52u,0x09u,0x6au,0xd5u,0x30u,0x36u,0xa5u,0x38u,0xbfu,0x40u,0xa3u,0x9eu,0x81u,0xf3u,0xd7u,0xfbu,
  0x7cu,0xe3u,0x39u,0x82u,0x9bu,0x2fu,0xffu,0x87u,0x34u,0x8eu,0x43u,0x44u,0xc4u,0xdeu,0xe9u,0xcbu,
  0x54u,0x7bu,0x94u,0x32u,0xa6u,0xc2u,0x23u,0x3du,0xeeu,0x4cu,0x95u,0x0bu,0x42u,0xfau,0xc3u,0x4eu,
  0x08u,0x2eu,0xa1u,0x66u,0x28u,0xd9u,0x24u,0xb2u,0x76u,0x5bu,0xa2u,0x49u,0x6du,0x8bu,0xd1u,0x25u,
  0x72u,0xf8u,0xf6u,0x64u,0x86u,0x68u,0x98u,0x16u,0xd4u,0xa4u,0x5cu,0xccu,0x5du,0x65u,0xb6u,0x92u,
  0x6cu,0x70u,0x48u,0x50u,0xfdu,0xedu,0xb9u,0xdau,0x5eu,0x15u,0x46u,0x57u,0xa7u,0x8du,0x9du,0x84u,
  0x90u,0xd8u,0xabu,0x00u,0x8cu,0xbcu,0xd3u,0x0au,0xf7u,0xe4u,0x58u,0x05u,0xb8u,0xb3u,0x45u,0x06u,
  0xd0u,0x2cu,0x1eu,0x8fu,0xcau,0x3fu,0x0fu,0x02u,0xc1u,0xafu,0xbdu,0x03u,0x01u,0x13u,0x8au,0x6bu,
  0x3au,0x91u,0x11u,0x41u,0x4fu,0x67u,0xdcu,0xeau,0x97u,0xf2u,0xcfu,0xceu,0xf0u,0xb4u,0xe6u,0x73u,
  0x96u,0xacu,0x74u,0x22u,0xe7u,0xadu,0x35u,0x85u,0xe2u,0xf9u,0x37u,0xe8u,0x1cu,0x75u,0xdfu,0x6eu,
  0x47u,0xf1u,0x1au,0x71u,0x1du,0x29u,0xc5u,0x89u,0x6fu,0xb7u,0x62u,0x0eu,0xaau,0x18u,0xbeu,0x1bu,
  0xfcu,0x56u,0x3eu,0x4bu,0xc6u,0xd2u,0x79u,0x20u,0x9au,0xdbu,0xc0u,0xfeu,0x78u,0xcdu,0x5au,0xf4u,
  0x1fu,0xddu,0xa8u,0x33u,0x88u,0x07u,0xc7u,0x31u,0xb1u,0x12u,0x10u,0x59u,0x27u,0x80u,0xecu,0x5fu,
  0x60u,0x51u,0x7fu,0xa9u,0x19u,0xb5u,0x4au,0x0du,0x2du,0xe5u,0x7au,0x9fu,0x93u,0xc9u,0x9cu,0xefu,
  0xa0u,0xe0u,0x3bu,0x4du,0xaeu,0x2au,0xf5u,0xb0u,0xc8u,0xebu,0xbbu,0x3cu,0x83u,0x53u,0x99u,0x61u,
  0x17u,0x2bu,0x04u,0x7eu,0xbau,0x77u,0xd6u,0x26u,0xe1u,0x69u,0x14u,0x63u,0x55u,0x21u,0x0cu,0x7du
);
fn gmul2(x: u32) -> u32 { return select((x<<1u)^0x1bu,x<<1u,(x&0x80u)==0u)&0xffu; }
fn gmul9(x: u32) -> u32 { return gmul2(gmul2(gmul2(x)))^x; }
fn gmulb(x: u32) -> u32 { return gmul2(gmul2(gmul2(x)))^gmul2(x)^x; }
fn gmuld(x: u32) -> u32 { return gmul2(gmul2(gmul2(x)))^gmul2(gmul2(x))^x; }
fn gmule(x: u32) -> u32 { return gmul2(gmul2(gmul2(x)))^gmul2(gmul2(x))^gmul2(x); }
fn inv_sub_bytes(state: ptr<function,array<u32,4>>) {
  for (var c=0u; c<4u; c++) {
    let s=(*state)[c];
    (*state)[c]=(INV_SBOX[(s>>24u)&0xffu]<<24u)|(INV_SBOX[(s>>16u)&0xffu]<<16u)|
                (INV_SBOX[(s>>8u)&0xffu]<<8u)|INV_SBOX[s&0xffu];
  }
}
fn inv_shift_rows(state: ptr<function,array<u32,4>>) {
  let u0=(*state)[0]; let u1=(*state)[1]; let u2=(*state)[2]; let u3=(*state)[3];
  let b00=(u0>>24u)&0xffu; let b01=(u1>>24u)&0xffu; let b02=(u2>>24u)&0xffu; let b03=(u3>>24u)&0xffu;
  let b10=(u0>>16u)&0xffu; let b11=(u1>>16u)&0xffu; let b12=(u2>>16u)&0xffu; let b13=(u3>>16u)&0xffu;
  let b20=(u0>>8u)&0xffu;  let b21=(u1>>8u)&0xffu;  let b22=(u2>>8u)&0xffu;  let b23=(u3>>8u)&0xffu;
  let b30=u0&0xffu;        let b31=u1&0xffu;        let b32=u2&0xffu;        let b33=u3&0xffu;
  (*state)[0]=(b00<<24u)|(b13<<16u)|(b22<<8u)|b31;
  (*state)[1]=(b01<<24u)|(b10<<16u)|(b23<<8u)|b32;
  (*state)[2]=(b02<<24u)|(b11<<16u)|(b20<<8u)|b33;
  (*state)[3]=(b03<<24u)|(b12<<16u)|(b21<<8u)|b30;
}
fn inv_mix_col(s: u32) -> u32 {
  let a0=(s>>24u)&0xffu; let a1=(s>>16u)&0xffu; let a2=(s>>8u)&0xffu; let a3=s&0xffu;
  return ((gmule(a0)^gmulb(a1)^gmuld(a2)^gmul9(a3))<<24u)|
         ((gmul9(a0)^gmule(a1)^gmulb(a2)^gmuld(a3))<<16u)|
         ((gmuld(a0)^gmul9(a1)^gmule(a2)^gmulb(a3))<<8u)|
         (gmulb(a0)^gmuld(a1)^gmul9(a2)^gmule(a3));
}
fn inv_mix_columns(state: ptr<function,array<u32,4>>) {
  for (var c=0u; c<4u; c++) { (*state)[c]=inv_mix_col((*state)[c]); }
}
fn aes128_key_schedule(key: array<u32,4>) -> array<u32,44> {
  var rk: array<u32,44>;
  rk[0]=key[0]; rk[1]=key[1]; rk[2]=key[2]; rk[3]=key[3];
  let rcon=array<u32,10>(0x01000000u,0x02000000u,0x04000000u,0x08000000u,0x10000000u,
                          0x20000000u,0x40000000u,0x80000000u,0x1b000000u,0x36000000u);
  for (var i=4u; i<44u; i++) {
    var tmp=rk[i-1u];
    if ((i&3u)==0u) {
      tmp=(tmp<<8u)|(tmp>>24u);
      tmp=(SBOX[(tmp>>24u)&0xffu]<<24u)|(SBOX[(tmp>>16u)&0xffu]<<16u)|
          (SBOX[(tmp>>8u)&0xffu]<<8u)|SBOX[tmp&0xffu];
      tmp^=rcon[(i>>2u)-1u];
    }
    rk[i]=rk[i-4u]^tmp;
  }
  return rk;
}
fn aes128_dec_block(rk: array<u32,44>, ct: array<u32,4>) -> array<u32,4> {
  var state=ct;
  for (var c=0u; c<4u; c++) { state[c]^=rk[40u+c]; }
  for (var round=9u; round>=1u; round--) {
    inv_shift_rows(&state); inv_sub_bytes(&state);
    for (var c=0u; c<4u; c++) { state[c]^=rk[round*4u+c]; }
    inv_mix_columns(&state);
  }
  inv_shift_rows(&state); inv_sub_bytes(&state);
  for (var c=0u; c<4u; c++) { state[c]^=rk[c]; }
  return state;
}
const CBC_PAIR : array<u32,8> = ${wgslU32Array(cbcPairWords)};
fn build_uuid(counter: u32) -> array<u32,2> {
  var uuid: array<u32,2>;
  var xIdx: u32=0u; var w0: u32=0u; var w1: u32=0u;
  for (var n=0u; n<16u; n++) {
    var nib: u32;
    if ((UUID_XMASK&(1u<<n))!=0u) {
      let shift=(UUID_UNK_CNT-1u-xIdx)*4u; nib=(counter>>shift)&0xfu; xIdx++;
    } else {
      if (n<8u) { nib=(FIXED_NIB0>>((7u-n)*4u))&0xfu; }
      else      { nib=(FIXED_NIB1>>((15u-n)*4u))&0xfu; }
    }
    let byteIdx=n>>1u; let isUpper=(n&1u)==0u;
    if (byteIdx<4u) {
      if (isUpper) { w0|=(nib<<((3u-byteIdx)*8u+4u)); } else { w0|=(nib<<((3u-byteIdx)*8u)); }
    } else {
      let b=byteIdx-4u;
      if (isUpper) { w1|=(nib<<((3u-b)*8u+4u)); } else { w1|=(nib<<((3u-b)*8u)); }
    }
  }
  uuid[0]=w0; uuid[1]=w1; return uuid;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let i=gid.x;
  if (i>=params.batchCount) { return; }
  let counter=params.batchStart+i;
  let uuid=build_uuid(counter);
  let prk=hkdf_extract(uuid);
  let aes_key=hkdf_expand_16(prk);
  let rk=aes128_key_schedule(aes_key);
  var ct_last: array<u32,4>;
  ct_last[0]=CBC_PAIR[4u]; ct_last[1]=CBC_PAIR[5u]; ct_last[2]=CBC_PAIR[6u]; ct_last[3]=CBC_PAIR[7u];
  var chain_prev: array<u32,4>;
  chain_prev[0]=CBC_PAIR[0u]; chain_prev[1]=CBC_PAIR[1u]; chain_prev[2]=CBC_PAIR[2u]; chain_prev[3]=CBC_PAIR[3u];
  var pt_last: array<u32,4>;
  let dec_last=aes128_dec_block(rk,ct_last);
  for (var c=0u; c<4u; c++) { pt_last[c]=dec_last[c]^chain_prev[c]; }
  if (BLOB_PADDING==0u||BLOB_PADDING>16u) { return; }
  var all_zero: bool=true;
  let check_start: u32=16u-BLOB_PADDING;
  for (var p=check_start; p<16u; p++) {
    let word=pt_last[p>>2u];
    let byte_val=(word>>(24u-(p&3u)*8u))&0xffu;
    if (byte_val!=0u) { all_zero=false; }
  }
  if (all_zero) {
    let slot=atomicAdd(&hits[0],1u);
    if (slot<${MAX_HITS}u) { atomicStore(&hits[slot+1u],counter); }
  }
}
`;
    }

    // === GPU resources and dispatch ===

    /**
     * Compile the selected kernel on the current run-owned GPU session.
     * @param {GpuBlobInfo} blobInfo
     * @returns {Promise<void>}
     */
    async initWebGPU(blobInfo) {
        const generation = this.searchGeneration;
        const session = await this.getGpuSession();
        if (!session || generation !== this.searchGeneration) return;
        const workgroupSize = blobInfo.workgroupSize || CoreFlasherUuidConfig.DEFAULTS.workgroupSize;
        let shader;
        if (blobInfo.algorithm === 'optimized-v3') shader = CoreFlasherUuidOptimizedV3.buildOptimizedShader(blobInfo);
        else if (blobInfo.algorithm === 'optimized-v2') shader = CoreFlasherUuidOptimizedV2.buildOptimizedShader(blobInfo);
        else {
            shader = blobInfo.algorithm === 'optimized-v1'
                ? CoreFlasherUuidOptimized.buildOptimizedShader(blobInfo)
                : this.makeShaderCode(blobInfo.cbcPairWords, blobInfo.padding, blobInfo.salt,
                    blobInfo.info, blobInfo.f0, blobInfo.f1, blobInfo.xMask, blobInfo.unknownCount);
            shader = CoreFlasherUuidSearch.specializeWorkgroup(shader, workgroupSize);
        }
        const cacheKey = JSON.stringify([blobInfo.algorithm, this.kernelRevision(blobInfo.algorithm), workgroupSize,
            blobInfo.cbcPairWords, blobInfo.padding, Array.from(blobInfo.salt), Array.from(blobInfo.info),
            blobInfo.xMask, blobInfo.unknownCount, blobInfo.algorithm === 'legacy-v1' ? [blobInfo.f0, blobInfo.f1] : null]);
        await session.compile(shader, workgroupSize, cacheKey);
        if (generation !== this.searchGeneration) { session.dispose(); return; }
        this.app.gpu.device = session.device;
    }

    /** Lazily create one run-owned device, also used to constrain Auto choices. */
    async getGpuSession() {
        const generation = this.searchGeneration;
        let session = this.app.gpu.session;
        if (!session) {
            session = await CoreFlasherUuidSearch.Session.create();
            if (generation !== this.searchGeneration) { session.dispose(); return; }
            this.app.gpu.session = session;
        }
        return session;
    }

    /** Revision identifies executed code, never the Auto selection strategy. */
    kernelRevision(algorithm) {
        if (algorithm === 'optimized-v3') return CoreFlasherUuidOptimizedV3.revision;
        if (algorithm === 'optimized-v2') return CoreFlasherUuidOptimizedV2.revision;
        return algorithm === 'optimized-v1' ? CoreFlasherUuidOptimized.revision : 'legacy-v1';
    }

    /**
     * Dispatch candidates within device limits, then map and collect bounded hit counters.
     * @param {number} batchStart
     * @param {number} batchCount
     * @returns {Promise<number[]>}
     */
    async runBatch(batchStart, batchCount) {
        const { session, blobInfo } = this.app.gpu;
        return session.run(batchStart, batchCount, blobInfo.f0, blobInfo.f1);
    }

    /**
     * Release only the current run-owned GPU session and its device.
     * @returns {void}
     */
    stopWebGPU() {
        this.app.gpu.session?.dispose();
        this.app.gpu.session = null;
        this.app.gpu.device = null;

    }

    // === CPU verification primitives ===

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
     * Recover raw CBC plaintext by appending a synthetic PKCS#7 final block.
     * The extra block lets WebCrypto remove its own padding, not the blob's zero padding.
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
            if (i < 0 || padded[i] !== 0x00) {
                return false;
            }
        }
        return true;
    }

    /**
     * Remove the declared number of trailing bytes without validating them.
     * @param {Uint8Array} padded
     * @param {number} padding
     * @returns {Uint8Array}
     */
    stripPadding(padded, padding) {
        return padded.slice(0, padded.length - padding);
    }

    // === Blob preparation ===

    /**
     * Prepare the final CBC block pair and initialize detection for the selected blob.
     * @returns {Promise<void>}
     */
    async initializeGpuForCurrentSelection(source = this.captureSearchSource()) {
        const generation = this.searchGeneration;
        if (!this.sourceAllowed()) throw new Error('Connect an interface or load an image first.');
        const sources = await this.resolveSelectedBlobSources();
        if (!this.isSearchCurrent(generation, source)) return;
        const primary = sources[0];
        const parsed = primary.parsed;
        for (const source of sources) CoreFlasherUuidSearch.validateBlob(source.parsed, this.FIXED_SALT, this.FIXED_INFO);
        const verificationInputs = [];
        for (const item of sources) {
            const digest = await crypto.subtle.digest('SHA-256', item.bytes);
            if (!this.isSearchCurrent(generation, source)) return;
            verificationInputs.push(this.bytesToHex(new Uint8Array(digest)));
        }
        const inputSha256 = verificationInputs[0];
        if (!this.isSearchCurrent(generation, source)) return;
        this.inputFingerprint = { inputSha256, inputBytes: primary.bytes.length, padding: parsed.padding, verificationInputs };
        const lastBlock = parsed.ciphertext.slice(parsed.ciphertext.length - 16);
        const prevBlock = parsed.ciphertext.length >= 32
            ? parsed.ciphertext.slice(parsed.ciphertext.length - 32, parsed.ciphertext.length - 16)
            : parsed.iv;
        const cbcPair = new Uint8Array(32);
        cbcPair.set(prevBlock, 0);
        cbcPair.set(lastBlock, 16);
        const blobInfo = {
            cbcPairWords: this.bytesToWords(cbcPair),
            padding: parsed.padding,
            salt: this.FIXED_SALT,
            info: this.FIXED_INFO,
            f0: 0, f1: 0, xMask: 1, unknownCount: 1
        };
        this.stopWebGPU();
        // Compile only once the real mask and resumed prefix are known.
        if (!this.isSearchCurrent(generation, source)) return;
        this.app.gpu.blobInfo = blobInfo;
        this.app.gpu.parsed = parsed;
        this.app.gpu.parsedSources = sources.map(s => ({ name: s.name, parsed: s.parsed }));
        this.setState('prepared');
        this.log('Prepared encrypted input: ' + primary.name + ' (ciphertext ' + parsed.ciphertext.length
            + ' bytes, padding=' + parsed.padding + ').', 'ok');
    }

    // === Controls and progress ===

    /**
     * Set Start/Pause/Resume labels and availability from the current search state.
     * @returns {void}
     */
    refreshActionButtons() {
        const locked = !!this.app.running || !!this._resetting || !!this._searchTask;
        const reset = this.element?.querySelector('#ci-resetBtn');
        if (reset) reset.disabled = locked;
        this.ui.mask.disabled = locked;
        this.ui.batchSize.disabled = locked;
        if (this.ui.algorithm) this.ui.algorithm.disabled = locked;
        for (const name of ['workgroupSize', 'recalibrateBtn', 'resetTuningBtn']) {
            if (this.ui[name]) this.ui[name].disabled = locked;
        }
        if (this._resetting || (this._searchTask && !this.app.running)) {
            this.ui.startBtn.disabled = true;
            this.ui.pauseBtn.disabled = true;
            return;
        }
        if (!this.sourceAllowed()) {
            this.ui.startBtn.disabled = true;this.ui.pauseBtn.disabled = true;return;
        }
        if (this.app.running) {
            this.ui.startBtn.textContent = 'Start';
            this.ui.startBtn.disabled = true;
            this.ui.pauseBtn.textContent = 'Pause';
            this.ui.pauseBtn.disabled = false;
            return;
        }
        const hasCheckpoint = !!this.getStoredCheckpoint();
        const hasFile = this.hasInputFile();
        if (this.app.paused && hasCheckpoint) {
            this.ui.startBtn.textContent = 'Resume';
            this.ui.startBtn.disabled = !hasFile;
            this.ui.pauseBtn.textContent = 'Pause';
            this.ui.pauseBtn.disabled = true;
            return;
        }
        this.ui.startBtn.textContent = 'Start';
        this.ui.startBtn.disabled = !hasFile;
        this.ui.pauseBtn.textContent = 'Pause';
        this.ui.pauseBtn.disabled = true;
    }

    /**
     * Update running controls and UUID animation without changing the search flag.
     * @param {boolean} isRunning
     * @returns {void}
     */
    setControlsRunning(isRunning) {
        const reset = this.element?.querySelector('#ci-resetBtn');
        if (reset) reset.disabled = isRunning || !!this._resetting || !!this._searchTask;
        this.ui.mask.disabled = isRunning || !!this._resetting;
        this.ui.batchSize.disabled = isRunning || !!this._resetting;
        for (const name of ['algorithm', 'workgroupSize', 'recalibrateBtn', 'resetTuningBtn']) {
            if (this.ui[name]) this.ui[name].disabled = isRunning || !!this._resetting || !!this._searchTask;
        }
        if (isRunning) {
            this.setCurrentUuidAnimationEnabled(true);
            this.ui.startBtn.textContent = 'Start';
            this.ui.pauseBtn.textContent = 'Pause';
            this.ui.startBtn.disabled = true;
            this.ui.pauseBtn.disabled = false;
            return;
        }
        this.setCurrentUuidAnimationEnabled(false);
        this.refreshActionButtons();
    }

    /**
     * Render the UUID and animate the positions associated with the current batch.
     * @param {string|null|undefined} currentSuffix
     * @returns {void}
     */
    renderCurrentUuid(currentSuffix) {
        const value = String(currentSuffix != null ? currentSuffix : '-');
        const changingPositions = (() => {
            if (this.app.search && Array.isArray(this.app.search.batchChangingPositions)
                && this.app.search.batchChangingPositions.length > 0) {
                return this.app.search.batchChangingPositions;
            }
            if (this.app.pauseCheckpoint
                && Array.isArray(this.app.pauseCheckpoint.batchChangingPositions)
                && this.app.pauseCheckpoint.batchChangingPositions.length > 0) {
                return this.app.pauseCheckpoint.batchChangingPositions;
            }
            return [];
        })();
        if (!changingPositions.length) {
            this.ui.current.classList.remove('cipher-active');
            this.ui.current.textContent = value;
            return;
        }
        const changingSet = new Set(changingPositions);
        const phase = (performance.now() / 90) | 0;
        let html = '';
        for (let i = 0; i < value.length; i++) {
            const ch = value[i];
            if (changingSet.has(i)) {
                const d0 = String((phase + i * 7) % 10);
                const d1 = String((phase + i * 3 + 5) % 10);
                const d2 = String((phase + i * 9 + 2) % 10);
                html += `<span class="uuid-char uuid-fx" style="--fx-delay:${(
                    i % 9) * 23}ms"><span class="uuid-layer l0">${d0}</span><span class="uuid-layer l1">${d1}</span><span class="uuid-layer l2">${d2}</span></span>`;
            }
            else {
                html += `<span class="uuid-char">${this.escapeHtml(ch)}</span>`;
            }
        }
        this.ui.current.classList.add('cipher-active');
        this.ui.current.innerHTML = html;
    }

    /**
     * Pause or resume the existing UUID animation class.
     * @param {boolean} enabled
     * @returns {void}
     */
    setCurrentUuidAnimationEnabled(enabled) {
        if (enabled) {
            this.ui.current.classList.remove('cipher-frozen');
        }
        else {
            this.ui.current.classList.add('cipher-frozen');
        }
    }

    /**
     * Refresh UUID, throughput, ETA, and percentage using the existing timing threshold.
     * @param {string} currentSuffix
     * @param {boolean} offerAdvice False for a winning batch, which needs no further-search notice.
     * @returns {void}
     */
    updateProgress(currentSuffix, offerAdvice = true) {
        const counters = this.app.counters;
        this.renderCurrentUuid(currentSuffix);
        const now = performance.now();
        const elapsedSeconds = (now - counters.lastTickAt) / 1000;
        if (elapsedSeconds >= 0.5) {
            const rate = Math.max(0,
                (counters.checked - counters.lastTickChecked) / elapsedSeconds);
            this.ui.rate.textContent = Math.round(rate).toLocaleString();
            counters.lastTickAt = now;
            counters.lastTickChecked = counters.checked;
            if (rate > 0) {
                const remainingSeconds = (counters.total - counters.checked) / rate;
                this.ui.eta.textContent = this.formatSeconds(Math.ceil(remainingSeconds));
                if (offerAdvice) this.considerLongSearchNotice(remainingSeconds);
            }
        }
        const progressPercent = counters.total > 0 ? (counters.checked / counters.total) * 100 : 0;
        this.ui.progressBar.style.width = Math.min(100, progressPercent) + '%';
    }

    /** Re-evaluated with each measured ETA, so a blocked modal needs no queue or timer. */
    considerLongSearchNotice(remainingSeconds) {
        if (typeof document === 'undefined' || this.longSearchNoticeShown || this.etaCalibrating ||
            !this.app.running || this.app.pauseRequested || !this.app.counters.checked ||
            !Number.isFinite(remainingSeconds) || remainingSeconds <= CardController.LONG_SEARCH_NOTICE_SECONDS ||
            document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
        if (!this.longSearchNotice) {
            const dialog = document.createElement('dialog');
            dialog.className = 'ci-expansion-notice ci-long-search-notice';
            dialog.setAttribute('aria-labelledby', 'ci-long-search-title');
            dialog.innerHTML = '<h2 id="ci-long-search-title">This search may take more than two hours.</h2><p>Consider saving a full backup of your box first, then preparing and flashing Diagnostic Image (Production). You can then use Detect UUID (Alternative) over USB-C instead of continuing the GPU search.</p><div><button type="button" class="cf-dump-button">Continue search</button><button type="button" class="cf-dump-button">Pause and open Dump / Flash</button></div>';
            const [keepSearching, pause] = dialog.querySelectorAll('button');
            this.listen(keepSearching, 'click', () => this.closeLongSearchNotice());
            this.listen(pause, 'click', () => this.pauseLongSearchAndNavigate());
            document.body.appendChild(dialog);
            this.own(() => { dialog.close(); dialog.remove(); this.longSearchNotice = null; });
            this.longSearchNotice = dialog;
        }
        this.longSearchNotice.showModal();
        this.longSearchNoticeShown = true;
    }

    closeLongSearchNotice() { if (this.longSearchNotice?.open) this.longSearchNotice.close(); }

    /** The normal pause owns readback/checkpoint cleanup; navigate only once that task settles. */
    async pauseLongSearchAndNavigate() {
        this.closeLongSearchNotice();
        if (!this.app.running) return;
        const generation = this.searchGeneration, source = this.captureSearchSource();
        this.ui.pauseBtn.click();
        try { await this._searchTask; }
        catch (error) { this.log(`Search could not pause cleanly: ${error.message}`, 'bad'); return; }
        if (this.isSearchCurrent(generation, source) && this.app.paused && this.app.pauseCheckpoint) {
            this.context.navigation.moveToCard('tile-interface-options');
        }
    }

    // === Checkpoints and search orchestration ===

    /** Stage progress is separate from cumulative measured work in the saved report. */
    renderSearchStage() {
        const label = this.element?.querySelector('#ci-search-stage');
        if (!label) return;
        const plan = this.app.search?.plan || this.app.pauseCheckpoint?.plan;
        const omitted = plan ? CoreFlasherUuidPlan.excluded(plan) : [];
        label.textContent = plan
            ? `Stage ${plan.stages.length}: ${plan.stages.at(-1).mask}. ${omitted.length ? 'Completed ranges: ' + omitted.join(', ') + '. These will not be repeated.' : 'No completed ranges excluded.'} Progress and ETA describe this stage.`
            : 'Search expands automatically: D7, then AA, then the remaining full range.';
    }

    /** A native dialog leaves the asynchronous GPU loop running; Pause is explicit. */
    showExpansionNotice() {
        if (typeof document === 'undefined') return;
        if (!this.expansionNotice) {
            const dialog = document.createElement('dialog');
            dialog.className = 'ci-expansion-notice';
            dialog.setAttribute('aria-labelledby', 'ci-expansion-title');
            dialog.innerHTML = '<h2 id="ci-expansion-title"></h2><p></p><div><button type="button" class="cf-dump-button">Close</button><button type="button" class="cf-dump-button">Pause search</button></div>';
            const [close, pause] = dialog.querySelectorAll('button');
            this.listen(close, 'click', () => this.closeExpansionNotice());
            this.listen(pause, 'click', () => {
                this.closeExpansionNotice();
                if (this.app.running) this.ui.pauseBtn.click();
            });
            document.body.appendChild(dialog);
            this.own(() => { dialog.close(); dialog.remove(); this.expansionNotice = null; });
            this.expansionNotice = dialog;
        }
        const plan = this.app.search.plan;
        const expandedToAA = plan.stages.at(-1).mask === CoreFlasherUuidPlan.AA;
        this.expansionNotice.querySelector('h2').textContent = expandedToAA
            ? 'No match in the smallest search range.'
            : plan.startMask === CoreFlasherUuidPlan.AA ? 'No match in the smaller search range.' : 'No match in the smaller search ranges.';
        this.expansionNotice.querySelector('p').textContent = expandedToAA
            ? 'The search is now checking UUIDs ending in AA. Together, these two ranges cover twice as many candidates. Your search settings are unchanged.'
            : 'The search has now expanded to the full supported range. Completed ranges are excluded. This step can take considerably longer.';
        // Never stack dialogs. The persistent stage line still announces a transition behind another modal.
        if (!this.expansionNotice.open && !document.querySelector('dialog[open]')) this.expansionNotice.showModal();
    }

    closeExpansionNotice() {
        if (this.expansionNotice?.open) this.expansionNotice.close();
    }

    /**
     * Return the in-memory checkpoint or parse the persisted checkpoint; invalid JSON is ignored.
     * @returns {SearchCheckpoint|null}
     */
    getStoredCheckpoint() {
        const checkpoint = this.app.pauseCheckpoint || this._startupCheckpoint || this.readCheckpoint();
        if (checkpoint && (![2, 3, 4].includes(checkpoint.schemaVersion) || checkpoint.searchOrderVersion !== (checkpoint.schemaVersion === 4 ? 3 : 2)
            || !Array.from(this.ui.mask.options).some(option => option.value === checkpoint.mask))) {
            this._startupCheckpoint = null;
            this.app.pauseCheckpoint = null;
            this.app.paused = false;
            this.removeCheckpoint();
            this.log('Saved search discarded: unsupported mask or search format. Stored UUID is unchanged.', 'warn');
        }
        return this.app.pauseCheckpoint || null;
    }

    /** Preference storage is optional; a failed write never blocks a search. */
    readAlgorithm() {
        return this.readSearchPreference(this.algorithmKey, [...CoreFlasherUuidSearch.ALGORITHMS, 'auto'], CoreFlasherUuidConfig.DEFAULTS.algorithm);
    }

    /** Restore only supported preference values; storage is not required for searching. */
    readSearchPreference(key, allowed, fallback) {
        try {
            const value = localStorage.getItem(key);
            return allowed.includes(value) ? value : fallback;
        } catch (_error) { return fallback; }
    }

    /** Register a card-owned listener without changing settings during a live search. */
    bindSearchPreference(name) {
        const control = this.ui[name];
        let previous = control.value;
        this.listen(control, 'change', () => {
            if (this._searchTask || this._resetting || this.app.running) { control.value = previous; return; }
            if (!Array.from(control.options).some(option => option.value === control.value)) { control.value = previous; return; }
            previous = control.value;
            if (name === 'algorithm') this.algorithm = control.value;
            this.skipTuningProfile = false;
            this.ui.effectiveConfig.textContent = 'Settings updated. Auto changes only selections set to Auto.';
            try { localStorage.setItem(this[name + 'Key'], control.value); }
            catch (_error) { this.log('Search preference is available for this session only.', 'warn'); }
        });
    }

    /** Remove performance measurements independently of UUIDs, reports and checkpoints. */
    resetTuning() {
        this.tuningProfiles = [];
        this.skipTuningProfile = true;
        try { localStorage.removeItem(this.tuningKey); }
        catch (_error) { this.log('Tuning profiles could not be removed from browser storage.', 'warn'); }
        if (this.ui.effectiveConfig) this.ui.effectiveConfig.textContent = 'Tuning reset. Search progress is unchanged.';
        if (this.ui.performanceDetails) this.ui.performanceDetails.textContent = window.DEV_MODE === true
            ? 'Auto will measure again on the next search.' : '';
    }
    readCheckpoint() {
        try { return JSON.parse(localStorage.getItem(this.checkpointKey) || 'null'); }
        catch (_error) { return null; }
    }
    removeCheckpoint() {
        // Keep an unverified reload checkpoint until the first selected encrypted file is known.
        if (this._startupCheckpoint) return;
        try { localStorage.removeItem(this.checkpointKey); }
        catch (_error) { this.log('Saved search could not be removed from browser storage.', 'warn'); }
    }

    /** Bind a pending reload checkpoint to the entire encrypted file before offering Resume. */
    async validatePendingCheckpoint(bytes) {
        const generation = this.searchGeneration;
        const source = this.captureSearchSource();
        const checkpoint = this._startupCheckpoint;
        try {
            const hash = this.bytesToHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)));
            let verificationInputs;
            if (checkpoint?.schemaVersion === 4) {
                const sources = await this.resolveSelectedBlobSources();
                verificationInputs = [];
                for (const item of sources) {
                    const digest = await crypto.subtle.digest('SHA-256', item.bytes);
                    verificationInputs.push(this.bytesToHex(new Uint8Array(digest)));
                }
            }
            if (!this.isSearchCurrent(generation, source)) return;
            this.checkCheckpoint(checkpoint, hash, verificationInputs);
            this._startupCheckpoint = null;
            this.app.pauseCheckpoint = checkpoint;
            this.app.paused = true;
            this.ui.mask.value = checkpoint.mask;
            this.renderSearchStage();
            this.setState('paused');
            this.log('Matching saved search found. Select Resume to continue, or Reset scan to begin again.', 'ok');
        } catch (error) {
            if (!this.isSearchCurrent(generation, source)) return;
            this._startupCheckpoint = null;
            this.removeCheckpoint();
            this.log('Saved search discarded: ' + error.message + ' Stored UUID is unchanged.', 'warn');
        }
        if (generation === this.searchGeneration) this.refreshActionButtons();
    }

    checkCheckpoint(checkpoint, hash, verificationInputs) {
        if (!checkpoint || ![2, 3, 4].includes(checkpoint.schemaVersion) || checkpoint.searchOrderVersion !== (checkpoint.schemaVersion === 4 ? 3 : 2)
            || !Array.from(this.ui.mask.options).some(option => option.value === checkpoint.mask)
            || checkpoint.inputSha256 !== hash || checkpoint.saltHex !== this.bytesToHex(this.FIXED_SALT)
            || checkpoint.infoHex !== this.bytesToHex(this.FIXED_INFO)) {
            throw new Error('The input or search format does not match.');
        }
        const { unknownPositions } = this.parseMask(checkpoint.mask);
        const expectedEnd = checkpoint.schemaVersion === 4
            ? CoreFlasherUuidPlan.total(CoreFlasherUuidPlan.validate(checkpoint.plan, checkpoint.next, checkpoint.mask))
            : 16 ** unknownPositions.length;
        if (checkpoint.schemaVersion === 4) {
            if (!Array.isArray(checkpoint.verificationInputs) || !checkpoint.verificationInputs.length
                || checkpoint.verificationInputs.some(value => !/^[a-f0-9]{64}$/.test(value))
                || checkpoint.verificationInputs[0] !== hash) throw new Error('Invalid saved verification inputs.');
            if (verificationInputs && JSON.stringify(verificationInputs) !== JSON.stringify(checkpoint.verificationInputs)) {
                throw new Error('The CPU verification files changed. Restart the search instead.');
            }
            for (const field of ['candidatesTested', 'activeMs', 'setupMs']) {
                const sum = checkpoint.plan.stages.reduce((total, stage) => total + stage[field], 0);
                if (!Number.isFinite(checkpoint.telemetry?.[field]) || Math.abs(sum - checkpoint.telemetry[field]) > 0.01) {
                    throw new Error('Inconsistent saved stage statistics.');
                }
            }
        }
        if (checkpoint.start !== 0 || checkpoint.endExclusive !== expectedEnd
            || !Number.isSafeInteger(checkpoint.next) || checkpoint.next < 0 || checkpoint.next > checkpoint.endExclusive) {
            throw new Error('Invalid saved search range.');
        }
        CoreFlasherUuidRecord.validateTelemetry(checkpoint.telemetry, checkpoint.schemaVersion >= 3 ? 2 : 1);
    }

    saveCheckpoint(paused = true) {
        const checkpoint = JSON.parse(JSON.stringify(this.app.search));
        checkpoint.savedAt = new Date().toISOString();
        this.app.pauseCheckpoint = checkpoint;
        this.app.paused = paused;
        try { localStorage.setItem(this.checkpointKey, JSON.stringify(checkpoint)); }
        catch (_error) { this.log('Checkpoint is available for this session only.', 'warn'); }
    }

    /** Measurements are scoped to code, work shape and capabilities, never to secret input bytes. */
    tuningProfileScope(config, session) {
        const limits = session.device.limits;
        return JSON.stringify({ version: CoreFlasherUuidConfig.PROFILE_VERSION,
            policy: CoreFlasherUuidConfig.TUNING.policyRevision,
            kernels: CoreFlasherUuidConfig.KERNEL_IDS.map(algorithm => [algorithm, this.kernelRevision(algorithm)]),
            browser: navigator.userAgent, adapter: session.adapterInfo,
            limits: [limits.maxComputeInvocationsPerWorkgroup, limits.maxComputeWorkgroupSizeX,
                limits.maxComputeWorkgroupsPerDimension],
            padding: this.app.gpu.blobInfo.padding, positions: config.unknownPositions,
            sources: this.app.gpu.parsedSources?.map(source => source.parsed.ciphertext.length),
            requested: [config.algorithm, config.batchSize, config.workgroupSize] });
    }

    /** Only complete, stable calibration evidence can be reused across searches. */
    isCompleteTuningProfile(profile) {
        return !!profile && CoreFlasherUuidConfig.KERNEL_IDS.includes(profile.algorithm)
            && CoreFlasherUuidConfig.BATCH_SIZES.includes(profile.batchSize)
            && CoreFlasherUuidConfig.WORKGROUP_SIZES.includes(profile.workgroupSize)
            && Number.isFinite(profile.rate) && profile.rate > 0 && profile.provisional === false
            && profile.complete === true && profile.stable === true
            && Number.isSafeInteger(profile.evidenceRevision) && profile.evidenceRevision >= 0
            && profile.policyRevision === CoreFlasherUuidConfig.TUNING.policyRevision
            && Number.isSafeInteger(profile.measuredPairs) && profile.measuredPairs > 0
            && profile.measuredPairs === profile.eligiblePairs
            && profile.eligiblePairs <= CoreFlasherUuidConfig.TUNING.maxConfigurations
            && CoreFlasherUuidConfig.BATCH_SIZES.includes(profile.maxBatchTested)
            && profile.batchSize <= profile.maxBatchTested;
    }

    /** Ignore damaged optional profile storage without weakening checkpoint validation. */
    readTuningProfile(key) {
        if (!this.tuningProfiles) {
            this.tuningProfiles = [];
            try {
                const stored = JSON.parse(localStorage.getItem(this.tuningKey) || 'null');
                if (stored?.format === CoreFlasherUuidConfig.PROFILE_VERSION && Array.isArray(stored.profiles)) {
                    this.tuningProfiles = stored.profiles.slice(-CoreFlasherUuidConfig.MAX_PROFILES).filter(entry => {
                        return typeof entry?.key === 'string' && typeof entry.updatedAt === 'string'
                            && this.isCompleteTuningProfile(entry.profile);
                    });
                }
            } catch (_error) { this.log('Tuning profile storage is unavailable or invalid; measuring in this session.', 'warn'); }
        }
        return this.tuningProfiles.find(entry => entry.key === key)?.profile || null;
    }

    /** Persist fresh complete evidence, not every production batch or noisy rate sample. */
    saveTuningProfile(key, profile) {
        if (!this.isCompleteTuningProfile(profile)) return;
        const signature = JSON.stringify([key, profile.algorithm, profile.batchSize, profile.workgroupSize,
            profile.policyRevision, profile.evidenceRevision, profile.measuredPairs, profile.maxBatchTested]);
        if (signature === this.savedTuningSignature) return;
        this.savedTuningSignature = signature;
        const updatedAt = new Date().toISOString();
        this.tuningProfiles = [...(this.tuningProfiles || []).filter(entry => entry.key !== key),
            { key, updatedAt, profile }].slice(-CoreFlasherUuidConfig.MAX_PROFILES);
        try { localStorage.setItem(this.tuningKey, JSON.stringify({ format: CoreFlasherUuidConfig.PROFILE_VERSION, profiles: this.tuningProfiles })); }
        catch (_error) { this.log('Tuning profile is available for this session only.', 'warn'); }
    }

    /** Device loss invalidates its measurements without touching the committed cursor. */
    invalidateTuningProfile(key) {
        this.tuningProfiles = (this.tuningProfiles || []).filter(entry => entry.key !== key);
        this.savedTuningSignature = null;
        try { localStorage.setItem(this.tuningKey, JSON.stringify({ format: CoreFlasherUuidConfig.PROFILE_VERSION, profiles: this.tuningProfiles })); }
        catch (_error) { this.log('Invalid tuning profile could not be removed from browser storage.', 'warn'); }
    }

    /** A variant contains executed values; Auto itself is never recorded as a kernel. */
    searchVariant(telemetry, effective) {
        const kernel = this.kernelRevision(effective.algorithm);
        let variant = telemetry.variants.find(item => item.algorithm === effective.algorithm && item.kernel === kernel
            && item.batchSize === effective.batchSize && item.workgroupSize === effective.workgroupSize);
        if (!variant) {
            if (telemetry.variants.length >= CoreFlasherUuidConfig.MAX_VARIANTS) {
                throw new Error('Search statistics reached the variant limit. Progress was retained; resume with an already measured configuration.');
            }
            variant = { ...effective, kernel, candidatesTested: 0, activeMs: 0, setupMs: 0 };
            telemetry.variants.push(variant);
        }
        return variant;
    }

    /** Reuse the existing card typography and show actual settings independently of Auto selectors. */
    showSearchPerformance(effective, tuner, elapsedMs = null, force = false) {
        const status = tuner?.status;
        this.etaCalibrating = !!status?.calibrating;
        const signature = JSON.stringify([effective.algorithm, effective.batchSize, effective.workgroupSize,
            status?.phase, status?.provisional, status?.complete, status?.stable, window.DEV_MODE === true]);
        const now = performance.now();
        if (!force && this.performanceDisplay?.signature === signature
            && now - this.performanceDisplay.at < CoreFlasherUuidConfig.DISPLAY_INTERVAL_MS) return;
        this.performanceDisplay = { signature, at: now };
        const provisional = status?.provisional || status?.complete !== true || status?.stable !== true;
        const mode = !tuner ? 'Manual' : status.calibrating ? 'Calibrating' : provisional ? 'Auto (provisional)' : 'Auto';
        const label = { 'legacy-v1': 'Legacy', 'optimized-v1': 'Optimized v1',
            'optimized-v2': 'Optimized v2', 'optimized-v3': 'Optimized v3' }[effective.algorithm];
        const batch = effective.batchSize >= 2 ** 20 ? `${effective.batchSize / 2 ** 20}M` : `${effective.batchSize / 2 ** 10}K`;
        if (this.ui.effectiveConfig) this.ui.effectiveConfig.textContent = `${mode}: ${label} · ${batch} · ${effective.workgroupSize} threads`;
        if (status?.calibrating && this.ui.eta) this.ui.eta.textContent = 'Calibrating…';
        if (window.DEV_MODE !== true || !this.ui.performanceDetails) return;
        const padding = this.app.gpu.blobInfo.padding;
        const forward = ['optimized-v2', 'optimized-v3'].includes(effective.algorithm) && padding === 16;
        const path = forward ? effective.algorithm === 'optimized-v3' ? 'Forward AES (early reject)' : 'Forward AES'
            : 'Inverse AES';
        const adapter = this.app.gpu.session?.adapterInfo;
        const lines = [`Kernel: ${this.kernelRevision(effective.algorithm)}`, `Padding: ${padding} · ${path}`];
        if (adapter?.description || adapter?.architecture) lines.push(`GPU: ${adapter.description || adapter.architecture}`);
        if (elapsedMs !== null) lines.push(`Last batch: ${Math.round(elapsedMs)} ms`);
        if (status?.reason) lines.push(status.reason);
        const profile = this.tuningProfiles?.find(entry => entry.key === this.activeTuningKey);
        if (profile) lines.push(`Last profile update: ${profile.updatedAt}`);
        for (const item of this.app.search.telemetry.variants) {
            if (item.activeMs > 0) lines.push(`${item.algorithm} · ${item.batchSize.toLocaleString()} · ${item.workgroupSize} threads: ${Math.round(item.candidatesTested * 1000 / item.activeMs).toLocaleString()}/s`);
        }
        this.ui.performanceDetails.textContent = lines.join('\n');
    }


    /**
     * Traverse every kernel with one exclusive cursor and commit only CPU-verified batches.
     * @param {number|null|undefined} startCounterOverride
     * @returns {Promise<void>}
     */
    async runBruteforce(startCounterOverride, source = this.captureSearchSource()) {
        const generation = this.searchGeneration;
        const isCurrent = () => this.isSearchCurrent(generation, source);
        let config = Object.freeze({ ...this.validateInputs(), mask: this.ui.mask.value.trim().toUpperCase(),
            algorithm: this.algorithm || 'legacy-v1' });
        const resuming = startCounterOverride !== undefined && startCounterOverride !== null;
        if (!resuming) this.longSearchNoticeShown = false;
        const checkpoint = resuming ? this.getStoredCheckpoint() : null;
        if (resuming) this.checkCheckpoint(checkpoint, this.inputFingerprint.inputSha256, this.inputFingerprint.verificationInputs || [this.inputFingerprint.inputSha256]);
        if (resuming && checkpoint.mask !== config.mask) throw new Error('Resume mask changed. Restart the search instead.');
        const telemetry = resuming ? JSON.parse(JSON.stringify(checkpoint.telemetry)) : CoreFlasherUuidRecord.newTelemetry();
        if (resuming) telemetry.resumes++;
        if (resuming && checkpoint.schemaVersion === 2) {
            for (const variant of telemetry.variants) variant.workgroupSize = CoreFlasherUuidConfig.DEFAULTS.workgroupSize;
        }
        const plan = checkpoint?.schemaVersion === 4 ? JSON.parse(JSON.stringify(checkpoint.plan))
            : CoreFlasherUuidPlan.create(config.mask, telemetry, resuming ? checkpoint.next : 0);
        const requested = { algorithm: config.algorithm, batchSize: config.batchSize,
            workgroupSize: config.workgroupSize || CoreFlasherUuidConfig.DEFAULTS.workgroupSize };
        const automatic = Object.values(requested).includes('auto');
        let effective = { algorithm: requested.algorithm === 'auto' ? 'legacy-v1' : requested.algorithm,
            batchSize: requested.batchSize === 'auto' ? CoreFlasherUuidConfig.BATCH_SIZES[0] : requested.batchSize,
            workgroupSize: requested.workgroupSize === 'auto' ? CoreFlasherUuidConfig.DEFAULTS.workgroupSize : requested.workgroupSize };
        // Cursor and measured work are independent: retries count work, but never advance coverage.
        this.app.search = { schemaVersion: 4, searchOrderVersion: 3, mask: config.mask, plan,
            start: config.start, endExclusive: CoreFlasherUuidPlan.total(plan), next: resuming ? checkpoint.next : config.start,
            saltHex: this.bytesToHex(config.salt), infoHex: this.bytesToHex(config.info),
            ...this.inputFingerprint, verificationInputs: this.inputFingerprint.verificationInputs || [this.inputFingerprint.inputSha256],
            telemetry, ...effective, kernel: this.kernelRevision(effective.algorithm), requested };
        this._startupCheckpoint = null;
        this.removeCheckpoint();
        this.successfulSearch = null;
        this.app.running = true;
        this.app.paused = false;
        this.app.pauseRequested = false;
        this.renderSearchStage();
        Object.assign(this.app.counters, { checked: this.app.search.next, total: this.app.search.endExclusive,
            startedAt: performance.now(), lastTickAt: performance.now(), lastTickChecked: this.app.search.next });
        this.setControlsRunning(true);
        this.setState('preparing');
        let compiledVariant = null;
        let tuner = null;
        this.activeTuningKey = null;
        this.savedTuningSignature = null;
        let completed = false;
        try {
            if (automatic && (this.app.search.next < this.app.search.endExclusive || config.mask !== CoreFlasherUuidPlan.FULL)) {
                const setupStart = performance.now();
                const session = await this.getGpuSession();
                if (!isCurrent()) return;
                const setupMs = performance.now() - setupStart;
                telemetry.setupMs += setupMs; plan.stages.at(-1).setupMs += setupMs;
                const limits = session.device.limits;
                const availableWorkgroups = CoreFlasherUuidConfig.WORKGROUP_SIZES.filter(size =>
                    size <= limits.maxComputeInvocationsPerWorkgroup && size <= limits.maxComputeWorkgroupSizeX);
                this.activeTuningKey = this.tuningProfileScope(config, session);
                const storedProfile = this.readTuningProfile(this.activeTuningKey);
                tuner = new CoreFlasherUuidTuner.Tuner(requested, {
                    profile: this.skipTuningProfile ? null : storedProfile, availableWorkgroups,
                    remaining: () => this.app.search.endExclusive - this.app.search.next });
                if (storedProfile && !this.skipTuningProfile) this.log('Checking saved tuning profile against this GPU session.', 'ok');
                this.skipTuningProfile = false;
            }
            while (this.app.running) {
                if (!this.sourceAllowed()) throw new Error('Source disconnected. Search stopped.');
                // A device can be lost between a verified final batch and the next stage.
                if (this.app.gpu.session?.failure) throw this.app.gpu.session.failure;
                if (tuner) effective = tuner.next();
                const segment = CoreFlasherUuidPlan.segment(plan, this.app.search.next, effective.batchSize);
                const batch = segment?.direct
                    ? CoreFlasherUuidSearch.nextBatch(this.app.search.next, this.app.search.endExclusive, config.numUnknown, effective.batchSize)
                    : segment;
                if (!batch) {
                    if (!isCurrent() || !this.app.running || this.app.pauseRequested) break;
                    if (CoreFlasherUuidPlan.advance(plan)) {
                        const mask = plan.stages.at(-1).mask;
                        this.ui.mask.value = mask;
                        const parsed = this.parseMask(mask);
                        config = Object.freeze({ ...config, mask, ...parsed, numUnknown: parsed.unknownPositions.length });
                        Object.assign(this.app.search, { mask, next: 0, endExclusive: CoreFlasherUuidPlan.total(plan) });
                        Object.assign(this.app.counters, { checked: 0, total: this.app.search.endExclusive,
                            lastTickAt: performance.now(), lastTickChecked: 0 });
                        this.ui.progressBar.style.width = '0%'; this.ui.eta.textContent = '-';
                        this.saveCheckpoint(false);
                        this.renderSearchStage();
                        this.showExpansionNotice();
                        continue;
                    }
                    this.log('No UUID found in the full supported search range.', 'warn');
                    completed = true;
                    if (telemetry.variants.length) this.showSearchPerformance(effective, tuner, null, true);
                    this.setState('done-no-match'); break;
                }
                const variant = this.searchVariant(telemetry, effective);
                Object.assign(this.app.search, effective, { kernel: variant.kernel });
                const prefixCount = Math.max(0, config.numUnknown - 8);
                const selected = segment.direct ? null : this.parseMask(segment.mask);
                const activeNibbles = selected ? selected.nibbles
                    : this.withPrefixFixed(config.nibbles, config.unknownPositions, prefixCount, batch.prefix);
                const positions = selected ? selected.unknownPositions : config.unknownPositions.slice(prefixCount);
                const packed = this.packMaskForGPU(activeNibbles, positions);
                this.app.gpu.blobInfo = { ...this.app.gpu.blobInfo, ...packed, unknownCount: positions.length, ...effective };
                const identity = JSON.stringify([variant.kernel, effective.workgroupSize, packed.xMask, positions.length,
                    effective.algorithm === 'legacy-v1' ? [packed.f0, packed.f1] : null]);
                if (compiledVariant !== identity) {
                    const setupStart = performance.now();
                    try {
                        await this.initWebGPU(this.app.gpu.blobInfo);
                        if (!isCurrent()) return;
                        compiledVariant = identity;
                    } catch (error) {
                        if (!isCurrent()) return;
                        if (!tuner || this.app.gpu.session?.failure
                            || (requested.algorithm !== 'auto' && requested.workgroupSize !== 'auto')) throw error;
                        tuner.exclude(effective, error.message);
                        this.log(`Auto excluded ${effective.algorithm}/${effective.workgroupSize}: ${error.message}`, 'warn');
                        continue;
                    } finally {
                        if (isCurrent()) {
                            const setupMs = performance.now() - setupStart;
                            telemetry.setupMs += setupMs; variant.setupMs += setupMs; plan.stages.at(-1).setupMs += setupMs;
                        }
                    }
                }
                if (!isCurrent() || !this.app.running) break;
                // Compilation is asynchronous; retry if the selected tuning configuration changed meanwhile.
                if (tuner) {
                    const next = tuner.next();
                    if (next.algorithm !== effective.algorithm || next.batchSize !== effective.batchSize
                        || next.workgroupSize !== effective.workgroupSize) continue;
                }
                this.setState('running');
                this.showSearchPerformance(effective, tuner);
                this.app.search.batchChangingPositions = this.computeBatchChangingPositions(positions, batch.count);
                const activeStart = performance.now();
                let found = null;
                let retry = false;
                let elapsed = 0;
                try {
                    const hits = await this.runBatch(batch.low, batch.count);
                    if (!isCurrent()) return;
                    telemetry.candidatesTested += batch.count; variant.candidatesTested += batch.count;
                    plan.stages.at(-1).candidatesTested += batch.count;
                    for (const counter of hits) {
                        const uuid = this.buildUuidFromCounter(activeNibbles, positions, counter);
                        const key = await this.deriveKeyHkdf(this.hexToBytes(uuid), config.salt, config.info);
                        if (!isCurrent()) return;
                        let valid = true;
                        for (const source of this.app.gpu.parsedSources) {
                            const plaintext = await this.decryptAesCbcRaw(key, source.parsed.iv, source.parsed.ciphertext);
                            if (!isCurrent()) return;
                            if (!this.validateZeroPadding(plaintext, source.parsed.padding)) { valid = false; break; }
                        }
                        telemetry.cpuCandidates++;
                        if (valid) { found = uuid.toUpperCase(); break; }
                        telemetry.rejectedCandidates++;
                    }
                } catch (error) {
                    if (isCurrent() && error instanceof CoreFlasherUuidSearch.CandidateOverflowError) {
                        telemetry.candidatesTested += batch.count; variant.candidatesTested += batch.count;
                        plan.stages.at(-1).candidatesTested += batch.count;
                        if (tuner && requested.batchSize === 'auto') {
                            tuner.overflow(effective);
                            retry = true;
                            this.log('GPU candidate buffer full. Auto is retrying the same range with a smaller batch.', 'warn');
                        }
                    }
                    if (!retry) throw error;
                } finally {
                    if (isCurrent()) {
                        elapsed = performance.now() - activeStart;
                        telemetry.activeMs += elapsed; variant.activeMs += elapsed; plan.stages.at(-1).activeMs += elapsed;
                    }
                }
                if (!isCurrent()) return;
                if (retry) continue;
                if (!this.sourceAllowed()) throw new Error('Source disconnected. Search stopped.');
                // Publish progress only after readback and CPU verification have both succeeded.
                this.app.search.next += batch.count;
                this.app.counters.checked = this.app.search.next;
                plan.stages.at(-1).covered = this.app.search.next;
                this.updateProgress(this.buildUuidFromCounter(activeNibbles, positions, batch.low + batch.count - 1), !found);
                if (found) {
                    this.showSearchPerformance(effective, tuner, elapsed, true);
                    const report = { ...telemetry, ...this.inputFingerprint, format: 3, plan, uuid: found,
                        mask: config.mask, start: config.start, endExclusive: this.app.search.endExclusive, next: this.app.search.next,
                        foundAt: new Date().toISOString(), websiteVersion: CoreFlasherUuidRecord.WEBSITE_VERSION,
                        browser: navigator.userAgent.slice(0,256), adapter: this.app.gpu.session?.adapterInfo || null,
                        acceptance: 'cpu-zero-padding' };
                    this.setSerialNumberField(found, true);
                    this.successfulSearch = CoreFlasherUuidRecord.snapshot(report);
                    this.setState('found'); this.log('Found UUID. Save UUID can also save this search report to its box.', 'ok');
                    completed = true;
                    break;
                }
                if (tuner) {
                    tuner.observe({ config: effective, count: batch.count, elapsedMs: elapsed,
                        fullBatch: batch.count === effective.batchSize });
                    this.saveTuningProfile(this.activeTuningKey, tuner.profile);
                }
                this.showSearchPerformance(effective, tuner, elapsed);
            }
        } catch (error) {
            if (!isCurrent()) return;
            if (this.activeTuningKey && this.app.gpu.session?.failure) this.invalidateTuningProfile(this.activeTuningKey);
            this.setState('error');
            this.log(error.message, 'bad');
            throw error;
        } finally {
            if (isCurrent()) {
                this.app.running = false;
                this.closeExpansionNotice();
                this.closeLongSearchNotice();
                if (!completed) {
                    this.saveCheckpoint();
                    if (this.app.pauseRequested) this.setState('paused');
                } else { this.app.pauseCheckpoint = null; this.removeCheckpoint(); }
                this.app.pauseRequested = false;
                this.stopWebGPU();
                this.setControlsRunning(false);
            }
        }
    }
}
CoreFlasherApp.cardControllers["tile-cracker-pane"] = CardController;
})();
