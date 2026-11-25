/* Compact archive dialog; all device/image integration is supplied through explicit hooks. */
'use strict';
class ImageManagerDialog {
    static BYTES_PER_MIB = 1024 * 1024;

    /**
     * @param {object} hooks Host callbacks for inspect, snapshot, load, navigate and shared busy state.
     * The dialog owns presentation; image bytes and device integration stay behind these hooks.
     */
    constructor(hooks) {
        this.hooks = hooks;
        this.dialog = null;
        this.active = false;
    }
    async open(saveWorking = false) {
        if (this.dialog?.open) { this.close(); return; }
        if (document.querySelector('dialog[open], [role="dialog"][aria-modal="true"]')) return;
        this.previousFocus = document.activeElement;
        this.uuidRequest = typeof saveWorking === 'object' ? saveWorking : null;
        this.selection = null;
        this.formBaselines = new Map();
        this.draft = null;
        this.boxes = [];
        const dialog = this.createDialog();
        this.bindDialog(dialog);
        await this.initializeArchive(saveWorking === true);
        if (this.uuidRequest && this.archive) {
            if (this.uuidRequest.uuidMode === 'save') {
                try {
                    const observed = await this.hooks.identity?.proposal(this.uuidRequest.uuid) || {uuid: this.uuidRequest.uuid};
                    const matched = BoxIdentity.resolve(this.archive.boxProfiles, observed);
                    if (matched) this.uuidRequest.boxId = matched.id;
                    this.uuidRequest.boxSerialNumber = observed.boxSerialNumber || '';
                } catch (error) { this.status(error.message); }
            }
            const loaded = this.loadedArchiveImage();
            const entry = this.archive.entries.find(item => item.meta?.id === loaded?.id);
            this.showBoxPanel(this.uuidRequest.boxId || (this.uuidRequest.uuidMode === 'save' ? this.hooks.identity?.suggested()?.id || entry?.meta.box.id || loaded?.boxId || '' : ''));
        }
    }

    /** Session-only provenance follows the actual working image, not the selected list row. */
    loadedArchiveImage() {
        if (this.loadedImage && this.loadedImage.image !== this.hooks.currentImage?.()) this.loadedImage = null;
        return this.loadedImage;
    }

    /** Build and focus the modal before asynchronous archive access starts. */
    createDialog() {
        const dialog = document.createElement('dialog'); this.dialog = dialog;
        dialog.className = 'image-manager'; dialog.setAttribute('aria-labelledby', 'image-manager-title');
        dialog.innerHTML = `<header><div><h2 id="image-manager-title">Image Manager</h2><p>TB2 images on TeddyCloud · Shift + I</p><p class="im-usage"></p></div><div class="im-actions"><button data-action="refresh">Refresh</button><button data-action="boxes">Box details</button><button data-action="settings">Settings</button><button data-action="close">Close</button></div></header>
        <p class="im-status" role="status" aria-live="polite"></p>
        <form class="im-settings" hidden><label>Archive limit (MiB)<input name="limit" type="number" min="16" step="1" required></label><button type="submit">Save limit</button><p>This is a manager limit, not a server quota. Parallel uploads may exceed it. Nothing is deleted automatically.</p></form>
        <div class="im-body"><aside><div class="im-filters"><input class="im-search" type="search" aria-label="Search images" placeholder="Search images…"><select class="im-box-filter" aria-label="Filter by box"></select><select class="im-type-filter" aria-label="Filter by type"><option value="">All types</option><option>Original</option><option>Modified</option><option>Unknown</option></select></div><nav class="im-list" aria-label="Archived images"></nav><div class="im-actions"><button data-action="working">Save working image</button><button data-action="upload">Upload image</button><input class="im-file" type="file" accept=".bin,application/octet-stream" hidden></div></aside>
        <section class="im-detail"><div class="im-box-panel" hidden><h3>Box details</h3><div class="im-box-choices" aria-label="Select a TB2 box"></div><form class="im-box-form"><label>Box name<input name="boxName" maxlength="100" required></label><label>Microcontroller UUID<input name="boxUuid" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Optional"></label><label>Flash chip ID<input name="boxChipId" maxlength="16" autocomplete="off" spellcheck="false" placeholder="Optional"></label><label>TeddyCloud TB2<select name="tcBox"></select></label><div class="im-actions"><button type="submit">Save box details</button><button type="button" data-action="load-uuid">Load UUID</button><button type="button" data-action="back-images">Back to images</button></div></form></div><p class="im-empty">Select an image, upload a file or save the working image.</p><form class="im-form" hidden><fieldset><p class="im-firmware"></p><label>Name<input name="name" maxlength="100" required></label><label>Box<div class="im-box-assignment"><div class="im-box-preview" aria-hidden="true"></div><select name="box"></select></div></label><label class="im-manual" hidden>New box name<input name="manual" maxlength="100"></label><label>Type<select name="type"><option>Unknown</option><option>Original</option><option>Modified</option></select></label><label>Notes<textarea name="notes" maxlength="2000" rows="3"></textarea></label><label class="im-protection"><input name="protected" type="checkbox">Protect image</label><p class="im-date"></p><details><summary>Additional details</summary><label>Version note<input name="versionNote" maxlength="100" placeholder="Optional"></label><p class="im-path"></p><p class="im-hash"></p></details></fieldset><div class="im-actions"><button type="submit" class="im-save">Save details</button><button type="button" data-action="load">Load image</button><button type="button" data-action="download">Download</button><button type="button" data-action="unprotect">Remove protection</button><button type="button" data-action="delete">Delete</button></div><p class="im-delete-note"></p></form></section></div>
        <footer><p class="im-box-note" hidden>Box profiles stay in the TC archive. Saving or loading a UUID does not change an image or write to the box.</p><p>Images may contain device settings and certificates. Existing TeddyCloud access rules apply. “Original” and box assignment are labels, not verified backup or device ownership.</p><p>Protection prevents deletion in this manager only. Clear cache &amp; reset TB2 Dungeon does not delete this archive.</p><button data-action="cancel" hidden>Cancel operation</button></footer>`;
        // Transfer metadata only; a restore is published after a separate preview and confirmation.
        const transfer = document.createElement('section'); transfer.className = 'im-backup';
        transfer.innerHTML = `<h3>Manager backup</h3><p>Includes box profiles, image details and manager settings. Image files are not included.</p><div class="im-actions"><button type="button" data-action="metadata-backup">Download metadata backup</button><button type="button" data-action="metadata-restore">Restore metadata backup</button></div><input class="im-backup-file" type="file" accept=".json,application/json" hidden><div class="im-restore-preview" hidden><p class="im-restore-summary"></p><ul class="im-restore-files"></ul><label><input type="checkbox" class="im-restore-unprotect">Confirm removal of listed image protection</label><button type="button" data-action="metadata-confirm">Replace manager metadata</button></div>`;
        dialog.querySelector('.im-settings').append(transfer);
        const serial = document.createElement('label'); serial.textContent = 'Box serial number';
        const input = document.createElement('input'); input.name = 'boxSerialNumber'; input.maxLength = BoxIdentity.SERIAL_LIMIT;
        input.autocomplete = 'off'; serial.append(input);
        dialog.querySelector('.im-box-form [name="boxName"]').closest('label').after(serial);
        const fill = document.createElement('div'); fill.className = 'im-fill-fields';
        fill.innerHTML = '<button type="button" data-action="fill-fields">Fill empty fields</button><p>Uses current page values. Existing fields remain unchanged.</p><p class="im-fill-status" role="status"></p>';
        dialog.querySelector('[name="boxChipId"]').closest('label').after(fill);
        const searchReport = document.createElement('details');
        searchReport.className = 'im-search-report';
        searchReport.hidden = true;
        searchReport.innerHTML = '<summary>Last successful UUID search</summary><p class="im-search-origin"></p><dl class="im-search-values"></dl><details><summary>Technical details</summary><dl class="im-search-technical-values"></dl></details>';
        dialog.querySelector('.im-box-form').before(searchReport);
        document.body.appendChild(dialog); dialog.showModal();
        dialog.querySelector('[data-action="close"]').focus();
        return dialog;
    }

