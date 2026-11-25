/** Connect image/UUID observations to archive profiles without owning those source states. */
class BoxIdentityService {
    constructor(context) {
        this.context = context;
        this.generation = 0;
        this.archiveRevision = 0;
        this.imageState = {};
        this.uuidState = {};
        this.usbIdentity = null;
    }
    stamp() {
        return [this.context.image.current, window.AppState.interfaceRevision, this.context.uuid.revision, this.archiveRevision];
    }
    current(stamp) { return stamp.every((value, index) => value === this.stamp()[index]); }
    /** Local observations only: never infer ownership or initiate a hardware read. */
    fillAvailable() {
        const hardware = window.AppState.hardwareController;
        return !!this.context.image.current || !!(hardware?.ready && hardware.detectedId && !hardware.fault);
    }

    async currentFields() {
        const stamp = this.stamp(), hardware = window.AppState.hardwareController;
        const connection = hardware?.device || hardware?.port, epoch = hardware?.epoch;
        const chipId = hardware?.ready && !hardware.fault ? hardware.flashChipId : '';
        const values = {}, unavailable = [];
        if (/^[0-9A-F]{16}$/i.test(chipId || '') && !/^(0{16}|F{16})$/i.test(chipId)) values.flashChipId = chipId.toUpperCase();
        const uuid = this.context.uuid.currentInput;
        if (/^500100[0-9A-F]{10}$/.test(uuid || '')) values.uuid = uuid;
        try {
            const observed = await this.inspect(stamp[0], false);
            if (observed.boxSerialNumber) values.boxSerialNumber = observed.boxSerialNumber;
            else unavailable.push('Box serial number: no readable setting in a complete working image.');
        } catch (error) { unavailable.push(`Box serial number unavailable: ${error.message}`); }
        const current = () => this.current(stamp) && hardware === window.AppState.hardwareController &&
            connection === (hardware?.device || hardware?.port) && epoch === hardware?.epoch &&
            chipId === (hardware?.ready && !hardware.fault ? hardware.flashChipId : '');
        if (!current()) throw new Error('The image, UUID or connection changed. Try Fill empty fields again.');
        return {values, unavailable, current};
    }

