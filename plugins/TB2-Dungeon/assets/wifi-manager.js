/* WLAN drafts and their narrow adapter to the existing settings codec and image transaction. */
'use strict';
class WifiProfiles {
    static LIMIT = 10;
    static BASE_PROFILES = 2;
    static MAX_SSID_BYTES = 32;
    static MAX_PSK_BYTES = 63;
    static SECURITY = Object.freeze({'0':'Open', '1':'WPA2-Personal', '3':'WPA3-Personal'});

    /** Retain original records so untouched settings and historical values survive editing. */
    constructor(bytes, codec, version) {
        this.codec = codec;
        this.original = bytes.slice();
        this.records = codec.parseSettingsBuffer(bytes);
        this.version = version;
        this.mode = version === '0.40.8' ? 'legacy' : ['1.6.22','1.6.28'].includes(version) ? 'priority' : 'unknown';
        this.profiles = Array.from({length:WifiProfiles.LIMIT}, (_, id) => this.empty(id));
        this.deleted = new Set();
        this.changed = false;
        for (const record of this.records) {
            const match = record.key.match(/^wifi\/profile\/(\d+)\/(.+)$/);
            if (!match) continue;
            const id = Number(match[1]);
            if (id >= WifiProfiles.LIMIT) throw new Error('More than ten WiFi profile positions found. Check the settings.');
            this.profiles[id].fields.set(match[2], record.valueBytes.slice());
        }
        // Text decoding is strict: malformed credentials must never be silently rewritten.
        for (const profile of this.profiles) {
            for (const field of ['ssid','psk','security']) {
                profile[field] = this.decode(profile.fields.get(field) || new Uint8Array());
            }
            profile.security ||= '0';
            const priority = profile.fields.get('priority');
            if (priority && priority.length !== 1) this.mode = 'unknown';
            profile.priority = priority?.[0] || 0;
        }
    }

    /** Construct an unsaved empty input row; base records are added only on Apply. */
    empty(id) {
        return {id, ssid:'', psk:'', security:'0', priority:0, fields:new Map(), touched:new Set()};
    }
    decode(bytes) { return new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(bytes); }
    encode(text) { return new TextEncoder().encode(text); }

    /** Stored priority is descending; equal values retain their WLAN-profile order. */
    ordered() {
        const filled = this.profiles.filter(profile => profile.ssid.length > 0);
        return filled.sort((left, right) => this.mode === 'priority'
            ? right.priority - left.priority || left.id - right.id : left.id - right.id);
    }
    visible() {
        const filled = this.ordered();
        const empty = this.profiles.find(profile => !profile.ssid);
        return empty ? [...filled, empty] : filled;
    }

    /** Update a draft only; an empty PSK is not a request to reveal its previous value. */
    set(id, field, value) {
        if (!['ssid','psk','security'].includes(field)) throw new Error('Unknown WiFi field.');
        const profile = this.profiles[id];
        if (!profile) throw new Error('Invalid WiFi profile position.');
        if (field === 'ssid' && !profile.ssid && value && !profile.fields.get('ssid')?.length) {
            if (!profile.touched.has('security')) { profile.security = '1'; profile.touched.add('security'); }
            if (this.mode === 'priority') {
                profile.priority = 0; profile.touched.add('priority');
            }
        }
        profile[field] = value;
        profile.touched.add(field);
        this.changed = true;
    }

    /** Deletion removes all historical records of this profile, including opaque fields. */
    remove(id) {
        const previous = this.profiles[id];
        if (!previous) throw new Error('Invalid WiFi profile position.');
        const empty = this.empty(id);
        if (previous.fields.has('last_used') || this.mode === 'legacy') empty.fields.set('last_used', new Uint8Array(2));
        if (previous.fields.has('priority') || this.mode === 'priority') empty.fields.set('priority', new Uint8Array(1));
        this.profiles[id] = empty;
        this.deleted.add(id);
        this.changed = true;
    }

    /** Reorder complete credentials, using slots only for the verified legacy format. */
    move(id, rank) {
        if (this.mode === 'unknown') throw new Error('Priority format is not confirmed for this firmware.');
        const ordered = this.ordered();
        const from = ordered.findIndex(profile => profile.id === id);
        if (from < 0 || !Number.isInteger(rank) || rank < 0 || rank >= ordered.length) throw new Error('Invalid WiFi rank.');
        if (this.mode === 'legacy') {
            if (id >= WifiProfiles.BASE_PROFILES || rank >= WifiProfiles.BASE_PROFILES || ordered[rank].id >= WifiProfiles.BASE_PROFILES) {
                throw new Error('This firmware prioritizes only WiFi profiles 0 and 1.');
            }
            const otherId = ordered[rank].id;
            [this.profiles[id], this.profiles[otherId]] = [this.profiles[otherId], this.profiles[id]];
            for (const slot of [id, otherId]) { this.profiles[slot].id = slot; this.deleted.add(slot); }
        } else {
            const [selected] = ordered.splice(from, 1);
            ordered.splice(rank, 0, selected);
            ordered.forEach((profile, index) => {
                profile.priority = ordered.length - index;
                profile.touched.add('priority');
            });
        }
        this.changed = true;
    }

