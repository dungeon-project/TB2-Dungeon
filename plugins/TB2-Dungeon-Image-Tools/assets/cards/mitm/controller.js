/* MITM Setup controller. Shared services are supplied by the card context. */
(() => {
// === MITM assistant: original backup -> CA-only replacement -> optional endpoints ===

class CardController extends Tile {

    /** Bind the small guided workflow and keep all changes in the buffered image. */
    init() {
        this.backupButton = this.element.querySelector('.js-mitm-backup');
        this.backupState = this.element.querySelector('.js-mitm-backup-state');
        this.serverSetInput = this.element.querySelector('.js-mitm-server-set');
        this.serverSetName = this.element.querySelector('.js-mitm-server-set-name');
        this.caInput = this.element.querySelector('.js-mitm-ca');
        this.caName = this.element.querySelector('.js-mitm-ca-name');
        this.certModeElement = this.element.querySelector('.js-mitm-cert-mode');
        this.packageButton = this.element.querySelector('.js-mitm-package-download');
        this.packageNote = this.element.querySelector('.js-mitm-package-note');
        this.successPackageButton = this.element.querySelector('.js-mitm-success-package');
        this.settingsToggle = this.element.querySelector('.js-mitm-settings-toggle');
        this.settingsGrid = this.element.querySelector('.js-mitm-settings-grid');
        this.summaryElement = this.element.querySelector('.js-mitm-summary');
        this.reqImage = this.element.querySelector('.js-mitm-req-image');
        this.reqUuid = this.element.querySelector('.js-mitm-req-uuid');
        this.reqWrite = this.element.querySelector('.js-mitm-req-write');
        this.reqBackup = this.element.querySelector('.js-mitm-req-backup');
        this.reqCa = this.element.querySelector('.js-mitm-req-ca');
        this.writeHelp = this.element.querySelector('.js-mitm-write-help');
        this.goOptionsButton = this.element.querySelector('.js-mitm-go-options');
        this.progressEncrypt = this.element.querySelector('.js-mitm-progress-encrypt');
        this.progressWrite = this.element.querySelector('.js-mitm-progress-write');
        this.progressVerify = this.element.querySelector('.js-mitm-progress-verify');
        this.successCard = this.element.querySelector('.js-mitm-success');
        this.successInterfaceButton = this.element.querySelector('.js-mitm-success-interface');

        this.otaHost = this.element.querySelector('.js-mitm-ota-host');
        this.otaPort = this.element.querySelector('.js-mitm-ota-port');
        this.iciHost = this.element.querySelector('.js-mitm-ici-host');
        this.iciPort = this.element.querySelector('.js-mitm-ici-port');
        this.applyButton = this.element.querySelector('.js-mitm-apply');
        this.resetButton = this.element.querySelector('.js-mitm-reset');
        this.statusElement = this.element.querySelector('.js-mitm-status');
        this.errorElement = this.element.querySelector('.js-mitm-error');

        this.parser = null;
        this.selectedCaBytes = null;
        this.selectedCaSource = null;
        this.selectedServerFiles = new Map();
        this.selectedServerSetLabel = null;
        this.originalSnapshot = null;
        this.backupDownloaded = false;
        this.packageBusy = false;
        this.packageDownloaded = false;
        this.operationRunning = false;
        this.applied = false;
        this.loadedImage = null;
        this.loadedRevision = -1;

        this.backupButton.addEventListener('click', () => this.downloadOriginalBackup());
        this.serverSetInput.addEventListener('change', () => this.readSelectedServerSet());
        this.caInput.addEventListener('change', () => this.readSelectedCa());
        this.settingsToggle.addEventListener('change', () => this.updateControls());
        this.minotaurScene = CoreFlasherApp.minotaurScene;
        this.own(() => this.minotaurScene.stop());
        this.listen(document, 'visibilitychange', () => {
            if (document.hidden) this.minotaurScene.stop();
        });
        this.listen(this.applyButton, 'click', async () => {
            if (this.applyButton.disabled || this.operationRunning || this.applied) return;
            // Visual playback is independent: neither asset loading nor playback delays preparation.
            void this.minotaurScene.start();
            try { await this.prepareMitmImage(); }
            finally { if (!this.applied) this.minotaurScene.stop(); }
        });
        this.listen(this.resetButton, 'click', () => {
            this.minotaurScene.stop();
            this.resetSelection();
        });
        this.listen(matchMedia('(prefers-reduced-motion: reduce)'), 'change', event => {
            if (event.matches) this.minotaurScene.stop();
        });
        this.packageButton?.addEventListener('click', () => this.downloadCertificatePackage());
        this.successPackageButton?.addEventListener('click', () => this.downloadCertificatePackage());
        this.goOptionsButton?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            this.context.image.setEditMode('rw-buffered');
        });
        this.element.querySelector('.js-mitm-find-uuid').addEventListener('click', () => this.context.navigation.moveToCard('tile-cracker-pane'));
        this.element.querySelector('.js-mitm-load-uuid').addEventListener('click', () =>
            this.tileManager.openImageManager(this.context.uuid.scanner ? {uuidMode: 'load'} : false));
        this.element.querySelector('.js-mitm-find-uuid').hidden = !this.context.uuid.scanner;
        if (!this.context.uuid.scanner) this.element.querySelector('.js-mitm-load-uuid').textContent = 'Set box UUID in Image Manager';
        this.element.querySelector('.js-mitm-download-image').addEventListener('click', () => this.context.image.exportCurrent());
        this.element.querySelector('.js-mitm-save-image').addEventListener('click', () => this.tileManager.openImageManager(true));
        this.element.querySelector('.js-mitm-ca-source').addEventListener('change', event => {
            if (this.operationRunning || this.packageBusy || this.applied) return;
            const folder = event.target.value === 'folder';
            this.element.querySelector('.cf-mitm-server-set-label').hidden = !folder;
            this.element.querySelector('.cf-mitm-ca-fallback').hidden = folder;
            this.selectedCaBytes = null; this.selectedCaSource = null; this.selectedServerFiles = null;
            this.applied = false; this.packageDownloaded = false;
            this.serverSetInput.value = this.caInput.value = ''; this.updateControls();
        });
        // Legacy selector retained; Dump / Flash chooses the applicable write action.
        this.successInterfaceButton?.addEventListener('click', event => {
            event.preventDefault();
            event.stopPropagation();
            this.tileManager?.moveTo(0, 0);
        });
        this.element.querySelectorAll('.cf-mitm-layout summary').forEach(summary => {
            // Preserve native disclosure keyboard behavior without re-focusing the Canvas.
            summary.addEventListener('keydown', event => {
                if (event.key === 'Enter' || event.key === ' ') event.stopPropagation();
            });
        });
        this._setProgress('idle');
        this.updateControls();
    }

    /** Leaving the room stops decoration, never an ongoing image operation. */
    onLeave() {
        this.minotaurScene.stop();
        super.onLeave();
    }

    /** Reset also invalidates sprite loads that have not completed yet. */
    async reset() {
        this.minotaurScene.stop();
    }

    /** Make the tile available whenever a full image is present. */
    update() {
        const hasImage = CoreFlasherDumpUi.complete(window.interface);
        if (hasImage && !this.enabled) this.enable();
        if (!hasImage && this.enabled) this.disable();

        const revision = Number(window.AppState.interfaceRevision || 0);
        if (window.interface !== this.loadedImage || revision !== this.loadedRevision) {
            this.loadImageState().catch(error => this.showError(error));
        }
        this.updateControls();
        this.updateStyles();
    }

    /** Open the shared LittleFS region with the same parser used by File Manager. */
    async getParser() {
        if (!window.interface || typeof LittleFSParser === 'undefined') {
            throw new Error('No LittleFS image is available.');
        }
        if (this.parser && this.parser.sparseImage === window.interface) return this.parser;

        this.parser = new LittleFSParser(window.interface, 0x820000,
            window.interface.size - 0x820000);
        await this.parser.initialize();
        return this.parser;
    }

    /** Resolve the UUID already verified by the existing crypto workflow. */
    getUuidBytes() {
        const uuidText = String(this.context.uuid.normalizedValue || '')
            .replace(/[^0-9a-f]/gi, '').toUpperCase();
        if (!/^500100[0-9A-F]{10}$/.test(uuidText)) {
            throw new Error('A valid detected MCU UUID is required.');
        }
        const fileManager = this.context.filesystem.available ? this.context.filesystem : null;
        if (!fileManager || typeof fileManager.hexToBytes !== 'function') {
            throw new Error('File Manager crypto helpers are unavailable.');
        }
        return fileManager.hexToBytes(uuidText);
    }

    /** Return the existing File Manager crypto implementation. */
    getCryptoManager() {
        const manager = this.context.filesystem.available ? this.context.filesystem : null;
        if (!manager || typeof manager.decryptCryptBlob !== 'function' ||
            typeof manager.encryptPlainAsCryptBlob !== 'function') {
            throw new Error('File Manager crypto helpers are unavailable.');
        }
        return manager;
    }

    /** Reset stale workflow state after another tile changed or replaced the image. */
    async loadImageState() {
        this.loadedImage = window.interface || null;
        this.loadedRevision = Number(window.AppState.interfaceRevision || 0);
        this.parser = null;
        this.originalSnapshot = null;

        this.backupDownloaded = false;
        this.packageDownloaded = false;
        this.applied = false;
        this.successCard?.classList.add('hidden');
        this._setProgress('idle');
        this.hideError();

        if (!window.interface) {
            this.statusElement.textContent = window.DEV_MODE ? 'AWAITING_INTERFACE_IMAGE' : 'Load or connect an image to continue';
            this.updateControls();
            return;
        }
        await this.loadEndpointValues();
        this.statusElement.textContent = window.DEV_MODE ? 'READY_TO_SELECT_SERVER_CA' : 'Ready · select the server CA';
        this.updateControls();
    }

    /** Read effective endpoint values without altering duplicate settings history. */
    async loadEndpointValues() {
        const parser = await this.getParser();
        const settingsBytes = await parser.readFile('/settings');
        const records = this.parseSettingsRecords(settingsBytes);
        const latestValues = new Map(records.map(record => [record.key, record.valueBytes]));

        const decoder = new TextDecoder('ascii', { fatal: true });
        const fields = [
            ['ota/host', this.otaHost], ['ota/port', this.otaPort],
            ['ici/host', this.iciHost], ['ici/port', this.iciPort],
        ];
        for (const [key, field] of fields) {
            field.dataset.keyPresent = String(latestValues.has(key));
            field.value = latestValues.has(key) ? decoder.decode(latestValues.get(key)) : '';
            field.placeholder = latestValues.has(key) ? '' : `${key} missing`;
        }
    }

    /** Parse the append-only uint16-length settings format. */
    parseSettingsRecords(settingsBytes) {
        const records = [];
        let offset = 0;
        while (offset < settingsBytes.length) {
            if (offset + 2 > settingsBytes.length) throw new Error('Truncated settings header.');
            const recordLength = settingsBytes[offset] | (settingsBytes[offset + 1] << 8);
            const recordEnd = offset + 2 + recordLength;
            if (recordEnd > settingsBytes.length) throw new Error('Settings record exceeds file.');

            const payload = settingsBytes.slice(offset + 2, recordEnd);
            const separator = payload.indexOf(0x3d);
            if (separator < 0) throw new Error('Settings record has no key/value separator.');
            const key = new TextDecoder('utf-8', { fatal: true }).decode(payload.slice(0, separator));
            records.push({ key, valueBytes: payload.slice(separator + 1) });
            offset = recordEnd;
        }
        return records;
    }

    /** Rebuild settings while changing only the latest requested records. */
    buildSettingsBytes(originalBytes) {
        const records = this.parseSettingsRecords(originalBytes);
        const requested = this.validateEndpointInputs();
        const latestIndex = new Map(records.map((record, index) => [record.key, index]));

        for (const key of requested.keys()) {
            if (!latestIndex.has(key)) throw new Error(`Required setting is missing: ${key}`);
        }
        const encoder = new TextEncoder();
        const encodedRecords = records.map((record, index) => {
            const nextValue = latestIndex.get(record.key) === index && requested.has(record.key)
                ? encoder.encode(requested.get(record.key)) : record.valueBytes;
            return this.encodeSettingRecord(record.key, nextValue);
        });

        const totalLength = encodedRecords.reduce((sum, record) => sum + record.length, 0);
        const output = new Uint8Array(totalLength);
        let outputOffset = 0;
        for (const record of encodedRecords) {
            output.set(record, outputOffset);
            outputOffset += record.length;
        }
        return output;
    }

    /** Encode one settings key/value pair with its uint16 little-endian length. */
    encodeSettingRecord(key, valueBytes) {
        const keyBytes = new TextEncoder().encode(key);
        const payloadLength = keyBytes.length + 1 + valueBytes.length;
        if (payloadLength > 0xffff) throw new Error(`Setting is too large: ${key}`);

        const record = new Uint8Array(payloadLength + 2);
        record[0] = payloadLength & 0xff;
        record[1] = (payloadLength >>> 8) & 0xff;
        record.set(keyBytes, 2);
        record[2 + keyBytes.length] = 0x3d;
        record.set(valueBytes, 3 + keyBytes.length);
        return record;
    }

    /** Validate hostnames and decimal ASCII ports before touching LittleFS. */
    validateEndpointInputs() {
        if (!this.settingsToggle.checked) return new Map();
        const hostnamePattern = /^(?=.{1,253}$)(?!.*\.\.)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i;
        const requested = new Map();

        for (const [key, field] of [['ota/host', this.otaHost], ['ici/host', this.iciHost]]) {
            const value = field.value.trim();
            if (!hostnamePattern.test(value)) throw new Error(`Invalid hostname for ${key}.`);
            requested.set(key, value);
        }
        for (const [key, field] of [['ota/port', this.otaPort], ['ici/port', this.iciPort]]) {
            const value = field.value.trim();
            const port = Number(value);
            if (!/^\d+$/.test(value) || !Number.isInteger(port) || port < 1 || port > 65535) {
                throw new Error(`Invalid port for ${key}.`);
            }
            requested.set(key, String(port));
        }
        return requested;
    }

    /** Collect exact encrypted originals plus useful decrypted identity files. */
    async readOriginalSnapshot() {
        const image = window.interface, revision = Number(window.AppState.interfaceRevision || 0);
        const uuid = this.context.uuid.normalizedValue;
        const parser = await this.getParser();
        const cryptoManager = this.getCryptoManager();
        const uuidBytes = this.getUuidBytes();
        const salt = cryptoManager.hexToBytes('bc21551317da981e5e4650a7d238ea2c');
        const info = cryptoManager.hexToBytes('2469031c2490ad3f3bd1b05cfd5c6681');

        const encryptedPaths = [
            '/cert/ap-mode-auth.cred.crypt', '/cert/ca.der.crypt',
            '/cert/client.der.crypt', '/cert/ici-auth.cred.crypt',
            '/cert/private.der.crypt',
        ];
        const exportedPlainPaths = new Set([
            '/cert/ca.der.crypt', '/cert/client.der.crypt',
            '/cert/private.der.crypt',
        ]);
        const rawFiles = new Map();
        const decryptedFiles = new Map();
        const key = await cryptoManager.deriveKeyHkdf(uuidBytes, salt, info);

        for (const path of encryptedPaths) {
            const encrypted = await parser.readFile(path);
            const parsed = cryptoManager.parseBlob(encrypted);
            const padded = await cryptoManager.decryptAesCbcRaw(key, parsed.iv, parsed.ciphertext);
            if (!cryptoManager.validateZeroPadding(padded, parsed.padding)) {
                throw new Error('The loaded image does not match the active UUID/key. Use the UUID belonging to this image.' +
                    (window.DEV_MODE ? ` File: ${path}` : ''));
            }

            rawFiles.set(path, encrypted.slice());
            if (exportedPlainPaths.has(path)) {
                const plainLength = padded.length - parsed.padding;
                decryptedFiles.set(path, padded.slice(0, plainLength));
            }
            padded.fill(0);
        }

        for (const path of ['/cert/ca.der.crypt', '/cert/client.der.crypt', '/cert/private.der.crypt']) {
            this.validateDerSequence(decryptedFiles.get(path), path);
        }
        const settings = await parser.readFile('/settings');
        if (image !== window.interface || revision !== Number(window.AppState.interfaceRevision || 0) || uuid !== this.context.uuid.normalizedValue)
            throw new Error('Image or UUID changed while checking identity. Try again.');
        return {
            uuid,
            image: window.interface,
            revision: Number(window.AppState.interfaceRevision || 0),
            rawFiles,
            decryptedFiles,
            settings: settings.slice(),
        };
    }

    /** Require one complete top-level DER SEQUENCE, rejecting obvious wrong files. */
    validateDerSequence(bytes, label = 'certificate') {
        if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0x30) {
            throw new Error(`${label} is not a DER SEQUENCE.`);
        }
        let length = bytes[1];
        let headerLength = 2;
        if ((length & 0x80) !== 0) {
            const lengthBytes = length & 0x7f;
            if (lengthBytes < 1 || lengthBytes > 4 || 2 + lengthBytes > bytes.length) {
                throw new Error(`${label} has an invalid DER length.`);
            }
            length = 0;
            headerLength += lengthBytes;
            for (let index = 0; index < lengthBytes; index += 1) {
                length = (length * 256) + bytes[2 + index];
            }
        }
        if (headerLength + length !== bytes.length) {
            throw new Error(`${label} DER length does not match the file size.`);
        }
    }

    /** Build and download one portable JSON backup without storing the MCU UUID. */
    async downloadOriginalBackup() {
        if (this.operationRunning || !window.interface) return;
        this.operationRunning = true;
        this.updateControls();
        this.hideError();
        this.statusElement.textContent = window.DEV_MODE ? 'VERIFYING_AND_PACKING_ORIGINAL_IDENTITY...' : 'Creating identity backup...';

        try {
            const currentRevision = Number(window.AppState.interfaceRevision || 0);
            const savedRevision = Number(window.AppState.interfaceSavedRevision || 0);
            if (currentRevision !== savedRevision) {
                throw new Error('Save or reload the current image before creating the source backup.');
            }

            const snapshot = await this.readOriginalSnapshot();
            const backupFiles = [];
            for (const [path, encrypted] of snapshot.rawFiles) {
                const plain = snapshot.decryptedFiles.get(path);
                const includePlain = plain instanceof Uint8Array;
                backupFiles.push({
                    path,
                    encryptedSha256: await this.sha256Hex(encrypted),
                    encryptedBase64: this.bytesToBase64(encrypted),
                    decryptedName: includePlain
                        ? path.split('/').pop().replace(/\.crypt$/i, '') : null,
                    decryptedSha256: includePlain ? await this.sha256Hex(plain) : null,
                    decryptedBase64: includePlain ? this.bytesToBase64(plain) : null,
                });
                if (includePlain) plain.fill(0);
            }

            const backup = {
                format: 'tb2-original-cert-backup-v1',
                createdAt: new Date().toISOString(),
                warning: 'PRIVATE: client.der and private.der authenticate this box to Tonie cloud.',
                uuidIncluded: false,
                files: backupFiles,
                settings: {
                    path: '/settings',
                    sha256: await this.sha256Hex(snapshot.settings),
                    base64: this.bytesToBase64(snapshot.settings),
                },
            };
            const jsonBytes = new TextEncoder().encode(JSON.stringify(backup, null, 2));
            const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
            this.getCryptoManager().downloadBytes(jsonBytes, `TB2-original-cert-backup-${timestamp}.json`);

            snapshot.decryptedFiles.clear();
            this.originalSnapshot = snapshot;
            this.backupDownloaded = true;
            this.packageDownloaded = false;
            this.statusElement.textContent = window.DEV_MODE
                ? 'BACKUP_DOWNLOADED — STORE IT PRIVATELY AND SAFELY'
                : 'Identity backup created · keep the downloaded file private and safe';
        }
        catch (error) {
            this.showError(error);
            this.statusElement.textContent = window.DEV_MODE ? 'BACKUP_FAILED' : 'Identity backup failed';
        }
        finally {
            this.operationRunning = false;
            this.updateControls();
        }
    }

    /** Use ca.der from an existing complete TB2 server certificate directory. */
    async readSelectedServerSet() {
        const files = Array.from(this.serverSetInput.files || []);
        this.selectedCaBytes = null;
        this.selectedCaSource = null;
        this.selectedServerFiles = new Map();
        this.selectedServerSetLabel = null;
        this.packageDownloaded = false;
        this.serverSetName.textContent = 'No server set selected';
        this.hideError();
        if (files.length === 0) return this.updateControls();

        try {
            const expectedNames = [
                'ca.der', 'ca-root.pem', 'ca-key.pem',
                'teddy-cert.pem', 'teddy-key.pem',
            ];
            const filesByName = new Map();
            for (const file of files) {
                const name = file.name.toLowerCase();
                if (!filesByName.has(name)) filesByName.set(name, []);
                filesByName.get(name).push(file);
            }

            for (const name of expectedNames) {
                const matches = filesByName.get(name) || [];
                if (matches.length !== 1) {
                    throw new Error(`Server set must contain exactly one ${name}.`);
                }
            }
            const iciCertificateCount = (filesByName.get('ici.pem') || []).length;
            const iciKeyCount = (filesByName.get('ici.key') || []).length;
            if (iciCertificateCount !== iciKeyCount || iciCertificateCount > 1) {
                throw new Error('Server set contains an incomplete or ambiguous ICI certificate pair.');
            }

            const caFile = filesByName.get('ca.der')[0];
            const caBytes = new Uint8Array(await caFile.arrayBuffer());
            this.validateDerSequence(caBytes, caFile.name);

            const rootFile = filesByName.get('ca-root.pem')[0];
            const rootBytes = this.decodePemCertificate(await rootFile.text(), rootFile.name);
            if (!this.bytesEqual(caBytes, rootBytes)) {
                throw new Error('ca.der does not match ca-root.pem in the selected server set.');
            }

            const relativePath = caFile.webkitRelativePath || caFile.name;
            const folderName = relativePath.includes('/')
                ? relativePath.slice(0, relativePath.lastIndexOf('/')) : 'selected folder';
            const iciStatus = iciCertificateCount === 1 ? 'ICI pair present' : 'ICI pair generated by server';

            const retainedServerFiles = new Map();
            for (const name of expectedNames) {
                retainedServerFiles.set(name, new Uint8Array(
                    await filesByName.get(name)[0].arrayBuffer()
                ));
            }
            if (iciCertificateCount === 1) {
                retainedServerFiles.set('ici.pem', new Uint8Array(
                    await filesByName.get('ici.pem')[0].arrayBuffer()
                ));
                retainedServerFiles.set('ici.key', new Uint8Array(
                    await filesByName.get('ici.key')[0].arrayBuffer()
                ));
            }

            this.caInput.value = '';
            this.caName.textContent = 'No CA-only file selected';
            this.selectedCaBytes = caBytes;
            this.selectedCaSource = `server-set:${folderName}`;
            this.selectedServerFiles = retainedServerFiles;
            this.selectedServerSetLabel = folderName;
            this.packageDownloaded = false;
            this.serverSetName.textContent = `${folderName} · CA/root match · ${iciStatus}`;
        }
        catch (error) {
            this.showError(error);
            this.serverSetInput.value = '';
            this.selectedCaBytes = null;
            this.selectedCaSource = null;
            this.selectedServerFiles = new Map();
            this.selectedServerSetLabel = null;
        }
        this.updateControls();
    }

    /** Decode exactly one PEM certificate for comparison with the set's ca.der. */
    decodePemCertificate(pemText, label) {
        const matches = Array.from(String(pemText).matchAll(
            /-----BEGIN CERTIFICATE-----([A-Za-z0-9+/=\r\n]+)-----END CERTIFICATE-----/g));
        if (matches.length !== 1) throw new Error(`${label} must contain exactly one PEM certificate.`);

        const base64 = matches[0][1].replace(/\s+/g, '');
        const binary = atob(base64);
        const bytes = new Uint8Array(binary.length);
        for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
        this.validateDerSequence(bytes, label);
        return bytes;
    }

    /** Read and minimally validate a selected unencrypted DER CA fallback. */
    async readSelectedCa() {
        const file = this.caInput.files?.[0] || null;
        this.selectedCaBytes = null;
        this.selectedCaSource = null;
        this.selectedServerFiles = new Map();
        this.selectedServerSetLabel = null;
        this.packageDownloaded = false;
        this.caName.textContent = 'No CA selected';
        this.hideError();
        if (!file) return this.updateControls();

        try {
            const bytes = new Uint8Array(await file.arrayBuffer());
            this.validateDerSequence(bytes, file.name);
            this.serverSetInput.value = '';
            this.serverSetName.textContent = 'No server set selected';
            this.selectedServerFiles = new Map();
            this.selectedServerSetLabel = null;
            this.selectedCaBytes = bytes;
            this.selectedCaSource = `ca-file:${file.name}`;
            this.packageDownloaded = false;
            this.caName.textContent = `${file.name} · ${bytes.length} bytes · CA only`;
        }
        catch (error) {
            this.showError(error);
            this.caInput.value = '';
        }
        this.updateControls();
    }

    /** Apply CA and optional settings, then verify every protected file by readback. */
    async prepareMitmImage() {
        if (this.operationRunning || this.applied || CoreFlasherDumpUi.busy()) return;
        this.operationRunning = true;
        this.updateControls();
        this.hideError();
        let writeStarted = false;

        try {
            this.originalSnapshot = await this.readOriginalSnapshot();
            this.assertReadyToApply();
            this.successCard?.classList.add('hidden');
            this._setProgress('encrypting');
            this.statusElement.textContent = window.DEV_MODE
                ? 'PREPARING_SERVER_CA'
                : 'Preparing the selected server CA...';
            const parser = await this.getParser();
            const manager = this.getCryptoManager();
            const uuidBytes = this.getUuidBytes();
            const salt = manager.hexToBytes('bc21551317da981e5e4650a7d238ea2c');
            const info = manager.hexToBytes('2469031c2490ad3f3bd1b05cfd5c6681');

            const caPath = '/cert/ca.der.crypt';
            const originalCa = this.originalSnapshot.rawFiles.get(caPath);
            const encryptedCa = await manager.encryptPlainAsCryptBlob(
                this.selectedCaBytes, uuidBytes, salt, info);
            const settingsBytes = this.settingsToggle.checked
                ? this.buildSettingsBytes(this.originalSnapshot.settings) : this.originalSnapshot.settings;

            this.assertReadyToApply();
            this._setProgress('writing');
            this.statusElement.textContent = window.DEV_MODE
                ? 'WRITING_CA_AND_OPTIONAL_SETTINGS...'
                : 'Updating the buffered LittleFS image...';
            writeStarted = true;
            const caResult = await parser.writeFileChecked(caPath, encryptedCa, originalCa);
            if (!caResult?.success) throw new Error(caResult?.error || 'CA write failed.');
            if (!this.bytesEqual(settingsBytes, this.originalSnapshot.settings)) {
                const settingsResult = await parser.writeFileChecked(
                    '/settings', settingsBytes, this.originalSnapshot.settings);
                if (!settingsResult?.success) throw new Error(settingsResult?.error || 'Settings write failed.');
            }

            this._setProgress('verifying');
            this.statusElement.textContent = window.DEV_MODE
                ? 'VERIFYING_PREPARED_IMAGE'
                : 'Verifying the server CA, protected identity and settings...';
            await this.verifyPreparedImage(settingsBytes, uuidBytes, salt, info);
            this.applied = true;
            this._setProgress('done');
            this.successCard?.classList.remove('hidden');
            this.statusElement.textContent = window.DEV_MODE
                ? 'MITM_IMAGE_PREPARED_AND_VERIFIED — SAVE OR FLASH FROM INTERFACE'
                : 'Prepared and verified successfully';
        }
        catch (error) {
            let finalError = error;
            if (writeStarted) {
                try {
                    await this.restoreLogicalOriginals();
                }
                catch (rollbackError) {
                    finalError = new Error(`${error.message}\nROLLBACK_FAILED: ${rollbackError.message}`);
                }
            }
            this._setProgress('error');
            this.successCard?.classList.add('hidden');
            this.showError(finalError);
            this.statusElement.textContent = window.DEV_MODE
                ? (writeStarted
                    ? 'MITM_PREPARATION_FAILED — RELOAD ORIGINAL IMAGE BEFORE EXPORT'
                    : 'MITM_PREPARATION_BLOCKED')
                : (writeStarted
                    ? 'MITM preparation failed · reload the original image before export'
                    : 'MITM preparation blocked');
        }
        finally {
            if (writeStarted) {
                window.AppState.interfaceRevision = Number(window.AppState.interfaceRevision || 0) + 1;
                this.loadedRevision = window.AppState.interfaceRevision;
                if (this.originalSnapshot) this.originalSnapshot.revision = this.loadedRevision;
                this.tileManager?.broadcastUpdate(this);
            }
            this.operationRunning = false;
            this.updateControls();
        }
    }

    /** Refuse stale source snapshots, read-only images or invalid fields. */
    assertReadyToApply() {
        if (!this.originalSnapshot) {
            throw new Error('The source identity must be checked first.');
        }
        if (!this.selectedCaBytes) {
            throw new Error('Select a complete TeddyCloud server certificate set or one matching DER CA first.');
        }
        if (window.interface?.readOnly || window.AppState.interfaceMode !== 'rw-buffered') {
            throw new Error(window.DEV_MODE ? 'Enable Read / Write Buffered mode before preparing the image.' : 'Enable Read / Write before preparing the image.');
        }
        if (this.originalSnapshot.image !== window.interface ||
            this.originalSnapshot.revision !== Number(window.AppState.interfaceRevision || 0) ||
            this.originalSnapshot.uuid !== this.context.uuid.normalizedValue) {
            throw new Error('The source image or UUID changed. Prepare the image again.');
        }
        this.validateEndpointInputs();
    }

    /** Verify new CA plaintext, settings, and byte-identical box identity files. */
    async verifyPreparedImage(expectedSettings, uuidBytes, salt, info) {
        const parser = await this.getParser();
        const manager = this.getCryptoManager();
        const caPath = '/cert/ca.der.crypt';
        const writtenCa = await parser.readFile(caPath);
        const plainCa = await manager.decryptCryptBlob(writtenCa, uuidBytes, salt, info);
        if (!this.bytesEqual(plainCa, this.selectedCaBytes)) {
            throw new Error('CA readback does not match the selected DER file.');
        }

        const protectedPaths = [
            '/cert/ap-mode-auth.cred.crypt', '/cert/client.der.crypt',
            '/cert/ici-auth.cred.crypt', '/cert/private.der.crypt',
        ];
        for (const path of protectedPaths) {
            const current = await parser.readFile(path);
            if (!this.bytesEqual(current, this.originalSnapshot.rawFiles.get(path))) {
                throw new Error(`Protected identity file changed unexpectedly: ${path}`);
            }
        }
        const writtenSettings = await parser.readFile('/settings');
        if (!this.bytesEqual(writtenSettings, expectedSettings)) {
            throw new Error('Settings readback does not match the requested endpoints.');
        }
    }

    /** Restore logical contents after a failed multi-file operation. */
    async restoreLogicalOriginals() {
        const parser = await this.getParser();
        const caPath = '/cert/ca.der.crypt';
        const currentCa = await parser.readFile(caPath);
        const originalCa = this.originalSnapshot.rawFiles.get(caPath);
        if (!this.bytesEqual(currentCa, originalCa)) {
            const result = await parser.writeFileChecked(caPath, originalCa, currentCa);
            if (!result?.success) throw new Error(result?.error || 'CA rollback failed.');
        }

        const currentSettings = await parser.readFile('/settings');
        if (!this.bytesEqual(currentSettings, this.originalSnapshot.settings)) {
            const result = await parser.writeFileChecked(
                '/settings', this.originalSnapshot.settings, currentSettings);
            if (!result?.success) throw new Error(result?.error || 'Settings rollback failed.');
        }
    }

    /** Clear user choices without discarding the downloaded original snapshot. */
    resetSelection() {
        this.serverSetInput.value = '';
        this.serverSetName.textContent = 'No server set selected';
        this.caInput.value = '';
        this.selectedCaBytes = null;
        this.selectedCaSource = null;
        this.selectedServerFiles = new Map();
        this.selectedServerSetLabel = null;
        this.packageDownloaded = false;
        this.caName.textContent = 'No CA selected';
        this.settingsToggle.checked = false;
        this.applied = false;
        this.successCard?.classList.add('hidden');
        this._setProgress('idle');
        this.hideError();
        this.loadEndpointValues().catch(error => this.showError(error));
        this.statusElement.textContent = window.DEV_MODE
            ? (this.backupDownloaded ? 'BACKUP_AVAILABLE — SELECT_A_CA' : 'READY_TO_SELECT_SERVER_CA')
            : (this.backupDownloaded ? 'Identity backup ready · choose the server CA' : 'Ready · select the server CA');
        this.updateControls();
    }

    /** Keep controls, requirements and explanations synchronized with current state. */
    updateControls() {
        const hasImage = CoreFlasherDumpUi.complete(window.interface);
        const uuidText = String(this.context.uuid.normalizedValue || '')
            .replace(/[^0-9a-f]/gi, '').toUpperCase();
        const uuidValid = /^500100[0-9A-F]{10}$/.test(uuidText);
        const writable = window.AppState.interfaceMode === 'rw-buffered' && !!window.interface && !window.interface.readOnly;
        const hasCa = this.selectedCaBytes instanceof Uint8Array;
        const hasCompleteServerSet = this.selectedCaSource?.startsWith('server-set:') &&
            this.selectedServerFiles instanceof Map &&
            ['ca.der','ca-root.pem','ca-key.pem','teddy-cert.pem','teddy-key.pem'].every(name => this.selectedServerFiles.has(name));
        const externallyBusy = CoreFlasherDumpUi.busy() || this.context.operations.otherCardBusy(this);
        const canBuildPackage = !externallyBusy && hasCompleteServerSet && hasImage &&
            uuidValid && !this.operationRunning && !this.packageBusy;
        const inputsBusy = this.operationRunning || this.packageBusy || externallyBusy;
        const settingsEnabled = this.settingsToggle.checked && !inputsBusy && !this.applied;

        const setReq = (element, ok, yes, no) => {
            if (!element) return;
            element.textContent = ok ? yes : no;
            element.classList.toggle('text-secondary', ok);
            element.classList.toggle('text-amber-300', !ok);
        };
        setReq(this.reqImage, hasImage, 'Ready', 'Missing');
        setReq(this.reqUuid, uuidValid, uuidText, 'Missing / invalid');
        setReq(this.reqWrite, writable, 'Read / Write', 'Read Only');
        setReq(this.reqBackup, this.backupDownloaded, 'Downloaded', 'Optional');
        setReq(this.reqCa, hasCa, 'Selected', 'Not selected');
        this.writeHelp?.classList.toggle('hidden', writable);
        this.goOptionsButton.hidden = writable;
        this.goOptionsButton.disabled = writable || !CoreFlasherDumpUi.complete(window.interface) || this.operationRunning;
        this.element.querySelector('.cf-mitm-next-help').textContent = Firmware0408.requiresFullImage(window.interface)
            ? 'Next: write the full image in Dump / Flash, download it or save it to Image Manager.'
            : 'Next: write changes in Dump / Flash, download the image or save it to Image Manager.';

        if (this.backupState) {
            this.backupState.textContent = this.backupDownloaded ? 'Downloaded' : 'Optional';
            this.backupState.classList.toggle('text-secondary', this.backupDownloaded);
            this.backupState.classList.toggle('text-amber-300', !this.backupDownloaded);
        }

        this.backupButton.disabled = !hasImage || !uuidValid || inputsBusy;
        this.element.querySelector('.js-mitm-ca-source').disabled = inputsBusy || this.applied;
        this.serverSetInput.disabled = !hasImage || inputsBusy || this.applied;
        this.caInput.disabled = !hasImage || inputsBusy || this.applied;
        this.settingsToggle.disabled = !hasImage || inputsBusy || this.applied;
        this.settingsGrid.classList.toggle('opacity-40', !settingsEnabled);
        for (const field of [this.otaHost, this.otaPort, this.iciHost, this.iciPort]) {
            field.disabled = !settingsEnabled || field.dataset.keyPresent !== 'true' || this.applied;
        }

        if (this.certModeElement) {
            this.certModeElement.textContent = hasCompleteServerSet ? 'Complete server set' : hasCa ? 'CA only' : 'No CA selected';
            this.certModeElement.classList.toggle('text-secondary', hasCompleteServerSet);
            this.certModeElement.classList.toggle('text-amber-300', hasCa && !hasCompleteServerSet);
            this.certModeElement.classList.toggle('text-zinc-400', !hasCa);
        }
        if (this.packageButton) this.packageButton.disabled = !canBuildPackage;
        if (this.successPackageButton) this.successPackageButton.disabled = !canBuildPackage;

        if (this.packageNote) {
            if (hasCompleteServerSet) {
                this.packageNote.textContent = this.packageDownloaded
                    ? 'Certificate package downloaded. It can be downloaded again while this server set remains selected.'
                    : 'Ready: package = selected server/* files + this box client/ca.der, client/client.der and client/private.der.';

            } else if (hasCa) {
                this.packageNote.textContent = 'CA-only mode cannot create a complete TeddyCloud server package because the matching server certificate and private key were not supplied.';
            } else {
                this.packageNote.textContent = 'Select an existing TeddyCloud server certificate set or CA file. TB2 Dungeon does not generate certificates.';
            }
        }

        const endpoints = this.settingsToggle.checked
            ? `${this.otaHost.value || 'OTA host'}:${this.otaPort.value || 'port'} · ${this.iciHost.value || 'ICI host'}:${this.iciPort.value || 'port'}`
            : 'unchanged';
        if (this.summaryElement) {
            if (!hasCa) {
                this.summaryElement.textContent = 'No server CA selected. The original box CA remains unchanged; no certificate is generated automatically and Prepare MITM image stays unavailable.';
            } else {
                const caText = hasCompleteServerSet
                    ? `server set "${this.selectedServerSetLabel || 'selected folder'}" (ca.der)`
                    : `CA-only file (${String(this.selectedCaSource || '').replace(/^ca-file:/, '') || 'selected DER'})`;
                this.summaryElement.textContent = `Server CA: ${caText}. Endpoints: ${endpoints}. Box identity files remain unchanged. Output: buffered image only.`;
            }
        }

        const ready = hasImage && uuidValid && writable && hasCa && !inputsBusy;
        this.applyButton.disabled = !ready || this.applied;
        this.resetButton.disabled = this.operationRunning || this.packageBusy;
        this._syncCompactPresentation();
    }

    /** Presentation only: never mutate inputs, image, certificates or operation flags. */
    _syncCompactPresentation() {
        const prepared = !!this.applied;
        this.element.dataset.prepared = String(prepared);
        const setup = this.element.querySelector('.cf-mitm-setup-details');
        if (this._compactPrepared !== prepared) {
            if (setup) setup.open = !prepared;
            this._compactPrepared = prepared;
        }
        const state = this.element.querySelector('.cf-mitm-setup-state');
        if (state) state.textContent = prepared ? 'Prepared · show inputs' : 'Select a CA';
        const endpointState = this.element.querySelector('.cf-mitm-endpoint-state');
        if (endpointState) {
            endpointState.textContent = this.settingsToggle.checked ? 'Changes enabled' : 'Unchanged';
            endpointState.classList.toggle('text-amber-300', this.settingsToggle.checked);
        }
    }

    /** Update preparation steps without fake percentage progress. */
    _setProgress(stage) {
        const progress = this.element.querySelector('.cf-mitm-progress');
        // Keep real stages available while working or on error; success has its own result card.
        if (progress) progress.hidden = stage === 'idle' || stage === 'done';
        const order = { idle:0, encrypting:1, writing:2, verifying:3, done:4, error:-1 };
        const current = order[stage] ?? 0;
        const rows = [
            [1, this.progressEncrypt, '1 · Prepare server CA'],
            [2, this.progressWrite, '2 · Update buffered LittleFS'],
            [3, this.progressVerify, '3 · Verify identity and settings'],
        ];
        for (const [step, element, label] of rows) {
            if (!element) continue;
            element.className = element.className.replace(/text-(?:zinc-500|sky-300|secondary|error)|border-(?:zinc-800|sky-500\/40|secondary\/40|error\/40)|bg-(?:sky-500\/5|secondary\/5|error\/5)/g, '').replace(/\s+/g,' ').trim();
            if (stage === 'error' && step === (this._lastProgressStep || 1)) {
                element.classList.add('text-error','border-error/40','bg-error/5');
                element.textContent = `Failed · ${label}`;
            } else if (stage === 'done' || current > step) {
                element.classList.add('text-secondary','border-secondary/40','bg-secondary/5');
                element.textContent = `Done · ${label}`;
            } else if (current === step) {
                element.classList.add('text-sky-300','border-sky-500/40','bg-sky-500/5');
                element.textContent = `Working · ${label}`;
                this._lastProgressStep = step;
            } else {
                element.classList.add('text-zinc-500','border-zinc-800');
                element.textContent = label;
            }
        }
        if (stage === 'idle') this._lastProgressStep = 1;
    }

    /** Decrypt the three box identity files required by TeddyCloud's client directory. */
    async _readClientIdentityForPackage() {
        if (!this.originalSnapshot?.rawFiles) throw new Error('Source identity has not been checked.');
        const manager = this.getCryptoManager();
        const uuidBytes = this.getUuidBytes();
        const salt = manager.hexToBytes('bc21551317da981e5e4650a7d238ea2c');
        const info = manager.hexToBytes('2469031c2490ad3f3bd1b05cfd5c6681');
        const key = await manager.deriveKeyHkdf(uuidBytes, salt, info);
        const out = new Map();
        for (const [sourcePath, outputName] of [
            ['/cert/ca.der.crypt','ca.der'],
            ['/cert/client.der.crypt','client.der'],
            ['/cert/private.der.crypt','private.der'],
        ]) {
            const encrypted = this.originalSnapshot.rawFiles.get(sourcePath);
            if (!(encrypted instanceof Uint8Array)) throw new Error(`Original identity file is missing: ${sourcePath}`);
            const parsed = manager.parseBlob(encrypted);
            const padded = await manager.decryptAesCbcRaw(key, parsed.iv, parsed.ciphertext);
            if (!manager.validateZeroPadding(padded, parsed.padding)) {
                padded.fill(0);
                throw new Error('The loaded image does not match the active UUID/key. Use the UUID belonging to this image.' +
                    (window.DEV_MODE ? ` File: ${sourcePath}` : ''));
            }
            const plain = padded.slice(0, padded.length - parsed.padding);
            padded.fill(0);
            this.validateDerSequence(plain, outputName);
            out.set(outputName, plain);
        }
        return out;
    }

    _zipCrc32(bytes) {
        if (!this._zipCrcTable) {
            this._zipCrcTable = new Uint32Array(256);
            for (let n=0;n<256;n++) {
                let c=n;
                for (let k=0;k<8;k++) c=(c&1)?(0xEDB88320^(c>>>1)):(c>>>1);
                this._zipCrcTable[n]=c>>>0;
            }
        }
        let crc=0xFFFFFFFF;
        for (const byte of bytes) crc=this._zipCrcTable[(crc^byte)&0xFF]^(crc>>>8);
        return (crc^0xFFFFFFFF)>>>0;
    }

    /** Create an uncompressed ZIP locally; no certificate/private-key data is uploaded. */
    _buildStoredZip(entries) {
        const enc=new TextEncoder();
        const u16=v=>new Uint8Array([v&255,(v>>>8)&255]);
        const u32=v=>new Uint8Array([v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255]);
        const join=parts=>{ const n=parts.reduce((s,p)=>s+p.length,0),o=new Uint8Array(n); let x=0; for(const p of parts){o.set(p,x);x+=p.length;} return o; };
        const now=new Date();
        const dt=((now.getHours()&31)<<11)|((now.getMinutes()&63)<<5)|(Math.floor(now.getSeconds()/2)&31);
        const dd=(((now.getFullYear()-1980)&127)<<9)|(((now.getMonth()+1)&15)<<5)|(now.getDate()&31);
        const local=[],central=[]; let offset=0;
        for(const entry of entries){
            const name=enc.encode(entry.name),data=entry.bytes instanceof Uint8Array?entry.bytes:new Uint8Array(entry.bytes),crc=this._zipCrc32(data);
            const l=join([u32(0x04034B50),u16(20),u16(0x0800),u16(0),u16(dt),u16(dd),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),name,data]);
            local.push(l);
            central.push(join([u32(0x02014B50),u16(20),u16(20),u16(0x0800),u16(0),u16(dt),u16(dd),u32(crc),u32(data.length),u32(data.length),u16(name.length),u16(0),u16(0),u16(0),u16(0),u32(0),u32(offset),name]));
            offset+=l.length;
        }
        const centralSize=central.reduce((s,p)=>s+p.length,0);
        const end=join([u32(0x06054B50),u16(0),u16(0),u16(entries.length),u16(entries.length),u32(centralSize),u32(offset),u16(0)]);
        return join([...local,...central,end]);
    }

    /** Assemble selected server certs and this box's original client identity into one archive. */
    async downloadCertificatePackage() {
        if (this.packageBusy || this.operationRunning) return;
        const required=['ca.der','ca-root.pem','ca-key.pem','teddy-cert.pem','teddy-key.pem'];
        const complete=this.selectedServerFiles instanceof Map && required.every(name=>this.selectedServerFiles.has(name));
        if (!complete) { this.showError('A complete TeddyCloud server certificate set is required to build the package.'); return; }

        this.packageBusy=true;
        this.hideError();
        this.statusElement.textContent=window.DEV_MODE?'BUILDING_TEDDYCLOUD_CERTIFICATE_PACKAGE':'Building TeddyCloud certificate package...';
        this.updateControls();
        let clientFiles=null;
        try {
            if (!this.originalSnapshot) this.originalSnapshot = await this.readOriginalSnapshot();
            clientFiles=await this._readClientIdentityForPackage();
            const entries=[];
            for(const [name,bytes] of this.selectedServerFiles) entries.push({name:`server/${name}`,bytes:bytes.slice()});
            for(const [name,bytes] of clientFiles) entries.push({name:`client/${name}`,bytes});
            const manifest={format:'tb2-teddycloud-certificate-package-v1',createdAt:new Date().toISOString(),serverSource:this.selectedServerSetLabel||'selected server set',serverFiles:[...this.selectedServerFiles.keys()].sort(),clientFiles:[...clientFiles.keys()].sort(),generatedCertificates:false,note:'server/ contains the selected TeddyCloud server certificate set; client/ contains this box original CA/client certificate/private key. Keep private.'};
            entries.push({name:'manifest.json',bytes:new TextEncoder().encode(JSON.stringify(manifest,null,2))});
            entries.push({name:'README.txt',bytes:new TextEncoder().encode([
                'TB2 Dungeon - TeddyCloud certificate package','',
                'server/ = selected TeddyCloud server certificate set',
                'client/ = this Toniebox 2 original ca.der, client.der and private.der','',
                'No new CA or key pair was generated.',
                'server/ca.der is the CA prepared for /cert/ca.der.crypt in the box image.','',
                'PRIVATE: client/private.der and client/client.der identify this box.','Store this archive securely and do not share it.',''
            ].join('\n'))});
            const zip=this._buildStoredZip(entries);
            const stamp=new Date().toISOString().replace(/[:.]/g,'-');
            this.getCryptoManager().downloadBytes(zip,`TeddyCloud-TB2-cert-package-${stamp}.zip`);
            this.packageDownloaded=true;
            this.statusElement.textContent=window.DEV_MODE?'TEDDYCLOUD_CERTIFICATE_PACKAGE_DOWNLOADED':'TeddyCloud certificate package downloaded';
        } catch(error) {
            this.showError(error);
            this.statusElement.textContent=window.DEV_MODE?'CERTIFICATE_PACKAGE_FAILED':'Certificate package creation failed';
        } finally {
            if(clientFiles instanceof Map){ for(const bytes of clientFiles.values()) if(bytes instanceof Uint8Array) bytes.fill(0); clientFiles.clear(); }
            this.packageBusy=false;
            this.updateControls();
        }
    }

    /** Compare two byte arrays without converting secrets to strings. */
    bytesEqual(left, right) {
        if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) ||
            left.length !== right.length) return false;
        for (let index = 0; index < left.length; index += 1) {
            if (left[index] !== right[index]) return false;
        }
        return true;
    }

    /** Calculate a lowercase SHA-256 for backup integrity metadata. */
    async sha256Hex(bytes) {
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
    }

    /** Encode the small certificate files without call-stack-sensitive spreading. */
    bytesToBase64(bytes) {
        let binary = '';
        for (let offset = 0; offset < bytes.length; offset += 0x8000) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
        }
        return btoa(binary);
    }

    /** Display one actionable error while preserving its full diagnostic text. */
    showError(error) {
        this.errorElement.textContent = String(error?.message || error || 'Unknown error');
        this.errorElement.classList.remove('hidden');
        console.error('MITM setup failed:', error);
    }

    /** Clear the visible error without swallowing future failures. */
    hideError() {
        this.errorElement.textContent = '';
        this.errorElement.classList.add('hidden');
    }
}
CoreFlasherApp.cardControllers["tile-mitm-setup"] = CardController;
})();
