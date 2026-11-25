/* Custom image preparation reuses the checked firmware and LittleFS readers. */
'use strict';
class CustomImageBuilder {
    static LEGACY_BLUETOOTH_REGION = Object.freeze([0x580000, 0x800000]);
    static BLUETOOTH_FILES = Object.freeze({'/bt/hash':16, '/bt/id':7, '/bt/irk':16});
    static CHECKS = Object.freeze({
        "source-size": "Source: complete 16 MiB image",
        "source-version": "Source: firmware 0.40.8 or newer",
        "source-layout": "Source: supported bootloader and layout",
        "source-files": "Source: settings and certificates readable",
        "source-wifi": "Source: configured WiFi profile",
        "source-lifecycle": "Source: readable lifecycle setting",
        "target-size": "Target: complete input file",
        "target-version": "Target: firmware version and slot selected",
        "target-location": "Target: compatible firmware layout",
        "protected": "Protected source data present"
    });

    /** Numeric ordering avoids treating 1.6.9 as newer than 1.6.28. */
    static version(value) {
        const match = /^(\d+)\.(\d+)\.(\d+)\+(\d+)$/.exec(value);
        if (!match) throw new Error('Firmware version could not be read.');
        return match.slice(1).map(Number);
    }
    static compare(left, right) {
        const a = this.version(left), b = this.version(right);
        for (let index = 0; index < a.length; index++) if (a[index] !== b[index]) return a[index] - b[index];
        return 0;
    }
    static newest(slots) {
        const occupied = slots.filter(slot => slot.occupied);
        if (!occupied.length) throw new Error('No valid firmware found.');
        return occupied.sort((a, b) => this.compare(b.version, a.version) || b.start - a.start)[0];
    }
    static allowedVersion(version) {
        return this.compare(version, '0.40.8+0') >= 0;
    }

    /** Existing dump parsing additionally checks installed trailers and original XIP placement. */
    static async slots(bytes) {
        return Promise.all([Firmware0408.PRIMARY, Firmware0408.SECONDARY].map(start => Firmware0408.inspectSlot(bytes, start)));
    }

    /** One explicit input kind prevents accidental mixing of a dump and an OTA file. */
    static validateTargetSize(bytes, kind) {
        if (!(bytes instanceof Uint8Array)) throw new Error('Select a full dump or an OTA file.');
        if (kind === 'dump' && bytes.length === Firmware0408.SIZE) return;
        if (kind === 'ota' && bytes.length >= 32 && bytes.length <= Firmware0408.SLOT_SIZE - Firmware0408.TRAILER_SIZE) return;
        throw new Error(kind === 'ota' ? 'Select a complete OTA container smaller than one firmware slot.' : 'Select a complete 16 MiB target image.');
    }

    /** Enumerate valid version-slot pairs and retain only the chosen container and trailer. */
    static async targetInput(bytes, kind = 'dump', requestedStart = null) {
        this.validateTargetSize(bytes, kind);
        const options = kind === 'ota' ? [await Firmware0408.inspectOta(bytes)]
            : (await this.slots(bytes)).filter(slot => slot.occupied);
        if (!options.length) throw new Error('No valid firmware found.');
        if (requestedStart !== null && !options.some(slot => slot.start === requestedStart)) {
            throw new Error('The selected firmware slot is not present in the target.');
        }
        const selected = requestedStart === null
            ? (options.length === 1 ? options[0] : null)
            : options.find(slot => slot.start === requestedStart);
        if (!selected) return {options, selected:null};
        const container = kind === 'ota' ? bytes : bytes.subarray(selected.start, selected.end);
        const trailer = kind === 'ota' ? Firmware0408.confirmedTrailer()
            : bytes.subarray(selected.start + Firmware0408.SLOT_SIZE - Firmware0408.TRAILER_SIZE, selected.start + Firmware0408.SLOT_SIZE);
        const otherStart = selected.start === Firmware0408.PRIMARY ? Firmware0408.SECONDARY : Firmware0408.PRIMARY;
        return {options, selected, otherStart, container, trailer};
    }
    static usableWifi(settings, codec, version) {
        const draft = new WifiProfiles(settings, codec, version.split('+')[0]);
        if (draft.records.some(record => !record.key)) throw new Error('Settings contain an empty key.');
        const limit = version.split('+')[0] === '0.40.8' ? WifiProfiles.BASE_PROFILES : WifiProfiles.LIMIT;
        return draft.profiles.slice(0, limit).some(profile => {
            if (!profile.ssid || !profile.fields.get('security')?.length ||
                !Object.hasOwn(WifiProfiles.SECURITY, profile.security)) return false;
            profile.touched = new Set(['ssid', 'psk', 'security']);
            try { draft.validate(profile); return true; } catch { return false; }
        });
    }