    /** Validate edited credentials while leaving unrecognized, unchanged values opaque. */
    validate(profile) {
        if (!profile.ssid || !['ssid','psk','security'].some(field => profile.touched.has(field))) return;
        const ssidBytes = this.encode(profile.ssid), pskBytes = this.encode(profile.psk);
        if (ssidBytes.length > WifiProfiles.MAX_SSID_BYTES || profile.ssid.includes('\0')) throw new Error('SSID: up to 32 UTF-8 bytes, without null characters.');
        if (profile.psk.includes('\0')) throw new Error('PSK must not contain null characters.');
        if (!Object.hasOwn(WifiProfiles.SECURITY, profile.security)) {
            if (profile.touched.has('security') || profile.touched.has('psk')) throw new Error('Unknown security type: keep the PSK unchanged or select a supported security type.');
            return;
        }
        if (profile.security === '0' && pskBytes.length) throw new Error('Open networks require an empty PSK.');
        if (profile.security !== '0' && (pskBytes.length < 8 || pskBytes.length > WifiProfiles.MAX_PSK_BYTES)) {
            throw new Error('PSK: 8 to 63 UTF-8 bytes required.');
        }
    }

    /** Serialize only changed latest values; deleting a profile is intentionally history-wide. */
    serialize() {
        const replacements = new Map(), latest = new Map();
        this.records.forEach((record, index) => latest.set(record.key, index));
        for (const profile of this.profiles) {
            this.validate(profile);
            if (!profile.ssid && profile.id >= WifiProfiles.BASE_PROFILES) continue;
            const fields = new Map(profile.fields);
            if (this.mode === 'legacy' && !fields.has('last_used')) fields.set('last_used', new Uint8Array(2));
            for (const field of ['ssid','psk','security']) {
                if (!fields.has(field) || profile.touched.has(field)) fields.set(field, this.encode(profile[field]));
            }
            // Clearing the SSID has the same persistence semantics as the Delete button.
            if (!profile.ssid) {
                fields.set('ssid', new Uint8Array()); fields.set('psk', new Uint8Array()); fields.set('security', this.encode('0'));
                if (fields.has('last_used') || this.mode === 'legacy') fields.set('last_used', new Uint8Array(2));
                if (fields.has('priority') || this.mode === 'priority') fields.set('priority', new Uint8Array(1));
            } else if (profile.touched.has('priority') || (this.mode === 'priority' && !fields.has('priority'))) {
                fields.set('priority', new Uint8Array([profile.priority]));
            }
            for (const [field, valueBytes] of fields) replacements.set(`wifi/profile/${profile.id}/${field}`, valueBytes);
        }
        const result = [];
        for (let index = 0; index < this.records.length; index++) {
            const record = this.records[index], match = record.key.match(/^wifi\/profile\/(\d+)\//);
            if (!match) { result.push(record); continue; }
            const id = Number(match[1]), profile = this.profiles[id];
            if (this.deleted.has(id) || (!profile.ssid && (id >= WifiProfiles.BASE_PROFILES || profile.touched.has('ssid')))) continue;
            if (index !== latest.get(record.key)) { result.push(record); continue; }
            result.push({...record, valueBytes:replacements.get(record.key) || record.valueBytes});
            replacements.delete(record.key);
        }
        for (const [key, valueBytes] of replacements) result.push({key, valueBytes});
        return this.codec.serializeRecords(result);
    }
}

class WifiImage {
    /** Read only the primary firmware header; it is image metadata, not device telemetry. */
    static version(image) {
        const version = FirmwareImage.settingsVersion(image);
        if (version[0] === 0 && (version[1] < 40 || (version[1] === 40 && version[2] < 8))) throw new Error('WiFi Manager requires a working image with firmware 0.40.8 or later.');
        return version.join('.');
    }

    /** All filesystem operations use existing LittleFS geometry and its checked writer. */
    static async parser(image) {
        const parser = new LittleFSParser(image, FirmwareImage.LFS, FirmwareImage.SIZE - FirmwareImage.LFS);
        await parser.initialize();
        return parser;
    }