    async profiles() {
        if (!window.CoreFlasherImageStorage) return null;
        const archive = new ImageArchive(window.CoreFlasherImageStorage());
        await archive.refresh();
        return archive.boxProfiles;
    }
    /** Read active logical files; never change the explorer selection or touch device storage. */
    async inspect(image, includeUuid = true) {
        if (!CoreFlasherDumpUi.complete(image)) return {};
        const parser = new LittleFSParser(image, FirmwareImage.LFS, image.size - FirmwareImage.LFS);
        await parser.initialize();
        const observed = { boxId: image.archiveBoxId || '' };
        if ((await parser.fs._resolvePath('/settings'))?.entry) {
            const records = this.context.settings.parseSettingsBuffer(await parser.readFile('/settings'));
            const record = records.filter(item => item.key === 'toniebox/id').at(-1);
            if (record) observed.boxSerialNumber = BoxIdentity.serial(new TextDecoder('utf-8', {fatal:true}).decode(record.valueBytes));
        }
        if (includeUuid && (await parser.fs._resolvePath('/uuid'))?.entry) {
            const uuid = new TextDecoder().decode(await parser.readFile('/uuid')).toUpperCase();
            if (/^500100[0-9A-F]{10}$/.test(uuid)) observed.uuid = uuid;
        }
        return observed;
    }
    /** Use the existing zero-padding key plausibility test, not AES success alone. */
    async validateUuid(image, uuid) {
        if (!uuid || !CoreFlasherDumpUi.complete(image)) return false;
        const parser = new LittleFSParser(image, FirmwareImage.LFS, image.size - FirmwareImage.LFS);
        try { await parser.initialize(); }
        catch { return false; } // Raw/unknown images may be archived; no certificate was available to validate.
        const fs = this.context.filesystem;
        let verified = false;
        const key = await fs.deriveKeyHkdf(fs.hexToBytes(uuid), fs.hexToBytes('bc21551317da981e5e4650a7d238ea2c'),
            fs.hexToBytes('2469031c2490ad3f3bd1b05cfd5c6681'));
        for (const path of ['/cert/ap-mode-auth.cred.crypt', '/cert/client.der.crypt', '/cert/private.der.crypt', '/cert/ca.der.crypt', '/cert/ici-auth.cred.crypt']) {
            if (!(await parser.fs._resolvePath(path))?.entry) continue;
            const parsed = fs.parseBlob(await parser.readFile(path));
            const padded = await fs.decryptAesCbcRaw(key, parsed.iv, parsed.ciphertext);
            if (!fs.validateZeroPadding(padded, parsed.padding)) throw new Error('This image does not match the saved MCU UUID. Review the box assignment.');
            verified = true;
        }
        return verified;
    }
    /** Late network replies may update neither a newer image nor a manually changed UUID. */
    observe(applyUuid = true) {
        if (!window.AppState || !window.CoreFlasherDumpUi) return;
        if (this.context.manager?.cardsInitializing) return;
        if (this.context.operations.busy()) return;
        const stamp = this.stamp();
        if (this.lastStamp?.every((value, index) => value === stamp[index])) return;
        const imageChanged = !this.lastStamp || this.lastStamp[0] !== stamp[0] || this.lastStamp[1] !== stamp[1];
        this.lastStamp = stamp;
        const generation = ++this.generation;
        const mayApply = applyUuid && imageChanged && !this.suppressNextApply;
        this.suppressNextApply = false;
        this.pending = this.resolveSources(stamp, generation, mayApply);
    }
    async resolveSources(stamp, generation, applyUuid) {
        const valid = () => this.current(stamp) && generation === this.generation;
        try {
            let observed = {}, imageError = '';
            try { observed = await this.inspect(stamp[0]); }
            catch { imageError = 'Image identity could not be read from its filesystem.'; }
            const profiles = await this.profiles();
            if (!valid()) return;
            const uuid = this.context.uuid.currentInput;
            const usb = this.usbIdentity?.uuid === uuid ? this.usbIdentity : {};
            let imageBox = null, uuidBox = null, uuidError = '';
            try { imageBox = profiles && BoxIdentity.resolve(profiles, observed); }
            catch (error) { imageError = error.message; }
            try { uuidBox = profiles && BoxIdentity.resolve(profiles, {...usb, uuid}); }
            catch (error) { uuidError = error.message; }
            if (imageBox?.uuid && !imageError) {
                try { await this.validateUuid(stamp[0], imageBox.uuid); }
                catch (error) { imageError = error.message; }
            }
            if (!valid()) return;
            this.imageState = { image: stamp[0], observed, box: imageError ? null : imageBox, error: imageError };
            this.uuidState = { observed: {...usb, uuid}, box: uuidError ? null : uuidBox, error: uuidError };
            if (applyUuid && imageBox && !imageError && imageBox.uuid !== uuid) {
                this.context.uuid.resetSearch(true);
                this.context.uuid.setSerialNumberField(imageBox.uuid || '', true);
            }
            this.context.emit('identity', this.imageState);
            this.context.manager?.broadcastUpdate();
        } catch (error) {
            if (!valid()) return;
            this.imageState = {error: `Box recognition unavailable: ${error.message}`};
            this.uuidState = {error: this.imageState.error};
            this.context.emit('identity', this.imageState);
        }
    }
    /** Restore invalidates lookup results but does not become a new key-selection action. */
    invalidate(applyUuid = false) {
        this.archiveRevision++;
        this.suppressNextApply = !applyUuid;
        this.imageState = {}; this.uuidState = {}; this.lastStamp = null;
        this.observe(applyUuid);
    }
    acceptUsb(identity) {
        this.usbIdentity = {uuid: identity.uuid, boxSerialNumber: identity.boxSerialNumber || ''};
        this.lastStamp = null;
        this.observe(false);
    }
    suggested() {
        return this.uuidState.box || this.imageState.box || null;
    }
    /** Suggest newly observed identifiers together only when they belong to the same source. */
    async proposal(uuid) {
        const stamp = this.stamp();
        const observed = {uuid};
        if (this.usbIdentity?.uuid === uuid) Object.assign(observed, this.usbIdentity);
        const image = await this.inspect(stamp[0]).catch(() => ({}));
        if (image.boxSerialNumber && (image.uuid === uuid || await this.validateUuid(stamp[0], uuid))) {
            if (observed.boxSerialNumber && observed.boxSerialNumber !== image.boxSerialNumber)
                throw new Error('USB and image serial numbers differ. Review the box assignment.');
            observed.boxSerialNumber = image.boxSerialNumber;
        }
        if (!this.current(stamp)) throw new Error('The source changed. Open Save UUID again.');
        return observed;
    }
    /** Cards own their small status view and unsubscribe through the existing lifecycle. */
    bindStatus(card, channel = 'uuid') {
        const status = document.createElement('p'); status.className = 'cf-muted cf-box-identity-status';
        card.element.querySelector('h1,h2,h3')?.after(status);
        const render = () => {
            const state = channel === 'image' ? this.imageState : this.uuidState;
            status.textContent = state.error || (state.box ? `Box: ${state.box.name}${state.box.boxSerialNumber ? ' · Serial: ' + state.box.boxSerialNumber : ''}`
                : state.observed?.boxSerialNumber ? `Box serial number: ${state.observed.boxSerialNumber} · Unassigned` : '');
        };
        card.own(this.context.subscribe('identity', render));
        render();
    }
    /** One mismatch consent is tied to exact bytes, current source and current archive profiles. */
    async writeProof(bytes, controller) {
        const stamp = this.stamp(), connection = controller?.device || controller?.port;
        const chipId = controller?.flashChipId;
        const snapshot = bytes.slice();
        const profiles = await this.profiles();
        const signature = JSON.stringify(profiles?.map(profile => profile.value));
        if (profiles) {
            const image = SparseImage.fromBuffer(snapshot.buffer.slice(0)); image.completeSnapshot = true;
            if (CoreFlasherDumpUi.complete(stamp[0]) && ImageArchive.same(snapshot, stamp[0].subarray(0, stamp[0].size))) image.archiveBoxId = stamp[0].archiveBoxId;
            let sourceBox, hardwareBox, conflict = '';
            try {
                let observed = {boxId: image.archiveBoxId || ''};
                try { observed = await this.inspect(image); }
                catch { /* No readable identity is unknown, not proof of a different box. */ }
                sourceBox = BoxIdentity.resolve(profiles, observed);
                hardwareBox = BoxIdentity.resolve(profiles, {flashChipId: chipId});
            } catch (error) { conflict = error.message; }
            if (conflict || (sourceBox && hardwareBox && sourceBox.id !== hardwareBox.id)) {
                const message = conflict || `The image belongs to “${sourceBox.name}”, but the connected chip belongs to “${hardwareBox.name}”.`;
                if (!await this.confirmMismatch(message)) throw new Error('Flash cancelled: box assignment differs.');
            }
        }
        const proof = () => {
            if (!this.current(stamp) || (controller?.device || controller?.port) !== connection || controller?.flashChipId !== chipId)
                throw new Error('Box identity or source changed. Confirm the flash operation again.');
        };
        proof();
        proof.beforeFirstWrite = async () => {
            const fresh = await this.profiles();
            if (signature !== JSON.stringify(fresh?.map(profile => profile.value)) || !ImageArchive.same(snapshot, bytes))
                throw new Error('Box assignment or image changed before writing. Confirm again.');
            proof();
        };
        return proof;
    }
    confirmMismatch(message) {
        return new Promise(resolve => {
            const dialog = document.createElement('dialog'); dialog.className = 'image-manager';
            const heading = document.createElement('h2'); heading.textContent = 'Box identity warning';
            const text = document.createElement('p'); text.textContent = message;
            const cancel = document.createElement('button'); cancel.textContent = 'Cancel';
            const accept = document.createElement('button'); accept.textContent = 'Flash anyway';
            const finish = value => { dialog.close(); dialog.remove(); resolve(value); };
            cancel.onclick = () => finish(false); accept.onclick = () => finish(true);
            dialog.addEventListener('cancel', event => { event.preventDefault(); finish(false); });
            dialog.append(heading, text, cancel, accept); document.body.append(dialog); dialog.showModal(); cancel.focus();
        });
    }
}
if (typeof module !== 'undefined') module.exports = { BoxIdentityService };