    /** Only the observed legacy Bluetooth-only filesystem may be omitted. */
    static async removableBluetooth(bytes, region) {
        if (!region.every((value, index) => value === this.LEGACY_BLUETOOTH_REGION[index])) return false;
        const image = SparseImage.fromBuffer(bytes); image.readOnly = true;
        const parser = new LittleFSParser(image, region[0], region[1] - region[0]);
        await parser.initialize();
        const entries = (await parser.fs.listAll()).filter(entry => entry.type !== 0xFF);
        if (entries.length !== Object.keys(this.BLUETOOTH_FILES).length + 1) return false;
        const seen = new Set();
        for (const entry of entries) {
            if (seen.has(entry.path)) return false;
            seen.add(entry.path);
            if (entry.path === '/bt' && entry.type === 2) continue;
            if (entry.type !== 1 || !Object.hasOwn(this.BLUETOOTH_FILES, entry.path)) return false;
            const data = await parser.readFile(entry.path);
            if (data.length !== this.BLUETOOTH_FILES[entry.path]) return false;
        }
        return seen.has('/bt');
    }

    /** Independent check rows remain useful even when another prerequisite has failed. */
    static async inspect(source, target, codec, kind = 'dump', requestedStart = null) {
        const rows = [], facts = {};
        const check = async (id, action, enabled = true) => {
            const label = id === 'target-size' ? (kind === 'ota' ? 'Target: complete OTA container' : 'Target: complete 16 MiB image') : this.CHECKS[id];
            const row = {id, label, status: 'pending', message: ''}; rows.push(row);
            if (!enabled) return false;
            try { const notice = await action(); row.status = notice ? 'warning' : 'passed'; row.message = notice || ''; return true; }
            catch (error) { row.status = 'failed'; row.message = error.message; return false; }
        };
        const require = (condition, message) => { if (!condition) throw new Error(message); };
        const sourceComplete = await check('source-size', () =>
            require(source instanceof Uint8Array && source.length === Firmware0408.SIZE, 'Load a complete 16 MiB working image.'));
        const sourceSlots = await check('source-version', async () => {
            facts.sourceSlots = await this.slots(source); facts.sourceFirmware = this.newest(facts.sourceSlots);
            require(this.allowedVersion(facts.sourceFirmware.version), 'Source firmware must be 0.40.8 or newer.');
        }, sourceComplete);
        const sourceLayout = await check('source-layout', async () => {
            require(await Firmware0408.hash(source.subarray(0, Firmware0408.PRIMARY)) === Firmware0408.BOOT_SHA, 'Unsupported source bootloader.');
            facts.regions = Firmware0408.regions(source, facts.sourceSlots);
            Firmware0408.inventory(source, facts.sourceSlots, facts.regions);
        }, sourceSlots);
        await check('source-files', async () => {
            facts.trees = await Promise.all(facts.regions.map(([start, end]) => Firmware0408.fileTree(source, start, end - start)));
        }, sourceLayout);
        await check('source-wifi', async () => {
            const parser = await WifiImage.parser(SparseImage.fromBuffer(source));
            const settings = await parser.readFile('/settings');
            require(this.usableWifi(settings, codec, facts.sourceFirmware.version), 'Configure at least one supported WiFi profile in WiFi Manager.');
        }, sourceSlots);

        await check('source-lifecycle', async () => {
            const parser = await WifiImage.parser(SparseImage.fromBuffer(source));
            facts.lifecycle = UpdateImageLifecycle.inspect(await parser.readFile('/settings')).value;
        }, sourceComplete);

        const targetComplete = await check('target-size', () => this.validateTargetSize(target, kind));
        const targetSlots = await check('target-version', async () => {
            Object.assign(facts, await this.targetInput(target, kind, requestedStart));
            require(facts.selected, 'Choose a firmware version and slot from the target dump.');
        }, targetComplete);
        await check('target-location', async () => {
            // The selected container and trailer must fit around source-owned data.
            const destinations = [
                [facts.selected.start, facts.selected.end],
                [facts.selected.start + Firmware0408.SLOT_SIZE - Firmware0408.TRAILER_SIZE,
                    facts.selected.start + Firmware0408.SLOT_SIZE]
            ];
            require(!destinations.some(range => Firmware0408.overlap(range, Firmware0408.PROTECTED)),
                'Firmware overlaps the protected source data.');
            facts.omittedRegions = [];
            for (const region of facts.regions) {
                const collision = destinations.some(range => Firmware0408.overlap(region, range));
                const legacyBluetooth = region.every((value, index) => value === this.LEGACY_BLUETOOTH_REGION[index]);
                if (!collision && !legacyBluetooth) continue;
                const removable = await this.removableBluetooth(source, region);
                require(!collision || removable, 'A source filesystem overlaps the new firmware.');
                if (removable) facts.omittedRegions.push(region);
            }
            if (facts.omittedRegions.length) return 'The legacy Bluetooth filesystem will be erased. Bluetooth identity data will be lost; device behavior is unverified.';
        }, targetSlots && sourceLayout);
        await check('protected', () => {
            const [start, end] = Firmware0408.PROTECTED;
            const left = source.subarray(start, end);
            require(!Firmware0408.erased(left) && !left.every(byte => byte === 0), 'Protected source data is empty.');
            // OTAs have no device sector. Only full dumps participate in this existing comparison.
            if (kind === 'ota' || !targetComplete) return;
            const right = target.subarray(start, end);
            require(!Firmware0408.erased(right) && !right.every(byte => byte === 0), 'Protected target data is empty.');
            if (Firmware0408.equal(left, right)) return 'Source and target contain the same protected data. Building is allowed; source data remains unchanged.';
        }, sourceComplete);
        return {rows, facts, valid: rows.every(row => ['passed', 'warning'].includes(row.status))};
    }