    /** Stage privately, read back, and check concurrent edits before publishing any overlay. */
    static async apply(image, draft, current) {
        const desiredSettings = draft.serialize();
        const baseline = image.subarray(0, image.size).slice();
        const staged = SparseImage.fromBuffer(baseline.slice());
        const parser = await this.parser(staged);
        const result = await parser.writeFileChecked('/settings', desiredSettings, draft.original);
        if (!result?.success) throw new Error('Could not write WiFi settings without conflicts.');
        const candidate = staged.subarray(0, staged.size).slice();
        const verifier = await this.parser(SparseImage.fromBuffer(candidate));
        if (!FirmwareImage.equal(await verifier.readFile('/settings'), desiredSettings)) throw new Error('WiFi readback mismatch.');
        // A late source switch or another writer leaves the live image entirely untouched.
        if (!current() || !FirmwareImage.equal(image.subarray(0, image.size), baseline)) throw new Error('Working image changed. Reload WiFi settings.');
        if (!result.changed) return false;
        image.writeBuffer = FirmwareImage.stage(image, candidate);
        return true;
    }
}

class WifiManagerController {
    /** The tile owns UI state; credentials exist only in this page's current image and draft. */
    constructor(tile) {
        this.tile = tile;
        this.root = tile.element;
        this.rows = this.root.querySelector('.js-wifi-rows');
        this.status = this.root.querySelector('.js-wifi-status');
        this.note = this.root.querySelector('.js-wifi-note');
        this.save = this.root.querySelector('.js-wifi-save');
        this.reload = this.root.querySelector('.js-wifi-reload');
        this.revealed = new Set();
        this.generation = 0;
        this.draft = null;
        this.image = null;
        this.revision = -1;
        this.failedRevision = null;
        this.save.addEventListener('click', event => { event.stopPropagation(); this.apply(); });
        this.reload.addEventListener('click', event => { event.stopPropagation(); this.load(); });
        // A single delegated handler keeps dynamically added rows independent of registration order.
        this.rows.addEventListener('input', event => this.edit(event));
        this.rows.addEventListener('change', event => this.choose(event));
        this.rows.addEventListener('click', event => this.click(event));
        this.timer = setInterval(() => { if (tile.isFocused) this.update(); }, 500);
    }

    /** Complete snapshots remain usable after disconnect; no live reads are triggered by browsing. */
    available() { return CoreFlasherDumpUi.complete(window.interface) && window.interface.size === FirmwareImage.SIZE; }
    blocked() {
        return CoreFlasherDumpUi.busy() || !!this.tile.context.operations.otherCardBusy(this.tile);
    }
    writable() { return this.available() && !window.interface.readOnly && window.AppState.interfaceMode === 'rw-buffered'; }
    current() { return this.image === window.interface && this.revision === Number(window.AppState.interfaceRevision || 0); }

    /** Never replace dirty drafts after another editor changes the image. */
    update() {
        this.tile.enabled = this.available();
        this.tile.updateStyles();
        if (this.image && this.image !== window.interface) {
            this.generation++;
            this.image = null; this.draft = null; this.failedRevision = null;
            this.hidePasswords(); this.rows.replaceChildren();
        }
        const revision = Number(window.AppState.interfaceRevision || 0);
        if (!this.available()) this.status.textContent = 'Load a complete working image to edit WiFi profiles.';
        else if (this.draft?.changed && !this.current()) this.status.textContent = 'Working image changed. Draft retained; discard it and reload.';
        else if (this.tile.isFocused && !this.tile._busy && !this.blocked() &&
            (!this.draft || (!this.current() && !this.draft.changed)) && this.failedRevision !== revision) this.load();
        this.refresh();
    }

    /** Refresh locks without rerendering text inputs or disturbing their caret. */
    refresh() {
        const locked = !this.draft || this.blocked() || !this.current() || !this.writable();
        this.save.disabled = locked || !this.draft?.changed;
        this.reload.disabled = !this.available() || this.blocked();
        for (const input of this.rows.querySelectorAll('input,select,button')) {
            input.disabled = locked || input.dataset.unsupported === 'true';
            if (input.dataset.action === 'reveal') input.disabled = !this.draft || this.blocked();
        }
        if (this.draft) {
            const legacyExtra = this.draft.mode === 'legacy' && this.draft.ordered().some(profile => profile.id >= WifiProfiles.BASE_PROFILES);
            this.note.textContent = (this.draft.changed ? 'Draft — not applied. ' : '') + `Working image: ${this.draft.version} · Rank 1 = preferred. ` +
                (legacyExtra ? 'This firmware uses only WiFi profiles 0 and 1; additional profiles are stored only.' :
                this.draft.mode === 'legacy' ? 'This firmware uses WiFi profiles 0 and 1.' :
                this.draft.mode === 'unknown' ? 'Compatibility and priority format unconfirmed; rank editing disabled.' : 'Ten WiFi profiles; a higher stored priority is preferred.') +
                (!this.writable() ? ' Enable Read / Write to edit.' : '');
        }
    }