    /** Keep each event binding scoped to the dialog instance that created it. */
    bindDialog(dialog) {
        dialog.addEventListener('cancel', event => { event.preventDefault(); this.close(); });
        dialog.addEventListener('close', () => {
            if (this.dialog !== dialog) return;
            this.dialog = null; this.draft = null; this.selection = null; this.archive = null;
            this.selectedBox = null; this.boxExpected = null; this.boxes = []; this.uuidRequest = null;
            if (this.previousFocus?.isConnected) this.previousFocus.focus({ preventScroll: true });
        });
        dialog.addEventListener('click', event => {
            const action = event.target.closest('[data-action]')?.dataset.action;
            if (action) { event.preventDefault(); this.action(action); }
        });
        dialog.querySelector('.im-backup-file').addEventListener('change', () => this.previewRestore());
        dialog.querySelector('.im-box-form').addEventListener('submit', event => { event.preventDefault(); this.saveBoxDetails(); });
        dialog.querySelector('.im-form').addEventListener('submit', event => { event.preventDefault(); this.save(); });
        dialog.querySelector('.im-settings').addEventListener('submit', event => {
            event.preventDefault(); const bytes = Number(dialog.querySelector('[name="limit"]').value) * ImageManagerDialog.BYTES_PER_MIB;
            this.perform(async options => { await this.archive.setLimit(bytes, options); this.markClean('.im-settings'); this.renderList(); this.status('Archive limit saved.'); });
        });
        for (const selector of ['.im-search','.im-box-filter','.im-type-filter']) dialog.querySelector(selector).addEventListener('input', () => this.renderList());
        dialog.querySelector('[name="box"]').addEventListener('change', () => { dialog.querySelector('.im-manual').hidden = this.field('box').value !== '__new__'; this.updateBoxPreview(); });
        dialog.querySelector('.im-file').addEventListener('change', () => {
            const file = dialog.querySelector('.im-file').files[0];
            if (file && this.confirmDiscard(['.im-form', '.im-box-form'])) this.perform(async () => {
                if (file.size !== ImageArchive.SIZE) throw new Error('Select a complete 16 MiB image.');
                await this.prepare(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.bin$/i, ''), 'Unknown');
            });
        });
    }

    /** Unavailable plugin storage leaves the same modal open with only Close enabled. */
    async initializeArchive(saveWorking) {
        const dialog = this.dialog;
        if (!window.CoreFlasherImageStorage) {
            this.status('Image storage is available in the TeddyCloud plugin. Open TB2 Dungeon there to manage images.');
            for (const button of dialog.querySelectorAll('button:not([data-action="close"])')) button.disabled = true;
            return;
        }
        try { this.archive = new ImageArchive(window.CoreFlasherImageStorage(), this.hooks.inspect); }
        catch (error) {
            this.status(`TeddyCloud image storage is unavailable: ${error.message}`);
            for (const button of dialog.querySelectorAll('button:not([data-action="close"])')) button.disabled = true;
            return;
        }
        await this.perform(async () => {
            this.boxes = await this.archive.storage.boxes();
            try { await this.archive.refresh(); this.status(this.archive.storage.boxWarnings?.join(' ') || 'Archive ready.'); }
            catch (error) { this.status(`${error.message} If this is a new archive, Save working image, Upload image or Save limit will create it.`); }
            this.renderList();
        });
        if (saveWorking && this.dialog?.open) await this.action('working');
    }
    field(name) { return this.dialog.querySelector(`.im-form [name="${name}"]`); }
    status(message) { if (this.dialog) this.dialog.querySelector('.im-status').textContent = message; }
    /** Compare only owned editable fields; filters and disclosures are not drafts. */
    formValues(selector) {
        return JSON.stringify([...this.dialog.querySelector(selector).querySelectorAll('[name]')]
            .map(field => [field.name, field.type === 'checkbox' ? field.checked : field.value]));
    }
    markClean(selector) { this.formBaselines.set(selector, this.formValues(selector)); }
    formDirty(selector) {
        return this.formBaselines?.has(selector) && this.formBaselines.get(selector) !== this.formValues(selector);
    }
    confirmDiscard(forms = ['.im-form', '.im-box-form', '.im-settings']) {
        if (!this.dialog?.open) return true;
        const dirty = forms.some(form => this.formDirty(form)) || (forms.includes('.im-form') && !!this.draft);
        return !dirty || confirm('Discard unsaved changes in Image Manager?');
    }

    /** Fill is a draft edit. Recheck the selected profile and each field after awaiting settings. */
    async fillEmptyFields() {
        if (!this.hooks.identity?.fillAvailable()) return;
        const box = this.selectedBox, dialog = this.dialog;
        await this.perform(async () => {
            const result = await this.hooks.identity.currentFields();
            if (this.abort.signal.aborted || this.dialog !== dialog || box !== this.selectedBox || !result.current()) return;
            const form = dialog.querySelector('.im-box-form'), filled = [], missing = [];
            for (const [field, key, label] of [['boxChipId','flashChipId','Flash chip ID'],
                ['boxUuid','uuid','MCU UUID'], ['boxSerialNumber','boxSerialNumber','Box serial number']]) {
                if (form.elements[field].value.trim()) continue;
                if (result.values[key]) { form.elements[field].value = result.values[key]; filled.push(label); }
                else missing.push(label);
            }
            dialog.querySelector('.im-fill-status').textContent =
                (filled.length ? `Filled: ${filled.join(', ')}. Save box details to keep these values.` : 'No empty fields could be filled.') +
                (missing.length ? ` Unavailable: ${missing.join(', ')}.` : '') +
                (missing.includes('Box serial number') ? ' ' + result.unavailable.join(' ') : '');
        });
    }

    async close(discardConfirmed = false) {
        if (this.active) {
            if (confirm('Cancel this operation and discard unsaved changes after the current file step?')) { this.closeAfter = true; this.abort.abort(); this.status('Cancelling after the current file step…'); }
            return;
        }
        if (!discardConfirmed && !this.confirmDiscard()) return;
        this.restorePlan = null;
        this.dialog?.close(); this.dialog?.remove();
    }
    /** One operation owns the shared app lock, including asynchronous read/inspect/load steps. */
    async perform(action) {
        if (this.active || !this.archive) return;
        if (this.hooks.busy()) { this.status('Wait for the current operation to finish.'); return; }
        this.active = true;
        this.abort = new AbortController();
        this.hooks.setBusy(true);
        this.lock();
        try {
            await action({ signal: this.abort.signal, progress: message => this.status(message) });
        } catch (error) { this.status(error.message); }
        finally {
            this.active = false;
            this.hooks.setBusy(false);
            this.lock();
            if (this.closeAfter) { this.closeAfter = false; this.close(true); }
        }
    }
    lock() {
        if (!this.dialog) return;
        for (const control of this.dialog.querySelectorAll('button,input,select,textarea,fieldset')) control.disabled = this.active;
        for (const action of ['close','cancel']) this.dialog.querySelector(`[data-action="${action}"]`).disabled = false;
        this.dialog.querySelector('[data-action="cancel"]').hidden = !this.active;
        if (this.active) return;
        this.dialog.querySelector('[data-action="fill-fields"]').disabled = !this.hooks.identity?.fillAvailable() || this.hooks.busy();
        this.dialog.querySelector('[data-action="load-uuid"]').disabled = !this.selectedBox?.uuid;
        const managed = !!this.selection?.meta, protectedImage = !!this.selection?.meta?.protected;
        for (const action of ['load','download']) this.dialog.querySelector(`[data-action="${action}"]`).disabled = !managed || !!this.selection?.missing;
        this.dialog.querySelector('[data-action="delete"]').disabled = !managed || protectedImage;
        this.dialog.querySelector('[data-action="unprotect"]').hidden = !protectedImage;
        this.dialog.querySelector('.im-delete-note').textContent = protectedImage ? 'Remove image protection before deleting.' : !managed && this.selection ? 'Review and adopt this image before loading, downloading or deleting.' : '';
    }
    choices() {
        const choices = new Map([['', { id:'', name:'Unassigned' }]]);
        const profiles = this.archive.boxProfiles || [];
        const linked = new Set(profiles.map(item => item.value.tcId).filter(Boolean));
        for (const box of this.boxes) if (!linked.has(box.id)) choices.set(box.id, box);
        // Legacy manual assignments stay usable; excluded TC generations cannot reappear here.
        for (const entry of this.archive.entries) if (entry.meta?.box.id && !entry.meta.box.id.startsWith('tc:')) choices.set(entry.meta.box.id, entry.meta.box);
        for (const profile of profiles) {
            const box = profile.value;
            const tcId = box.tcId || (box.id.startsWith('tc:') ? box.id : '');
            if (!box.id.startsWith('tc:') || !this.archive.storage.excludedBoxIds?.has(tcId)) choices.set(box.id, { ...box, picture: this.boxes.find(item => item.id === tcId)?.picture });
        }
        return [...choices.values()];
    }
    /** Select or create a box independently of images and TC registration. */
    showBoxPanel(selectedId = this.selection?.meta?.box.id || '') {
        this.dialog.classList.add('im-box-mode');
        this.dialog.querySelector('.im-box-note').hidden = false;
        const panel = this.dialog.querySelector('.im-box-panel');
        panel.hidden = false;
        this.dialog.querySelector('.im-form').hidden = true;
        this.dialog.querySelector('.im-empty').hidden = true;
        const choices = panel.querySelector('.im-box-choices');
        choices.replaceChildren();
        const loading = this.uuidRequest?.uuidMode === 'load';
        for (const box of this.choices().filter(box => box.id && (!loading || box.uuid))) {
            const button = document.createElement('button');
            button.type = 'button'; button.dataset.boxId = box.id;
            button.appendChild(this.boxPicture(box));
            const label = document.createElement('span');
            label.textContent = [box.name, box.boxSerialNumber, box.uuid, box.flashChipId].filter(Boolean).join(' · ');
            button.appendChild(label);
            button.addEventListener('click', () => this.selectBoxDetails(box, true));
            choices.appendChild(button);
        }
        if (!loading) {
            const create = document.createElement('button');
            create.type = 'button'; create.textContent = 'New TB2 box';
            create.addEventListener('click', () => this.selectBoxDetails({ id: 'manual:' + crypto.randomUUID(), name: '', uuid: '', tcId: '' }, true));
            choices.appendChild(create);
        }
        const first = this.choices().find(box => box.id && box.id === selectedId && (!loading || box.uuid)) ||
            this.choices().find(box => box.id && (!loading || box.uuid));
        this.selectBoxDetails(first || { id: 'manual:' + crypto.randomUUID(), name: '', uuid: '', tcId: '' });
        if (loading && !first) this.status('No TB2 boxes with a saved UUID. Save a UUID for a box first.');
    }

    /** Decorative pictures never receive UUIDs or referrer data. */
    boxPicture(box) { return ImageManagerDialog.boxPicture(box); }
    static boxPicture(box) {
        const picture = document.createElement('span');
        picture.className = 'im-box-picture'; picture.setAttribute('aria-hidden', 'true');
        picture.innerHTML = '<svg viewBox="0 0 40 40" width="36" height="36" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 12 20 7l11 5v19l-11 5-11-5Z M9 12l11 5 11-5 M20 17v19"/><path d="m13 10-2-4 3-1 3 4m6 0 3-4 3 1-2 4"/></svg>';
        if (box.picture) {
            const image = document.createElement('img');
            image.alt = ''; image.referrerPolicy = 'no-referrer'; image.loading = 'lazy';
            image.addEventListener('error', () => image.remove(), { once: true });
            image.src = box.picture; picture.appendChild(image);
        }
        return picture;
    }

    /** Retain original bytes for conflict detection; linking never renames the stable archive ID. */
    selectBoxDetails(box, guard = false) {
        if (guard && (box.id === this.selectedBox?.id || !this.confirmDiscard(['.im-box-form']))) return;
        this.selectedBox = box;
        this.boxExpected = this.archive.boxProfiles.find(item => item.value.id === box.id) || null;
        const form = this.dialog.querySelector('.im-box-form');
        form.elements.boxName.value = box.name;
        form.elements.boxSerialNumber.value = box.boxSerialNumber || '';
        form.elements.boxUuid.value = box.uuid || '';
        form.elements.boxChipId.value = box.flashChipId || '';
        const select = form.elements.tcBox;
        select.replaceChildren(); this.option(select, '', 'Not registered in TeddyCloud');
        for (const item of this.boxes) this.option(select, item.id, item.name);
        select.value = box.tcId || (box.id.startsWith('tc:') ? box.id : '');
        this.markClean('.im-box-form');
        if (this.uuidRequest?.boxSerialNumber) form.elements.boxSerialNumber.value = this.uuidRequest.boxSerialNumber;
        if (this.uuidRequest?.uuidMode === 'save') form.elements.boxUuid.value = this.uuidRequest.uuid;
        if (this.uuidRequest?.chipId) form.elements.boxChipId.value = this.uuidRequest.chipId;
        this.dialog.querySelector('.im-fill-status').textContent = '';
        this.dialog.querySelector('.im-fill-fields').hidden = this.uuidRequest?.uuidMode === 'load';
        this.renderSearchReport(box);
        const loading = this.uuidRequest?.uuidMode === 'load';
        for (const input of form.querySelectorAll('input,select')) input.closest('label').hidden = loading;
        form.querySelector('button[type="submit"]').hidden = loading;
        form.querySelector('[data-action="load-uuid"]').disabled = !box.uuid;
        this.lock();
        for (const button of this.dialog.querySelectorAll('[data-box-id]')) button.dataset.selected = String(button.dataset.boxId === box.id);
    }

    /** Only an explicit Save UUID request may attach the scanner's immutable evidence. */
    pendingSearchReport() {
        const report = this.hooks.searchReport?.();
        return this.uuidRequest?.uuidMode === 'save' && this.uuidRequest.uuid === report?.uuid ? report : null;
    }

    /** Reports describe the UUID that was searched, even if the box UUID is later edited. */
    renderSearchReport(box) {
        const pending = this.pendingSearchReport();
        const report = pending || box.uuidSearch;
        const panel = this.dialog.querySelector('.im-search-report');
        panel.hidden = !report;
        if (!report) return;
        panel.querySelector('.im-search-origin').textContent = pending
            ? 'This report will be saved with Save box details.'
            : report.uuid === box.uuid ? 'Saved search report.' : 'Historical report for a previous UUID.';
        const values = panel.querySelector('.im-search-values');
        values.replaceChildren();
        const technical = panel.querySelector('.im-search-technical-values');
        technical.replaceChildren();
        const seconds = value => `${(value / 1000).toFixed(2)} s`;
        const rows = [
            ['Candidates tested', report.candidatesTested.toLocaleString()],
            ['Active search time', seconds(report.activeMs)],
            ['Average throughput', report.activeMs ? `${Math.round(report.candidatesTested * 1000 / report.activeMs).toLocaleString()} candidates/s` : 'Unavailable'],
            ['Found at', new Date(report.foundAt).toLocaleString()],
            ['Searched UUID', report.uuid], ['Mask', report.mask],
            ['Range / next cursor', `${report.start}–${report.endExclusive} (exclusive) / ${report.next}`],
            ['Started at', new Date(report.startedAt).toLocaleString()],
            ['Setup and compilation', seconds(report.setupMs)], ['Resumes', report.resumes],
            ['Algorithms / kernels / batch sizes / threads', report.variants.map(item => `${item.algorithm} · ${item.kernel} · ${item.batchSize.toLocaleString()} · ${item.workgroupSize || 256} threads · ${Math.round(item.activeMs > 0 ? item.candidatesTested * 1000 / item.activeMs : 0).toLocaleString()}/s`).join('; ')],
            ['CPU-verified candidates', report.cpuCandidates], ['Rejected padding candidates', report.rejectedCandidates],
            ['Padding / encrypted input', `${report.padding} bytes / ${report.inputBytes.toLocaleString()} bytes`],
            ['Input SHA-256', report.inputSha256], ['TB2 Dungeon', report.websiteVersion],
            ['GPU (last session)', report.adapter ? [report.adapter.vendor,report.adapter.architecture,report.adapter.description].filter(Boolean).join(' · ') || 'Unavailable' : 'Unavailable'],
            ['Browser (last session)', report.browser], ['Acceptance', 'CPU zero-padding check; not a certificate or device identity proof.']
        ];
        if (report.plan) {
            rows.push(['Starting mask', report.plan.startMask], ['Winning stage', report.plan.stages.length],
                ['Completed ranges excluded', report.plan.stages.slice(0, -1).map(stage => stage.mask.slice(-2)).join(', ') || 'None']);
            for (const [index, stage] of report.plan.stages.entries()) {
                rows.push([`Stage ${index + 1} · ${stage.mask}`,
                    `${stage.covered.toLocaleString()} covered · ${stage.candidatesTested.toLocaleString()} attempts · ${seconds(stage.activeMs)} active · ${seconds(stage.setupMs)} setup`]);
            }
        }
        for (const [index, [name, value]] of rows.entries()) {
            const term = document.createElement('dt'), description = document.createElement('dd');
            term.textContent = name; description.textContent = String(value);
            (index < 4 ? values : technical).append(term, description);
        }
    }

    async saveBoxDetails() {
        const form = this.dialog.querySelector('.im-box-form');
        let boxSerialNumber;
        try { boxSerialNumber = BoxIdentity.serial(form.elements.boxSerialNumber.value); }
        catch (error) { this.status(error.message); return; }
        const value = { ...this.boxExpected?.value, format: 1, id: this.selectedBox.id, name: form.elements.boxName.value.trim(),
            uuid: form.elements.boxUuid.value.trim().toUpperCase(), tcId: form.elements.tcBox.value,
            flashChipId: form.elements.boxChipId.value.trim().toUpperCase(),
            boxSerialNumber };
        const report = this.pendingSearchReport();
        if (report?.uuid === value.uuid) value.uuidSearch = report;
        if (this.boxExpected?.value.uuid && this.boxExpected.value.uuid !== value.uuid &&
            !confirm('Replace the saved UUID for this box?')) return;
        if (this.boxExpected?.value.flashChipId && this.boxExpected.value.flashChipId !== value.flashChipId &&
            !confirm('Replace or remove the saved flash chip assignment for this box?')) return;
        if (this.boxExpected?.value.boxSerialNumber && this.boxExpected.value.boxSerialNumber !== value.boxSerialNumber &&
            !confirm('Replace or remove the saved box serial number?')) return;
        await this.perform(async options => {
            const profile = await this.archive.saveBox(value, this.boxExpected, options);
            this.uuidRequest = null;
            this.renderList(); this.showBoxPanel(profile.value.id);
            this.status('Box details saved and verified. The working image is unchanged.');
            this.hooks.boxChanged?.(profile.value);
        });
    }

    /** Keep the small model picture next to the ordinary image assignment selector. */
    updateBoxPreview() {
        const preview = this.dialog.querySelector('.im-box-preview');
        const box = this.choices().find(item => item.id === this.field('box').value);
        preview.replaceChildren();
        preview.hidden = !box?.id;
        if (box?.id) preview.appendChild(this.boxPicture(box));
    }

    option(select, value, text) { const item = document.createElement('option'); item.value = value; item.textContent = text; select.appendChild(item); }
    /** Restore the selected box filter when refreshing its available choices. */
    updateBoxFilter() {
        const filter = this.dialog.querySelector('.im-box-filter');
        const previousValue = filter.options.length ? filter.value : '*';
        filter.replaceChildren();
        this.option(filter, '*', 'All boxes');
        for (const box of this.choices()) this.option(filter, box.id, box.name);
        filter.value = [...filter.options].some(option => option.value === previousValue) ? previousValue : '*';
        return filter.value;
    }

    /** Resolve current box labels without rewriting historical image metadata. */
    displayBox(entry) {
        const box = entry?.meta?.box || { id: '', name: 'Unassigned' };
        return this.archive.boxProfiles.find(item => item.value.id === box.id || (box.id && item.value.tcId === box.id))?.value || box;
    }

    /** Group by stable box identity, then sort detected firmware numerically within each box. */
    filteredEntries(boxId) {
        const query = this.dialog.querySelector('.im-search').value.toLowerCase();
        const type = this.dialog.querySelector('.im-type-filter').value;
        const entries = this.archive.entries.filter(entry =>
            (!type || (entry.meta?.type || 'Unknown') === type) &&
            (boxId === '*' || this.displayBox(entry).id === boxId) &&
            [entry.meta?.name || entry.name, this.displayBox(entry).name, ...BoxIdentity.FIELDS.map(field => this.displayBox(entry)[field] || ''), ...(entry.meta?.firmware || [])]
                .join(' ').toLowerCase().includes(query));
        return entries.sort((left, right) =>
            this.displayBox(left).name.localeCompare(this.displayBox(right).name) ||
            this.displayBox(left).id.localeCompare(this.displayBox(right).id) ||
            ImageManagerDialog.compareFirmware(left.meta?.firmware, right.meta?.firmware) ||
            (right.meta?.createdAt || '').localeCompare(left.meta?.createdAt || '') || left.path.localeCompare(right.path));
    }

    /** Pick the highest detected firmware numerically; never use the editable version note. */
    static firmwareVersion(firmware = []) {
        const versions = firmware.flatMap(label => {
            const match = /^(?:Primary|Secondary):\s*(\d+)\.(\d+)\.(\d+)(?:\+(\d+))?$/.exec(label);
            if (!match) return [];
            return [{text: label.slice(label.indexOf(':') + 1).trim(),
                parts: match.slice(1).map(value => Number(value || 0))}];
        });
        versions.sort((left, right) => {
            for (let index = 0; index < left.parts.length; index++) {
                if (left.parts[index] !== right.parts[index]) return right.parts[index] - left.parts[index];
            }
            return 0;
        });
        return versions[0] || null;
    }
    static firmwareLabel(firmware = []) {
        return this.firmwareVersion(firmware)?.text || 'Unknown firmware';
    }
    /** Unknown versions follow known versions; absence of a build number means build zero. */
    static compareFirmware(left, right) {
        const first = this.firmwareVersion(left), second = this.firmwareVersion(right);
        if (!first || !second) return first ? -1 : second ? 1 : 0;
        for (let index = 0; index < first.parts.length; index++) {
            if (first.parts[index] !== second.parts[index]) return first.parts[index] - second.parts[index];
        }
        return 0;
    }

    /** Rebuild groups without changing the selected entry or discarding a pending draft. */
    renderList() {
        if (!this.dialog || !this.archive) return;
        const entries = this.filteredEntries(this.updateBoxFilter());
        const list = this.dialog.querySelector('.im-list');
        const loaded = this.loadedArchiveImage();
        list.replaceChildren();
        let currentGroup = null;
        for (const entry of entries) {
            const boxName = this.displayBox(entry).name;
            if (currentGroup !== this.displayBox(entry).id) {
                const heading = document.createElement('h3');
                heading.textContent = boxName;
                list.appendChild(heading);
                currentGroup = this.displayBox(entry).id;
            }
            // Text content keeps archive labels inert, including unmanaged filenames.
            const button = document.createElement('button');
            button.type = 'button';
            button.disabled = this.active;
            const version = ImageManagerDialog.firmwareLabel(entry.meta?.firmware);
            const type = ['Original', 'Modified'].includes(entry.meta?.type) ? entry.meta.type : 'Unknown';
            const label = document.createElement('span');
            label.textContent = `${entry.meta?.protected ? '🔒 ' : ''}${version}${entry.missing ? ' · Image file missing' : !entry.meta ? ' · Unmanaged' : ''}`;
            button.setAttribute('aria-label', `${version} · ${type} image${entry.meta?.protected ? ' · Protected' : ''}`);
            button.appendChild(label);
            // Only modified images receive a symbol; the delta remains a real text character.
            if (type !== 'Original') {
                const badge = document.createElement('span');
                badge.className = 'im-image-type'; badge.title = `${type} image`;
                badge.setAttribute('aria-hidden', 'true');
                if (type === 'Modified') {
                    badge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><rect x="5" y="5" width="14" height="14" rx="2"/><path d="M8 2v3m8-3v3M8 19v3m8-3v3M2 8h3m-3 8h3M19 8h3m-3 8h3"/><text x="12" y="16" text-anchor="middle" fill="currentColor" stroke="none" font-family="Arial, sans-serif" font-size="12">Δ</text></svg>';
                } else badge.textContent = 'Unknown';
                button.appendChild(badge);
            }
            const isLoaded = !!loaded && entry.meta?.id === loaded.id;
            button.dataset.loaded = String(isLoaded);
            if (isLoaded) {
                const indicator = document.createElement('small');
                indicator.className = 'im-loaded'; indicator.setAttribute('aria-hidden', 'true');
                indicator.title = 'Currently loaded';
                button.appendChild(indicator);
                button.setAttribute('aria-label', button.getAttribute('aria-label') + ' · Currently loaded');
            }
            button.dataset.selected = String(this.selection?.path === entry.path);
            button.addEventListener('click', () => {
                if (!this.confirmDiscard(['.im-form', '.im-box-form'])) return;
                this.draft = null;
                this.manualId = null;
                this.selection = entry;
                this.renderDetails();
                this.renderList();
            });
            list.appendChild(button);
        }
        if (!entries.length) list.textContent = 'No matching images.';
        // Usage includes every archive file; this manager limit is not a server quota.
        this.dialog.querySelector('.im-usage').textContent = `${(this.archive.used / ImageManagerDialog.BYTES_PER_MIB).toFixed(2)} MiB / ${(this.archive.limit / ImageManagerDialog.BYTES_PER_MIB).toFixed(0)} MiB`;
        if (!this.formDirty('.im-settings')) {
            this.dialog.querySelector('[name="limit"]').value = this.archive.limit / ImageManagerDialog.BYTES_PER_MIB;
            this.markClean('.im-settings');
        }
    }
    renderDetails() {
        this.formBaselines.delete('.im-box-form');
        this.formBaselines.delete('.im-form');
        this.dialog.classList.remove('im-box-mode');
        this.dialog.querySelector('.im-box-note').hidden = true;
        this.dialog.querySelector('.im-box-panel').hidden = true;
        const entry = this.selection, draft = this.draft, meta = entry?.meta || draft?.meta;
        this.dialog.querySelector('.im-empty').hidden = !!(entry || draft);
        this.dialog.querySelector('.im-form').hidden = !(entry || draft);
        if (!entry && !draft) { this.lock(); return; }
        this.field('name').value = meta?.name || entry.name.replace(/\.bin$/i, '');
        this.field('notes').value = meta?.notes || ''; this.field('versionNote').value = meta?.versionNote || '';
        this.field('type').value = meta?.type || 'Unknown'; this.field('protected').checked = !!meta?.protected;
        const select = this.field('box'); select.replaceChildren();
        for (const box of this.choices()) this.option(select, box.id, box.name);
        if (meta?.box?.id && !this.choices().some(box => box.id === meta.box.id)) this.option(select, meta.box.id, meta.box.name + ' (unavailable)');
        this.option(select, '__new__', 'New box…'); select.value = entry?.meta ? this.displayBox(entry).id : meta?.box?.id || '';
        this.dialog.querySelector('.im-manual').hidden = true;
        this.updateBoxPreview();
        const firmware = meta?.firmware || [], highest = ImageManagerDialog.firmwareLabel(firmware);
        const firmwareLine = this.dialog.querySelector('.im-firmware');
        firmwareLine.replaceChildren();
        // Unknown regions remain neutral; both matching versions may share the highest value.
        for (const [index, value] of firmware.entries()) {
            if (index) firmwareLine.appendChild(document.createTextNode(' · '));
            const region = document.createElement('span'); region.textContent = value;
            if (highest !== 'Unknown firmware' && ImageManagerDialog.firmwareLabel([value]) === highest) {
                region.className = 'im-firmware-highest'; region.title = 'Active firmware';
            }
            firmwareLine.appendChild(region);
        }
        if (!firmware.length) firmwareLine.textContent = 'Firmware: Unknown';
        this.dialog.querySelector('.im-date').textContent = entry ? `${meta?.createdAt ? new Date(meta.createdAt).toLocaleString() + ' · ' : ''}${(entry.size/ImageManagerDialog.BYTES_PER_MIB).toFixed(2)} MiB` : '16 MiB · New image';
        this.dialog.querySelector('.im-path').textContent = entry?.path || 'A new archive file will be created.';
        if (entry?.missing) this.status('Image file missing. This entry contains restored metadata only.');
        this.dialog.querySelector('.im-hash').textContent = meta?.sha256 || '';
        this.dialog.querySelector('.im-save').textContent = draft ? 'Save image' : entry?.meta ? 'Save details' : 'Adopt image';
        this.markClean('.im-form');
        this.lock();
    }
    details() {
        const id = this.field('box').value;
        const box = id === '__new__' ? { id: this.manualId ||= 'manual:' + crypto.randomUUID(), name: this.field('manual').value.trim() } : this.choices().find(box => box.id === id) || (this.selection?.meta?.box.id === id ? this.selection.meta.box : null);
        if (!box?.name) throw new Error('Enter a box name.');
        return ImageArchive.details({ name:this.field('name').value, type:this.field('type').value,
            notes:this.field('notes').value, versionNote:this.field('versionNote').value, protected:this.field('protected').checked, box });
    }
    async prepare(bytes, name, type, sourceImage = null) {
        // Selecting a source returns from manager settings to its image details form.
        this.dialog.classList.remove('im-settings-open');
        this.dialog.querySelector('.im-settings').hidden = true;
        const facts = await this.hooks.inspect(bytes); if (this.abort.signal.aborted) return;
        this.selection = null; this.manualId = null;
        const box = this.hooks.identify ? await this.hooks.identify(bytes, this.archive.boxProfiles) : null;
        this.draft = { bytes, sourceImage, meta:{name,type,box:box ? {id:box.id,name:box.name} : {id:'',name:'Unassigned'},firmware:facts.firmware} };
        this.renderDetails(); this.status(facts.warning || 'Review the details, then select Save image.');
    }
    async save() {
        let details; try { details = this.details(); } catch (error) { this.status(error.message); return; }
        const entry = this.selection, draft = this.draft;
        const unprotect = entry?.meta?.protected && !details.protected;
        if (unprotect && !confirm('Remove image protection? This image can then be deleted in the manager.')) return;
        await this.perform(async options => {
            if (draft) {
                const result = await this.archive.save(draft.bytes, details, options);
                this.selection = result.entry; this.status(result.duplicate ? 'An identical image is already stored for this box.' : `Image saved and verified. ${result.warning || ''}`);
                // A saved working snapshot is managed immediately, without reloading or discarding edits.
                if (draft.sourceImage && draft.sourceImage === this.hooks.currentImage?.() &&
                    ImageArchive.same(draft.bytes, draft.sourceImage.subarray(0, draft.sourceImage.size))) {
                    this.loadedImage = {id: result.entry.meta.id, boxId: result.entry.meta.box.id, image: draft.sourceImage};
                    this.hooks.managedImageChanged?.();
                }
            } else if (entry.meta) {
                this.selection = await this.archive.update(entry, details, { ...options, confirmedUnprotect:unprotect }); this.status('Image details saved.');
                if (this.loadedArchiveImage()?.id === entry.meta.id) {
                    this.loadedImage.boxId = this.selection.meta.box.id;
                    this.hooks.managedImageChanged?.();
                }
            } else {
                this.selection = await this.archive.adopt(entry, details, options); this.status('Image adopted and verified.');
            }
            this.draft = null; this.renderList(); this.renderDetails();
        });
    }
    /** Download only explicit metadata bytes; the browser never receives archive image content here. */
    downloadMetadata(bytes) {
        const url = URL.createObjectURL(new Blob([bytes], {type:'application/json'}));
        const anchor = document.createElement('a'); anchor.href = url;
        anchor.download = `core-flasher-manager-${new Date().toISOString().slice(0,10)}.json`;
        anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    async previewRestore() {
        const file = this.dialog.querySelector('.im-backup-file').files[0];
        this.restorePlan = null;
        this.dialog.querySelector('.im-restore-preview').hidden = true;
        if (!file) return;
        await this.perform(async options => {
            if (file.size > ImageManagerBackup.MAX_BYTES) throw new Error('Metadata backup exceeds the 16 MiB limit.');
            const backup = new ImageManagerBackup(this.archive);
            this.restorePlan = await this.archive.run(() => file.arrayBuffer().then(buffer => backup.preview(new Uint8Array(buffer))), options);
            const plan = this.restorePlan;
            this.dialog.querySelector('.im-restore-summary').textContent = `${plan.added.length} added, ${plan.changed.length} replaced, ${plan.removed.length} removed; ${plan.missing.length} image files missing. Binary images will not change.`;
            const list = this.dialog.querySelector('.im-restore-files'); list.replaceChildren();
            for (const [label, records] of [['Add',plan.added],['Replace',plan.changed],['Remove',plan.removed]]) for (const record of records) {
                const row = document.createElement('li');
                row.textContent = `${label}: ${record.path}`;
                if (record.kind === 'box') row.textContent += ` · ${record.value.name} · ${record.value.boxSerialNumber || 'No serial'} · UUID ${record.value.uuid || 'not saved'} · Chip ${record.value.flashChipId || 'not saved'}`;
                if (record.kind === 'image') row.textContent += ` · ${record.value.box.name} · ${record.value.protected ? 'Protected' : 'Unprotected'}`;
                list.append(row);
            }
            for (const path of plan.missing) { const row = document.createElement('li'); row.textContent = `Image file missing: ${path}`; list.append(row); }
            const unprotect = this.dialog.querySelector('.im-restore-unprotect'); unprotect.checked = false;
            unprotect.closest('label').hidden = !plan.unprotected.length;
            this.dialog.querySelector('.im-restore-preview').hidden = false;
            this.status('Review the restore preview. Existing manager metadata will be replaced.');
        });
    }
    async metadataAction(action) {
        if (action === 'metadata-restore') {
            const input = this.dialog.querySelector('.im-backup-file'); input.value = ''; input.click(); return;
        }
        if (action === 'metadata-backup') return this.perform(async options => {
            const bytes = await this.archive.run(() => new ImageManagerBackup(this.archive).export(), options);
            this.downloadMetadata(bytes); this.status('Metadata backup downloaded. Image files are not included.');
        });
        if (action === 'metadata-confirm' && this.restorePlan) {
            const plan = this.restorePlan;
            const confirmedUnprotect = this.dialog.querySelector('.im-restore-unprotect').checked;
            if (plan.unprotected.length && !confirmedUnprotect) { this.status('Confirm removal of the listed image protection first.'); return; }
            if (!confirm('Replace manager metadata with this backup? Binary images will remain unchanged.')) return;
            return this.perform(async options => {
                try { await new ImageManagerBackup(this.archive).restore(plan, {...options, confirmedUnprotect}); }
                finally { this.restorePlan = null; this.hooks.metadataRestored?.(); }
                this.selection = null; this.loadedImage = null;
                this.draft = null; this.formBaselines.clear();
                this.dialog.querySelector('.im-restore-preview').hidden = true;
                this.renderList(); this.renderDetails(); this.status('Manager metadata restored and verified. Image files were not changed.');
            });
        }
    }
    async action(action) {
        if (this.active && !['close','cancel'].includes(action)) return;
        if (action.startsWith('metadata-')) {
            if (action === 'metadata-confirm' && !this.confirmDiscard()) return;
            return this.metadataAction(action);
        }
        if (action === 'close') return this.close();
        if (action === 'cancel') { this.abort?.abort(); this.status('Cancelling after the current file step…'); return; }
        if (this.active || !this.archive) return;
        if (action === 'fill-fields') return this.fillEmptyFields();
        // Only ask about forms that this action actually replaces or closes.
        if (action === 'back-images' && !this.confirmDiscard(['.im-box-form'])) return;
        if (['boxes','working','delete'].includes(action) && !this.confirmDiscard(['.im-form', '.im-box-form'])) return;
        if (['refresh','load','load-uuid'].includes(action) && !this.confirmDiscard()) return;
        if (action === 'boxes') { this.draft = null; this.formBaselines.delete('.im-form'); this.uuidRequest = null; this.dialog.classList.remove('im-settings-open'); this.dialog.querySelector('.im-settings').hidden = true; this.showBoxPanel(); return; }
        if (action === 'back-images') { this.uuidRequest = null; this.renderDetails(); return; }
        if (action === 'load-uuid') return this.perform(async () => {
            const uuid = await this.archive.boxUuid(this.selectedBox.id);
            if (!uuid) throw new Error('This box no longer has a saved UUID. Refresh the list.');
            if (this.abort.signal.aborted) throw new Error('Operation cancelled.');
            this.hooks.loadUuid(uuid); this.status('Box UUID loaded as the active UUID.');
            this.closeAfter = true;
        });
        if (action === 'settings') {
            const panel = this.dialog.querySelector('.im-settings'); panel.hidden = !panel.hidden;
            this.dialog.classList.toggle('im-settings-open', !panel.hidden); return;
        }
        if (action === 'upload') { this.dialog.querySelector('.im-file').value = ''; this.dialog.querySelector('.im-file').click(); return; }
        if (action === 'refresh') return this.perform(async () => {
            this.boxes = await this.archive.storage.boxes(); await this.archive.refresh();
            const managed = this.loadedArchiveImage();
            if (managed) {
                const source = this.archive.entries.find(item => item.meta?.id === managed.id && !item.missing);
                if (source) managed.boxId = source.meta.box.id;
                else this.loadedImage = null;
                this.hooks.managedImageChanged?.();
            }
            this.selection = this.archive.entries.find(e=>e.path===this.selection?.path) || null;
            this.draft = null; this.formBaselines.clear();
            this.renderList(); this.renderDetails(); this.status('Archive refreshed.');
        });
        if (action === 'working') {
            let snapshot; try { snapshot = this.hooks.snapshot(); } catch(error) { this.status(error.message); return; }
            const image = this.hooks.currentImage?.();
            return this.perform(async () => this.prepare(snapshot.bytes, snapshot.name, snapshot.modified ? 'Modified' : 'Unknown', image));
        }
        const entry = this.selection; if (!entry?.meta) return;
        if (action === 'delete') {
            if (entry.meta.protected) { this.status('Remove image protection before deleting.'); return; }
            if (!confirm(`Delete “${entry.meta.name}” for “${entry.meta.box.name}” and its image details?`)) return;
            return this.perform(async options => {
                await this.archive.delete(entry, options);
                if (this.loadedArchiveImage()?.id === entry.meta.id) {
                    this.loadedImage = null; this.hooks.managedImageChanged?.();
                }
                this.selection = null; this.renderList(); this.renderDetails(); this.status('Image deleted.');
            });
        }
        if (action === 'unprotect') { this.field('protected').checked = false; return this.save(); }
        if (action === 'load' || action === 'download') return this.perform(async () => {
            const bytes = await this.archive.verified(entry); if (this.abort.signal.aborted) throw new Error('Operation cancelled.');
            if (action === 'load') {
                const uuid = await this.archive.boxUuid(entry.meta.box.id);
                await this.archive.fresh(entry);
                if (!await this.hooks.load(bytes, entry.path.split('/').pop(), this.abort.signal, uuid, entry.meta.box.id)) return;
                // Retain provenance only after the verified load succeeds; cancellation keeps the old source.
                this.loadedImage = {id: entry.meta.id, boxId: entry.meta.box.id, image: this.hooks.currentImage?.()};
                this.hooks.managedImageChanged?.();
                this.closeAfter = true; this.previousFocus = null;
                setTimeout(() => this.hooks.navigate(), 0);
            } else {
                const url = URL.createObjectURL(new Blob([bytes], {type:'application/octet-stream'}));
                const anchor = document.createElement('a'); anchor.href = url; anchor.download = entry.path.split('/').pop(); anchor.click();
                setTimeout(()=>URL.revokeObjectURL(url),1000); this.status('Verified image download started.');
            }
        });
    }
}
if (typeof window !== 'undefined') window.ImageManagerDialog = ImageManagerDialog;