    /** Construct privately with one firmware slot; retain source files except checked Bluetooth data. */
    static async build(source, target, codec, kind = 'dump', lifecycle = null, requestedStart = null) {
        const checked = await this.inspect(source, target, codec, kind, requestedStart);
        if (!checked.valid) throw new Error(checked.rows.find(row => row.status === 'failed')?.message || 'Complete all image checks first.');
        const {selected, otherStart, container, trailer, omittedRegions = []} = checked.facts;
        const retainedIndices = checked.facts.regions.map((_, index) => index)
            .filter(index => !omittedRegions.includes(checked.facts.regions[index]));
        const regions = retainedIndices.map(index => checked.facts.regions[index]);
        const trees = retainedIndices.map(index => checked.facts.trees[index]);
        const candidate = source.slice();
        candidate.fill(0xFF, Firmware0408.PRIMARY, Firmware0408.LFS);
        candidate.set(container, selected.start);
        candidate.set(trailer, selected.start + Firmware0408.SLOT_SIZE - Firmware0408.TRAILER_SIZE);
        // Restore only known source-owned regions; target padding and files are never imported.
        const preserved = [[0, Firmware0408.PRIMARY], ...regions, Firmware0408.PROTECTED];
        for (const [start, end] of preserved) candidate.set(source.subarray(start, end), start);
        for (const [start, end] of preserved) if (!Firmware0408.equal(source.subarray(start, end), candidate.subarray(start, end))) throw new Error('Protected source data changed.');
        // Reparse both slots: the selected one is intact and the other has no firmware.
        const slots = await this.slots(candidate);
        if (slots.find(slot => slot.start === selected.start)?.version !== selected.version) throw new Error('Firmware version verification failed.');
        if (slots.find(slot => slot.start === otherStart)?.occupied ||
            !Firmware0408.erased(candidate.subarray(otherStart + Firmware0408.SLOT_SIZE - Firmware0408.TRAILER_SIZE,
                otherStart + Firmware0408.SLOT_SIZE))) throw new Error('Other firmware slot is not empty.');
        const trailerOffset = Firmware0408.SLOT_SIZE - Firmware0408.TRAILER_SIZE;
        if (!Firmware0408.equal(candidate.subarray(selected.start, selected.end), container) ||
            !Firmware0408.equal(candidate.subarray(selected.start + trailerOffset, selected.start + Firmware0408.SLOT_SIZE), trailer)) {
            throw new Error('Firmware container or trailer verification failed.');
        }
        const afterTrees = await Promise.all(regions.map(([start, end]) => Firmware0408.fileTree(candidate, start, end - start)));
        if (trees.some((tree, index) => tree !== afterTrees[index])) throw new Error('Source files changed during preparation.');
        Firmware0408.inventory(candidate, slots, regions);
        // Firmware assembly has passed unchanged; only the private full-image settings may change.
        const prepared = await UpdateImageLifecycle.apply(candidate, lifecycle);
        const slot = selected.start === Firmware0408.PRIMARY ? 0 : 1;
        return {...prepared, version: selected.version, slot,
            fileName: `custom-image-${selected.version}-slot${slot}.bin`,
            sha256: await Firmware0408.hash(prepared.bytes)};
    }
}