    /** Load through the existing codec without changing File Manager's selection. */
    async load() {
        if (!this.available() || this.blocked()) return;
        const image = window.interface, revision = Number(window.AppState.interfaceRevision || 0);
        const generation = ++this.generation;
        this.tile._busy = true; this.hidePasswords(); this.refresh();
        try {
            const version = WifiImage.version(image), parser = await WifiImage.parser(image);
            const bytes = await parser.readFile('/settings');
            if (generation !== this.generation || image !== window.interface || revision !== Number(window.AppState.interfaceRevision || 0)) return;
            this.draft = new WifiProfiles(bytes, this.tile.context.settings, version);
            this.image = image; this.revision = revision; this.failedRevision = null;
            this.status.textContent = 'WiFi settings loaded. Changes remain in the draft until applied.';
            this.render();
        } catch (error) {
            if (generation !== this.generation || image !== window.interface) return;
            this.draft = null; this.image = image; this.failedRevision = revision;
            this.rows.replaceChildren(); this.status.textContent = `WiFi settings not loaded: ${error.message}`;
        } finally { this.tile._busy = false; this.refresh(); }
    }

    /** Create labelled controls using DOM properties, never credential-bearing HTML strings. */
    field(row, text, field, value, type = 'text') {
        const label = document.createElement('label'); label.className = 'cf-wifi-field';
        const caption = document.createElement('span'); caption.textContent = text;
        const input = document.createElement('input'); input.type = type; input.value = value;
        input.dataset.field = field; input.autocomplete = 'off'; input.spellcheck = false;
        label.append(caption, input); row.append(label); return input;
    }
    button(text, action, label) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'cf-dump-button'; button.textContent = text; button.dataset.action = action;
        if (label) button.setAttribute('aria-label', label);
        return button;
    }

    /** Rebuild only when the row set or its ordering changes. */
    render() {
        const active = document.activeElement;
        const focus = active?.dataset.field ? {id:active.closest('[data-profile]')?.dataset.profile, field:active.dataset.field, caret:active.selectionStart} : null;
        const scroll = this.rows.scrollTop;
        const fragment = document.createDocumentFragment(), ordered = this.draft.ordered();
        for (const profile of this.draft.visible()) {
            const row = document.createElement('div'); row.className = 'cf-wifi-row'; row.dataset.profile = profile.id;
            const title = document.createElement('span'); title.className = 'cf-wifi-id'; title.textContent = `WiFi ${profile.id}`;
            row.append(title); this.field(row, 'SSID', 'ssid', profile.ssid);
            const password = this.field(row, 'PSK', 'psk', profile.psk, this.revealed.has(profile.id) ? 'text' : 'password');
            const reveal = this.button('◉', 'reveal', `Show or hide PSK for WiFi profile ${profile.id}`);
            reveal.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/></svg>';
            reveal.setAttribute('aria-pressed', String(this.revealed.has(profile.id)));
            password.parentElement.classList.add('cf-wifi-password'); password.parentElement.append(reveal);
            // Unrecognized values get a descriptive preservation option, never a raw numeric label.
            const securityLabel = document.createElement('label'); securityLabel.className = 'cf-wifi-field';
            const caption = document.createElement('span'); caption.textContent = 'Security';
            const security = document.createElement('select'); security.dataset.field = 'security';
            const choices = {...WifiProfiles.SECURITY};
            if (!Object.hasOwn(choices, profile.security)) choices[profile.security] = 'Unknown security type';
            for (const [value, text] of Object.entries(choices)) security.add(new Option(text, value));
            security.value = profile.security; securityLabel.append(caption, security); row.append(securityLabel);
            const rankLabel = document.createElement('label'); rankLabel.className = 'cf-wifi-field';
            const rankCaption = document.createElement('span'); rankCaption.textContent = 'Rank';
            const rank = document.createElement('select'); rank.dataset.field = 'rank';
            ordered.forEach((entry, index) => rank.add(new Option(String(index + 1), String(index))));
            rank.value = String(ordered.findIndex(entry => entry.id === profile.id));
            rank.dataset.unsupported = String(!profile.ssid || this.draft.mode === 'unknown' || (this.draft.mode === 'legacy' && profile.id >= WifiProfiles.BASE_PROFILES));
            if (this.draft.mode === 'legacy') for (const option of rank.options) option.disabled = ordered[Number(option.value)]?.id >= WifiProfiles.BASE_PROFILES;
            rankLabel.append(rankCaption, rank); row.append(rankLabel, this.button('Delete', 'delete'));
            fragment.append(row);
        }
        this.rows.replaceChildren(fragment); this.rows.scrollTop = scroll; this.refresh();
        if (focus) {
            const input = this.rows.querySelector(`[data-profile="${focus.id}"] [data-field="${focus.field}"]`);
            input?.focus(); if (input?.setSelectionRange && focus.caret !== null) input.setSelectionRange(focus.caret, focus.caret);
        }
    }