/** Small card controller: input files and private snapshots live only in this page session. */
class CustomImageController {
    constructor(tile) {
        this.tile = tile; this.root = tile.element; this.target = null; this.targetKind = 'dump';
        this.image = null; this.revision = -1; this.generation = 0; this.result = null; this.checks = null;
        this.lifecycleSelection = null; this.targetSlot = null;
        this.ui = Object.fromEntries(['source','target','file','ota-file','select','select-ota','firmware-choice','firmware-option','version','slot','other-slot','checks','status','check','build','download','flash','wifi','back',
            'lifecycle-original','lifecycle-selected','lifecycle-result','lifecycle-mode'].map(name => [name, this.root.querySelector(`[data-custom="${name}"]`)]));
        for (const [name, action] of [['check', () => this.check()], ['build', () => this.build()], ['download', () => this.download()],
            ['select', () => {
                if (!this.blocked() && !this.tile.operationRunning) { this.ui.file.value = ''; this.ui.file.click(); }
            }],
            ['select-ota', () => {
                if (!this.blocked() && !this.tile.operationRunning) { this.ui['ota-file'].value = ''; this.ui['ota-file'].click(); }
            }],
            ['flash', () => tile.tileManager.moveTo(0, 0, 'images')], ['back', () => tile.tileManager.moveTo(0, 0, 'images')],
            ['wifi', () => tile.tileManager.moveTo(2, 2)]]) this.ui[name].addEventListener('click', event => { event.stopPropagation(); action(); });
        this.ui.file.addEventListener('change', () => this.selectTarget('dump'));
        this.ui['ota-file'].addEventListener('change', () => this.selectTarget('ota'));
        this.ui['firmware-option'].addEventListener('change', event => {
            event.stopPropagation();
            if (this.blocked() || this.tile.operationRunning || this.targetKind !== 'dump') return;
            const start = Number(event.target.value);
            if (!this.checks?.facts.options?.some(slot => slot.start === start) || this.targetSlot === start) return;
            this.targetSlot = start; this.result = null;
            void this.check();
        });
        // Choices only affect the next private build; a prior verified output becomes stale.
        this.ui['lifecycle-mode'].addEventListener('change', event => {
            event.stopPropagation();
            if (this.blocked() || this.tile.operationRunning || this.checks?.facts.lifecycle === undefined) return;
            this.lifecycleSelection = event.target.value === 'keep' ? null : Number(event.target.value);
            this.result = null;
            this.update();
        });
        this.renderChecks();
        this.timer = setInterval(() => { if (tile.isFocused) this.update(); }, Firmware0408.UI_REFRESH_MS);
    }
    available() { return CoreFlasherDumpUi.complete(window.interface) && window.interface.size === Firmware0408.SIZE; }
    writable() { return this.available() && !window.interface.readOnly && window.AppState.interfaceMode === 'rw-buffered'; }
    blocked(ignoreOwnBuild = false) {
        const state = window.AppState;
        const busy = ignoreOwnBuild ? state.interfaceOpening || state.flipTdiBusy || state.flipTdiReadBusy ||
            state.flipTdiDumpBusy || state.flipTdiWriteBusy || state.dumpFlashUiBusy || state.wifiBusy || state.offlineModeBusy
            : CoreFlasherDumpUi.busy();
        return !!busy || !!this.tile.context.operations.otherCardBusy(this.tile);
    }
    current(image = this.image, revision = this.revision, generation = this.generation) {
        return image === window.interface && revision === Number(window.AppState.interfaceRevision || 0) && generation === this.generation;
    }
    update() {
        if (!this.current()) {
            this.generation++; this.image = window.interface; this.revision = Number(window.AppState.interfaceRevision || 0);
            this.lifecycleSelection = null;
            this.checks = this.result = null; this.renderChecks(); this.ui.status.textContent = this.available()
                ? 'Working image changed. Check the current inputs.'
                : 'Load a complete source image in Interface, then select a target full dump or OTA file.';
        }
        this.ui.source.textContent = window.AppState.sourceFileName || 'No working image loaded';
        this.ui.source.title = this.ui.source.textContent;
        const busy = this.blocked() || this.tile.operationRunning;
        this.ui.check.disabled = busy || (!this.available() && !this.target); this.ui.file.disabled = busy;
        this.ui.select.disabled = busy;
        this.ui['select-ota'].disabled = busy; this.ui['ota-file'].disabled = busy;
        this.ui['firmware-option'].disabled = busy || this.targetKind !== 'dump' || (this.checks?.facts.options?.length || 0) < 2;
        this.ui.build.disabled = busy || !this.writable() || !this.checks?.valid;
        this.ui.download.disabled = busy || !this.result; this.ui.flash.disabled = busy || !this.result;
        this.ui['lifecycle-mode'].disabled = busy || this.checks?.facts.lifecycle === undefined;
        this.renderLifecycle();
        if (this.tile.isFocused && (this.available() || this.target) && !this.checks && !busy) this.check();
    }

    /** Keep input, intention and verified output visibly separate, even when they match. */
    renderLifecycle() {
        const original = this.result?.lifecycle?.original ?? this.checks?.facts.lifecycle;
        this.ui['lifecycle-original'].textContent = UpdateImageLifecycle.label(original);
        this.ui['lifecycle-selected'].textContent = this.lifecycleSelection === null
            ? `Keep source value: ${UpdateImageLifecycle.label(original)}` : UpdateImageLifecycle.label(this.lifecycleSelection);
        this.ui['lifecycle-result'].textContent = this.result?.lifecycle
            ? UpdateImageLifecycle.label(this.result.lifecycle.verified) : 'Not built';
        this.ui['lifecycle-mode'].value = this.lifecycleSelection === null ? 'keep' : String(this.lifecycleSelection);
    }
    renderChecks() {
        this.ui.checks.replaceChildren();
        for (const row of this.checks?.rows || Object.entries(CustomImageBuilder.CHECKS).map(([id,label]) => ({id,label,status:'pending'}))) {
            const line = document.createElement('li');
            line.textContent = `${['passed', 'warning'].includes(row.status) ? '✓' : row.status === 'failed' ? '✕' : '–'} ${row.label}${row.message ? ': ' + row.message : ''}`;
            // Only omitted Bluetooth identity data is lost; matching protected data stays intact.
            if (row.id === 'target-location' && row.status === 'warning' && this.checks?.facts.omittedRegions?.length) {
                const warning = document.createElement('span');
                warning.className = 'custom-data-warning'; warning.tabIndex = 0;
                warning.textContent = ' Warning!';
                const details = document.createElement('span');
                details.id = 'custom-bluetooth-loss-details'; details.role = 'tooltip';
                details.textContent = 'These are unique Bluetooth identity data from the initial source image. Flashing this update image permanently removes those original data from the device. Without an untouched backup of the initial image, they cannot be recovered. Always keep that original backup. The separately protected device data remain unchanged.';
                warning.setAttribute('aria-describedby', details.id);
                warning.appendChild(details); line.appendChild(warning);
            }
            line.className = `custom-check-${row.status}`; this.ui.checks.appendChild(line);
        }
        this.ui.wifi.hidden = !this.checks?.rows.some(row => row.id === 'source-wifi' && row.status === 'failed');
        const selected = this.checks?.facts.selected;
        this.ui.version.textContent = selected?.version || 'Not selected';
        this.ui.slot.textContent = selected ? (selected.start === Firmware0408.PRIMARY ? '0' : '1') : '—';
        this.ui['other-slot'].textContent = selected ? `${selected.start === Firmware0408.PRIMARY ? '1' : '0'} — no firmware` : '—';
        const options = this.targetKind === 'dump' ? this.checks?.facts.options || [] : [];
        const picker = this.ui['firmware-option'];
        this.ui['firmware-choice'].hidden = !options.length;
        picker.replaceChildren();
        if (options.length > 1) {
            const placeholder = document.createElement('option');
            placeholder.value = ''; placeholder.textContent = 'Choose firmware version and slot';
            placeholder.disabled = true; picker.appendChild(placeholder);
        }
        for (const option of options) {
            const item = document.createElement('option');
            item.value = String(option.start);
            item.textContent = `${option.version} · Slot ${option.start === Firmware0408.PRIMARY ? 0 : 1}`;
            picker.appendChild(item);
        }
        picker.value = selected ? String(selected.start) : '';
        picker.disabled = this.blocked() || this.tile.operationRunning || options.length < 2;
    }
    async selectTarget(kind = 'dump') {
        if (this.blocked() || this.tile.operationRunning) return;
        const file = this.ui[kind === 'ota' ? 'ota-file' : 'file'].files?.[0]; if (!file) return;
        const generation = ++this.generation;
        this.target = null; this.targetKind = kind; this.targetSlot = null; this.result = this.checks = null;
        this.ui.target.textContent = file.name; this.ui.target.title = file.name; this.renderChecks();
        this.tile.operationRunning = true; this.ui.status.textContent = 'Reading target image…'; this.update();
        try {
            if (kind === 'dump' && file.size !== Firmware0408.SIZE) throw new Error('Select a complete 16 MiB target image.');
            if (kind === 'ota' && (file.size < 32 || file.size > Firmware0408.SLOT_SIZE - Firmware0408.TRAILER_SIZE)) {
                throw new Error('Select a complete OTA container smaller than one firmware slot.');
            }
            const bytes = new Uint8Array(await file.arrayBuffer());
            if (generation !== this.generation) return;
            this.target = bytes;
        } catch (error) {
            if (generation === this.generation) {
                this.checks = {valid:false, facts:{}, rows:[{id:'target-size', label:'Target file', status:'failed', message:error.message}]};
                this.renderChecks(); this.ui.status.textContent = error.message;
            }
        }
        finally { this.tile.operationRunning = false; this.update(); if (this.target) await this.check(); }
    }
    /** Validation takes snapshots too, so an image switch cannot publish stale green checks. */
    async check() {
        if (this.blocked() || this.tile.operationRunning || (!this.available() && !this.target)) return;
        this.image = window.interface; this.revision = Number(window.AppState.interfaceRevision || 0);
        const image = this.image, revision = this.revision, generation = ++this.generation;
        const source = this.available() ? image.subarray(0, image.size).slice() : null, target = this.target?.slice();
        const kind = this.targetKind, requestedStart = this.targetSlot;
        this.result = null;
        this.tile.operationRunning = true; this.ui.status.textContent = 'Checking images…'; this.update();
        try {
            const checks = await CustomImageBuilder.inspect(source, target, this.tile.context.settings, kind, requestedStart);
            if (!this.current(image, revision, generation) || (source && !Firmware0408.equal(source, image.subarray(0, image.size)))) return;
            this.checks = checks; this.renderChecks();
            this.ui.status.textContent = checks.valid ? (this.writable() ? 'Compatible layout — ready to build. Hardware compatibility remains unverified.' : 'Enable Read / Write in Dump / Flash.')
                : kind === 'dump' && checks.facts.options?.length > 1 && !checks.facts.selected
                    ? 'Choose a firmware version and slot from the target dump.'
                    : 'Resolve the failed checks, then select Check again.';
        } catch (error) {
            if (this.current(image, revision, generation)) {
                this.checks = {valid:false, rows:[], facts:{}}; this.renderChecks();
                this.ui.status.textContent = error.message;
            }
        }
        finally { this.tile.operationRunning = false; this.update(); }
    }
    /** Existing operation locks cover export, reset and all other image writers. */
    async build() {
        if (this.blocked() || this.tile.operationRunning || !this.writable() || !this.current() || !this.target || !this.checks?.valid) return;
        const image = window.interface, state = window.AppState, revision = state.interfaceRevision;
        if (image.writeBuffer.length && !window.confirm('Use the current working image, including its unsaved changes, as the source?')) return;
        const source = image.subarray(0, image.size).slice(), target = this.target.slice(), generation = ++this.generation;
        const kind = this.targetKind, lifecycle = this.lifecycleSelection, requestedStart = this.targetSlot;
        this.result = null; this.tile.operationRunning = true; state.firmwareBuildBusy = true; state.customImageBusy = true;
        this.ui.status.textContent = 'Building and verifying update image…'; this.update();
        try {
            const built = await CustomImageBuilder.build(source, target, this.tile.context.settings, kind, lifecycle, requestedStart);
            const staged = Firmware0408.stage(image, built.bytes);
            if (!this.current(image, revision, generation) || !this.writable() || this.blocked(true) ||
                !Firmware0408.equal(source, image.subarray(0, image.size))) throw new Error('Working image or write permission changed, or another operation started. Nothing was applied.');
            image.writeBuffer = staged; image.fullImageRequired = true;
            state.interfaceRevision = Number(revision || 0) + 1;
            state.settingsSelectionRevision = Number(state.settingsSelectionRevision || 0) + 1;
            state.sourceFileName = built.fileName;
            state.littlefsParser = state.littlefsParserSource = null;
            if (typeof LFS_IMAGE_PARSERS !== 'undefined') LFS_IMAGE_PARSERS.delete(image);
            this.image = image; this.revision = state.interfaceRevision; this.result = built;
            this.ui.status.textContent = `${built.version} · Slot ${built.slot} prepared. Full-image flash required. No data has been written to the device.`;
        } catch (error) { this.ui.status.textContent = `Preparation stopped: ${error.message}`; }
        finally {
            this.tile.operationRunning = false; state.firmwareBuildBusy = false; state.customImageBusy = false;
            this.tile.tileManager.broadcastUpdate(this.tile); this.update();
        }
    }
    download() {
        if (this.blocked() || this.tile.operationRunning || !this.result || !this.current() || !this.available()) return;
        const bytes = window.interface.subarray(0, window.interface.size).slice();
        if (!Firmware0408.equal(bytes, this.result.bytes)) { this.result = null; this.update(); return; }
        const url = URL.createObjectURL(new Blob([bytes], {type:'application/octet-stream'}));
        const link = document.createElement('a'); link.href = url;
        link.download = this.result.fileName; link.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
}
if (typeof module !== 'undefined') module.exports = {CustomImageBuilder, CustomImageController};

// Reset can remove an older cached companion even though the binary is no longer shipped.
if (typeof CoreFlasherApp !== 'undefined' && Array.isArray(CoreFlasherApp.runtimeFiles)) {
    CoreFlasherApp.runtimeFiles.push(CoreFlasherApp.extensions.asset('image-tools', 'assets/resource-slot1.bin.gz'));
}