    /** Text edits reveal the next empty row as soon as a new SSID is entered. */
    edit(event) {
        const input = event.target, row = input.closest('[data-profile]');
        if (!row || input.tagName !== 'INPUT' || input.disabled || !this.current() || this.blocked() || !this.writable()) return;
        const id = Number(row.dataset.profile), wasFilled = !!this.draft.profiles[id].ssid;
        this.draft.set(id, input.dataset.field, input.value);
        if (wasFilled !== !!this.draft.profiles[id].ssid) this.render();
        this.status.textContent = 'Draft changed · not yet applied to the working image.'; this.refresh();
    }
    choose(event) {
        const input = event.target, row = input.closest('[data-profile]');
        if (!row || input.tagName !== 'SELECT' || input.disabled || !this.current() || this.blocked() || !this.writable()) return;
        try {
            const id = Number(row.dataset.profile);
            if (input.dataset.field === 'rank') { this.draft.move(id, Number(input.value)); this.hidePasswords(); }
            else this.draft.set(id, 'security', input.value);
            this.status.textContent = 'Draft changed · not yet applied to the working image.'; this.render();
        } catch (error) { this.status.textContent = error.message; }
    }

    /** User-triggered reveal never changes the image or any persistent preference. */
    click(event) {
        const button = event.target.closest('button[data-action]'), row = button?.closest('[data-profile]');
        if (!button || button.disabled || !row || !this.draft || this.blocked()) return;
        event.stopPropagation(); const id = Number(row.dataset.profile);
        if (button.dataset.action === 'reveal') {
            if (this.revealed.has(id)) this.revealed.delete(id); else this.revealed.add(id);
        } else {
            if (!this.current() || !this.writable()) return;
            this.draft.remove(id); this.revealed.delete(id);
            this.status.textContent = 'WiFi profile deleted from the draft. Apply changes to update the working image.';
        }
        this.render();
    }
    hidePasswords() {
        this.revealed.clear();
        for (const input of this.rows.querySelectorAll('[data-field="psk"]')) input.type = 'password';
        for (const button of this.rows.querySelectorAll('[data-action="reveal"]')) button.setAttribute('aria-pressed', 'false');
    }

    /** Publish one verified local transaction, then notify the existing editors and export UI. */
    async apply() {
        if (!this.draft?.changed || !this.current() || !this.writable() || this.blocked()) return;
        const image = this.image, revision = this.revision, generation = this.generation;
        let lease;
        try {
            lease = this.tile.context.operations.beginImageEdit(this.tile, image);
            this.tile._busy = true; window.AppState.wifiBusy = true; this.refresh();
            const changed = await WifiImage.apply(image, this.draft, () => image === window.interface &&
                revision === Number(window.AppState.interfaceRevision || 0) && generation === this.generation);
            if (changed) {
                window.AppState.interfaceRevision = revision + 1;
                window.AppState.settingsSelectionRevision = Number(window.AppState.settingsSelectionRevision || 0) + 1;
                window.AppState.littlefsParser = null; window.AppState.littlefsParserSource = null;
                if (typeof LFS_IMAGE_PARSERS !== 'undefined') LFS_IMAGE_PARSERS.delete(image);
            }
            this.draft.changed = false; this.failedRevision = null; this.draft = null;
            this.status.textContent = 'WiFi settings applied and verified. Save or flash in Dump / Flash.';
        } catch (error) {
            this.status.textContent = `Not applied: ${error.message}`;
        } finally {
            lease?.release();
            this.tile._busy = false; window.AppState.wifiBusy = false;
            this.tile.tileManager?.broadcastUpdate(this.tile); this.refresh();
        }
    }
}

if (typeof module !== 'undefined') module.exports = {WifiProfiles, WifiImage};
