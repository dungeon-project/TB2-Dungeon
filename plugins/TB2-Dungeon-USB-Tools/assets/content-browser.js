/** Small card controller; handles, selections and audio stay in this page session. */
class Tb2ContentBrowser {
    static PAGE_SIZE = 50;
    constructor(tile) {
        this.tile = tile; this.element = tile.element;
        this.root = null; this.imageFile = null; this.result = { collections: [], files: 0, complete: false };
        this.collection = null; this.track = null;
        this.collectionPage = 0; this.trackPage = 0;
        this.scanGeneration = 0; this.mediaGeneration = 0; this.audioUrl = null;
        this.downloadUrls = new Map(); this.abort = null; this.picking = false; this.opening = false;
        this.audio = this.find('audio'); this.status = this.find('status');
        this.catalog = new Tb2CollectionSupport.Tb2TonieCatalog(document.baseURI);
        this.disposed = false; this.resumeCollection = null;
        this.bind(); this.render();
        this.catalog.readCached().then(status => {
            if (!this.disposed) { this.find('catalog-status').textContent = status; this.applyCatalog(); }
        });
    }
    find(name) { return this.element.querySelector(`[data-browser="${name}"]`); }
    usbAllowed() { return this.tile.context.usbPresence.allowed(); }
    supported() { return this.usbAllowed() && window.isSecureContext && typeof window.showDirectoryPicker === 'function'; }
    message(text) {
        this.status.textContent = text;
        if (this.usbLost) this.tile.context.usbPresence.report(`TeddyBench: ${text}`);
    }
    usbDisconnected() {
        this.usbLost = true; this.pickGeneration = (this.pickGeneration || 0) + 1;
        this.abort?.abort(); this.stop();
        if (this.figureModal?.open) { this.figureModal.close(); this.figureModal.remove(); }
        this.message('USB interface unavailable. Pending actions cancelled; running file steps are stopping.');
    }
    get saving() { return !!this.tile.operationRunning; }

    /** Buttons own their clicks so the canvas does not recenter while operating controls. */
    bind() {
        const actions = { select: () => this.pick(), refresh: () => this.scan(), cancel: () => this.abort?.abort(),
            play: () => this.play(), export: () => this.exportTrack(),
            catalog: () => this.updateCatalog(), save: () => this.saveBehavior(),
            add: () => this.figureDialog(), delete: () => this.deleteFigure(),
            'collections-prev': () => this.page('collection', -1), 'collections-next': () => this.page('collection', 1),
            'tracks-prev': () => this.page('track', -1), 'tracks-next': () => this.page('track', 1) };
        for (const [name, action] of Object.entries(actions)) this.find(name).addEventListener('click', event => {
            event.stopPropagation(); action();
        });
        // Image selection uses a read-only File, never a writable filesystem handle.
        this.find('image').addEventListener('click', event => {
            event.stopPropagation();
            if (window.DEV_MODE && !this.picking && !this.saving) this.find('image-file').click();
        });
        this.find('image-file').addEventListener('change', event => {
            const file = event.target.files[0]; event.target.value = '';
            if (file) this.loadImage(file);
        });
        this.find('behavior').addEventListener('change', () => this.renderControls());
        for (const name of ['search', 'filter']) this.find(name).addEventListener('input', () => {
            if (this.saving) return;
            this.collectionPage = 0;
            if (this.collection && !this.filtered().includes(this.collection)) {
                this.stop(); this.collection = this.track = null; this.trackPage = 0;
                this.renderTracks(); this.renderControls();
            }
            this.renderCollections();
        });
        this.audio.addEventListener('error', () => {
            if (!this.audioUrl) return;
            this.stop(); this.message('Audio could not be decoded. The file may be unsupported or incomplete.');
        });
        this.audio.addEventListener('loadedmetadata', () => {
            this.message('Audio loaded. Playback does not verify file completeness.');
        });
        // Chromium can hide its native seek control in narrow cards; keep a touch-sized fallback.
        const seek = this.find('seek');
        for (const event of ['loadedmetadata', 'durationchange', 'timeupdate', 'emptied']) this.audio.addEventListener(event, () => {
            const duration = Number.isFinite(this.audio.duration) ? this.audio.duration : 0;
            seek.disabled = duration <= 0; seek.max = String(duration);
            seek.value = String(Math.min(duration, this.audio.currentTime || 0));
        });
        seek.addEventListener('input', () => {
            if (Number.isFinite(this.audio.duration)) this.audio.currentTime = Math.min(this.audio.duration, Number(seek.value));
        });
        window.addEventListener('pagehide', () => this.dispose());
    }

    /** Cancelled pickers preserve the existing folder and selection. */
    async pick() {
        if (this.saving || this.picking || !this.supported()) return;
        const generation = this.pickGeneration || 0;
        this.usbLost = false; this.picking = true; this.renderControls();
        try {
            const root = await window.showDirectoryPicker({ id: 'core-teddybench-content', mode: 'read' });
            if (!this.usbAllowed() || generation !== (this.pickGeneration || 0)) return;
            this.root = root; this.imageFile = null; await this.scan();
        } catch (error) {
            this.message(error.name === 'AbortError' ? 'Folder selection cancelled.' : 'Folder selection failed. Check browser permissions.');
        } finally { this.picking = false; this.renderControls(); }
    }

    /** The developer guard also applies to direct controller calls, not only button visibility. */
    async loadImage(file) {
        if (!window.DEV_MODE || this.saving || this.picking || !file) return;
        this.imageFile = file; this.root = null;
        await this.scan();
    }

    /** A generation token prevents an old scan from replacing a newly selected folder. */
    async scan() {
        if (!this.usbAllowed() || this.saving) return;
        if (!this.root && !this.imageFile) return;
        if (this.imageFile && !window.DEV_MODE) return;
        this.abort?.abort(); this.stop();
        const generation = ++this.scanGeneration;
        const abort = new AbortController(); this.abort = abort;
        const result = { collections: [], files: 0, complete: false };
        this.result = result; this.collection = null; this.track = null;
        this.collectionPage = this.trackPage = 0;
        this.message(this.imageFile ? 'Reading FAT32 SD image (read-only)…' : 'Scanning local folders…'); this.render();
        try {
            const root = this.imageFile ? await Tb2Fat32Image.open(this.imageFile, abort.signal) : this.root;
            await Tb2ContentReader.scan(root, { signal: abort.signal, result, progress: counts => {
                if (generation === this.scanGeneration) this.message(`Scanning · ${counts.files} files · ${counts.collections} collections`);
            } });
            abort.signal.throwIfAborted();
            if (generation === this.scanGeneration) {
                this.catalog.apply(result.collections);
                this.message(`Scan complete · ${result.files} files · ${result.collections.length} collections`);
            }
        } catch (error) {
            if (abort.signal.aborted) result.complete = false;
            if (generation === this.scanGeneration) this.message(abort.signal.aborted ?
                'Scan cancelled. Results are incomplete.' : this.imageFile ?
                    `Image scan stopped. Results are incomplete. ${error.message}` :
                    'Scan stopped. Results are incomplete. Check folder structure and read permissions.');
        } finally {
            if (generation === this.scanGeneration) { this.abort = null; this.render(); }
        }
    }

    /** Catalog titles are presentation state only; selection and track labels stay intact. */
    applyCatalog() {
        this.catalog.apply(this.result.collections); this.render();
    }
    async updateCatalog() {
        if (this.saving || this.catalog.pending || this.disposed) return;
        this.find('catalog-status').textContent = 'Loading public catalog…';
        const pending = this.catalog.update(); this.renderControls();
        const status = await pending;
        if (!this.disposed) { this.find('catalog-status').textContent = status; this.applyCatalog(); }
    }

    /** Save is the only write-permission entry point; the service repeats all source checks. */
    async saveBehavior() {
        if (!this.usbAllowed() || this.saving || this.imageFile || !this.root || this.abort || this.picking || !this.result.complete || !this.collection?.editing) return;
        const record = this.collection.editing, value = this.find('behavior').value;
        if (record.issue || record.readOnly || !Tb2CollectionSupport.Tb2CollectionEditing.VALUES.has(value) || value === record.value) return;
        this.usbLost = false; this.tile.operationRunning = true; this.abort = new AbortController(); this.stop(); this.renderControls();
        this.message('Saving playback behavior…');
        try {
            await Tb2CollectionSupport.Tb2CollectionEditing.save(record, value, this.abort.signal);
            this.message('Playback behavior saved and read back. Device behavior has not been verified.');
        } catch (error) { this.message(error.message); }
        finally { this.tile.operationRunning = false; this.abort = null; this.renderControls(); }
    }

    /** Native modal dialogs isolate draft controls from workspace keyboard navigation. */
    createFigureDialog(title) {
        const dialog = document.createElement('dialog'); dialog.className = 'tb2-figure-dialog';
        const heading = document.createElement('h3'); heading.textContent = title; dialog.append(heading);
        const notice = document.createElement('p');
        notice.textContent = 'Folder writes only. Device acceptance has not been hardware-tested. Keep a separate backup.';
        dialog.append(notice);
        const status = document.createElement('pre'); status.className = 'tb2-figure-status'; status.setAttribute('role', 'status');
        const actions = document.createElement('div'); actions.className = 'tb2-browser-toolbar';
        const cancel = document.createElement('button'); cancel.type = 'button'; cancel.textContent = 'Cancel';
        actions.append(cancel); dialog.append(status, actions);
        const close = () => { if (this.saving) this.abort?.abort(); else { dialog.close(); dialog.remove(); } };
        cancel.addEventListener('click', close);
        dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
        dialog.addEventListener('click', event => event.stopPropagation());
        this.figureModal = dialog;
        document.body.append(dialog); dialog.showModal();
        return { dialog, status, actions, cancel };
    }

    /** Ordered File objects stay in memory; input filenames are never used as content references. */
    figureDialog() {
        if (!this.usbAllowed() || this.find('add').disabled) return;
        const modal = this.createFigureDialog('Add figure'), files = [];
        const form = document.createElement('div');
        form.innerHTML = '<label>Figure UID <input data-figure="uid" placeholder="E004…" autocomplete="off" /></label>' +
            '<p data-figure="filename"></p><button type="button" data-figure="choose">Choose MP3 or Ogg/Opus tracks</button><input data-figure="files" type="file" accept=".mp3,.opus,.ogg,audio/mpeg,audio/ogg" multiple hidden />' +
            '<p>MP3 files are converted locally to Ogg/Opus. Existing Ogg/Opus files remain unchanged.</p>' +
            '<ol data-figure="tracks" class="tb2-figure-tracks"></ol>';
        modal.dialog.insertBefore(form, modal.status);
        const input = form.querySelector('[data-figure="uid"]'), picker = form.querySelector('[data-figure="files"]');
        const list = form.querySelector('[data-figure="tracks"]'), filename = form.querySelector('[data-figure="filename"]');
        const save = document.createElement('button'); save.type = 'button'; save.textContent = 'Add figure'; modal.actions.prepend(save);
        const render = () => {
            let valid = false;
            try { filename.textContent = 'Collection file: ' + Tb2FigureEditing.uid(input.value); valid = true; }
            catch { filename.textContent = 'Enter eight UID bytes in display order, starting with E004.'; }
            save.disabled = !valid || !files.length || this.saving || !this.result.complete;
            list.replaceChildren();
            files.forEach((file, index) => {
                const row = document.createElement('li'), label = document.createElement('span'); label.textContent = file.name; row.append(label);
                for (const [text, offset] of [['Move up', -1], ['Move down', 1], ['Remove', 0]]) {
                    const button = document.createElement('button'); button.type = 'button'; button.textContent = text;
                    button.disabled = this.saving || (offset !== 0 && (index + offset < 0 || index + offset >= files.length));
                    button.addEventListener('click', () => {
                        if (offset === 0) files.splice(index, 1);
                        else [files[index], files[index + offset]] = [files[index + offset], files[index]];
                        render();
                    }); row.append(button);
                }
                list.append(row);
            });
        };
        form.querySelector('[data-figure="choose"]').addEventListener('click', () => picker.click());
        input.addEventListener('input', render);
        picker.addEventListener('change', () => { files.push(...picker.files); picker.value = ''; render(); });
        save.addEventListener('click', async () => {
            form.inert = true; save.disabled = true;
            await this.runFigureOperation(modal, options => Tb2FigureEditing.add(this.root, input.value, files, options), 'Figure added and files verified. Device acceptance remains unverified.');
            form.inert = false; render();
        }); render();
    }

    /** Preview lists only actual paths and decisions; raw collection JSON is never rendered. */
    async deleteFigure() {
        if (!this.usbAllowed() || this.find('delete').disabled) return;
        const modal = this.createFigureDialog('Delete figure and content');
        this.usbLost = false; this.tile.operationRunning = true; this.abort = new AbortController(); this.renderControls(); this.stop();
        let preview;
        try {
            modal.status.textContent = 'Checking all collection references and files…';
            preview = await Tb2FigureEditing.preview(this.root, this.collection.sourceName, { signal: this.abort.signal });
            modal.status.textContent = 'Delete:\n' + preview.remove.map(record => record.path).join('\n') +
                '\n\nKeep:\n' + (preview.preserved.map(record => `${record.path} (${record.reason})`).concat(preview.skipped).join('\n') || 'No shared or ambiguous files.') +
                '\n\nThis permanently removes the listed files. No other files or directories will be removed.';
        } catch (error) {
            modal.status.textContent = error.message;
            if (this.usbLost) this.message('Delete preview cancelled. No files were changed.');
        }
        finally { this.tile.operationRunning = false; this.abort = null; this.renderControls(); }
        if (!preview || !this.usbAllowed()) return;
        const confirm = document.createElement('button'); confirm.type = 'button'; confirm.textContent = 'Delete listed files'; modal.actions.prepend(confirm);
        confirm.addEventListener('click', async () => {
            confirm.disabled = true;
            await this.runFigureOperation(modal, options => Tb2FigureEditing.remove(preview, options), 'Figure deleted. Shared and unrelated content was preserved.');
            // A failed or cancelled deletion needs a fresh preview, never a blind retry.
            confirm.remove();
        });
    }

    /** Reuse the existing tile and content locks; cancellation stops at the next file step. */
    async runFigureOperation(modal, action, success) {
        if (!this.usbAllowed() || this.saving || this.imageFile || !this.root) return;
        this.usbLost = false; this.tile.operationRunning = true; this.abort = new AbortController(); this.stop(); this.renderControls();
        try {
            const result = await action({ signal: this.abort.signal, progress: text => { modal.status.textContent = text; this.message(text); } });
            this.abort.signal.throwIfAborted();
            this.result = result; this.collection = this.track = null; this.applyCatalog(); this.message(success);
            modal.dialog.close(); modal.dialog.remove();
        } catch (error) {
            modal.status.textContent = error.message; this.message(error.message);
            this.result.complete = false; // Require a refresh after partial writes or uncertain device state.
        } finally { this.tile.operationRunning = false; this.abort = null; this.render(); }
    }

    /** Search only public presentation labels, never hidden credentials or URL references. */
    filtered() {
        const query = this.find('search').value.trim().toLocaleLowerCase();
        const filter = this.find('filter').value;
        return this.result.collections.filter(collection =>
            (filter === 'all' || (filter === 'system' ? collection.type === 'audio_feedback' : collection.type !== 'audio_feedback')) &&
            (!query || collection.title.toLocaleLowerCase().includes(query) || collection.tracks.some(track => track.title.toLocaleLowerCase().includes(query))));
    }
    page(kind, direction) {
        if (this.saving) return;
        this[`${kind}Page`] += direction;
        if (kind === 'collection') this.renderCollections(); else this.renderTracks();
    }

    /** Bound DOM rows rather than constructing thousands of hidden track controls. */
    paginate(items, kind, prefix) {
        const pages = Math.max(1, Math.ceil(items.length / Tb2ContentBrowser.PAGE_SIZE));
        const page = Math.max(0, Math.min(pages - 1, this[`${kind}Page`]));
        this[`${kind}Page`] = page;
        this.find(`${prefix}-page`).textContent = `${page + 1} / ${pages}`;
        this.find(`${prefix}-prev`).disabled = page === 0;
        this.find(`${prefix}-next`).disabled = page === pages - 1;
        return items.slice(page * Tb2ContentBrowser.PAGE_SIZE, (page + 1) * Tb2ContentBrowser.PAGE_SIZE);
    }
    row(title, subtitle, selected, action) {
        const button = document.createElement('button'); button.type = 'button';
        button.className = 'tb2-browser-row'; button.setAttribute('aria-pressed', String(selected));
        const label = document.createElement('span'); label.textContent = title;
        const note = document.createElement('small'); note.textContent = subtitle;
        button.append(label, note);
        button.addEventListener('click', event => { event.stopPropagation(); if (!this.saving) action(); });
        return button;
    }
    renderCollections() {
        const list = this.find('collections'); list.replaceChildren();
        const items = this.filtered();
        for (const collection of this.paginate(items, 'collection', 'collections')) {
            list.appendChild(this.row(collection.title, collection.issue || `${collection.tracks.length} audio tracks`, this.collection === collection, () => {
                this.stop(); this.collection = collection; this.track = null; this.trackPage = 0;
                this.renderCollections(); this.renderTracks(); this.renderControls();
            }));
        }
        if (!items.length) list.textContent = 'No collections in this view.';
    }
    renderTracks() {
        const list = this.find('tracks'); list.replaceChildren();
        this.find('collection-title').textContent = this.collection?.title || 'Select a collection';
        for (const track of this.paginate(this.collection?.tracks || [], 'track', 'tracks')) {
            list.appendChild(this.row(track.title, track.issue || track.warning || 'Local audio', this.track === track, () => {
                this.stop(); this.track = track; this.renderTracks(); this.renderControls();
            }));
        }
        // Technical details are allowlisted summaries, not a raw collection JSON viewer.
        const details = [];
        if (this.collection) details.push(`Collection type: ${this.collection.type}`, ...this.collection.details);
        if (this.track) details.push(`Stored position: ${this.track.position}`, `Actual size: ${this.track.file?.size ?? 'unavailable'} bytes`,
            `Declared size: ${this.track.declaredSize ?? 'not specified'}`, this.track.issue || this.track.warning);
        this.find('details').textContent = details.filter(Boolean).join('\n') || 'No selection.';
        this.find('track-title').textContent = this.track?.title || 'Select a track';
    }
    renderControls() {
        this.find('select').disabled = this.saving || this.picking || !this.supported();
        this.find('image').disabled = this.saving || !window.DEV_MODE || this.picking;
        this.find('refresh').disabled = this.saving || (!this.root && !this.imageFile) || !!this.abort || this.picking;
        this.find('cancel').disabled = !this.abort;
        const blocked = this.saving || !this.track?.file || !!this.track?.issue || !!this.abort || this.opening;
        this.find('play').disabled = blocked; this.find('export').disabled = blocked;
        this.find('add').disabled = this.saving || !!this.abort || this.picking || !this.root || !!this.imageFile || !this.result.complete;
        this.find('delete').disabled = this.find('add').disabled || !this.collection?.sourceName ||
            !this.result.metadata?.some(record => record.name === this.collection.sourceName && record.document.contentType === 'content_tonie' &&
                record.document.tonieType === 'content' && record.document.content.every(entry => entry.type === 'audio'));
        this.find('catalog').disabled = this.saving || !!this.catalog.pending;
        this.find('catalog').textContent = this.catalog.loaded ? 'Update catalog' : 'Load catalog';
        for (const name of ['search', 'filter']) this.find(name).disabled = this.saving;
        for (const name of ['collections', 'tracks']) this.find(name).inert = this.saving;
        this.renderBehavior();
        // Inert preserves row/pagination state so reconnecting does not leave stale disabled controls.
        this.element.firstElementChild.inert = !this.usbAllowed();
    }

    /** Reset an unsaved draft on collection changes, but preserve it during ordinary UI updates. */
    renderBehavior() {
        const record = this.collection?.editing, select = this.find('behavior');
        if (this.resumeCollection !== this.collection) {
            this.resumeCollection = this.collection; select.value = record?.value || '';
        }
        const reason = !this.collection ? 'Select a collection.' : !record ? 'Playback behavior is unavailable for this collection.' : record.issue ||
            (this.imageFile ? 'SD images are read-only.' : record.readOnly ? 'This source is read-only.' : '');
        select.disabled = this.saving || !!this.abort || !!reason || !this.result.complete;
        this.find('save').disabled = select.disabled || this.picking || !Tb2CollectionSupport.Tb2CollectionEditing.VALUES.has(select.value) || select.value === record?.value;
        this.find('behavior-status').textContent = reason;
        this.find('behavior-status').hidden = !reason;
    }
    render() {
        this.renderCollections(); this.renderTracks(); this.renderControls();
        if (this.usbAllowed() && !this.supported() && !this.imageFile) this.message('Folder access requires Chrome or Edge over HTTPS or localhost.');
    }

    /** Stop all media work and revoke temporary URLs on selection or navigation changes. */
    stop() {
        ++this.mediaGeneration; this.opening = false;
        this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load();
        if (this.audioUrl) URL.revokeObjectURL(this.audioUrl);
        this.audioUrl = null;
        for (const [url, timer] of this.downloadUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
        this.downloadUrls.clear();
    }
    dispose() {
        this.disposed = true; ++this.catalog.generation; this.catalog.abort?.abort(); this.catalog.index.clear();
        this.abort?.abort(); ++this.scanGeneration; this.abort = null;
        this.stop(); this.root = null; this.imageFile = null; this.find('image-file').value = '';
        this.result = { collections: [], files: 0, complete: false };
        this.collection = this.track = null;
    }

    /** File snapshots are opened afresh; late results cannot resume playback after navigation. */
    async play() {
        if (!this.usbAllowed() || !this.track || this.opening || this.abort) return;
        this.stop(); const generation = this.mediaGeneration;
        this.opening = true; this.renderControls(); this.message('Opening local audio…');
        try {
            const file = await Tb2ContentReader.open(this.track);
            if (generation !== this.mediaGeneration) return;
            this.audioUrl = URL.createObjectURL(file.slice(0, file.size, 'audio/ogg; codecs=opus'));
            this.audio.src = this.audioUrl;
            await this.audio.play();
        } catch (error) {
            if (generation === this.mediaGeneration) { this.stop(); this.message(error instanceof Error && !error.name.startsWith('NotSupported') ? error.message : 'Audio could not be decoded.'); }
        } finally {
            if (generation === this.mediaGeneration) { this.opening = false; this.renderControls(); }
            else this.renderControls();
        }
    }

    /** Original bytes are downloaded, never transcoded or written into the selected source. */
    async exportTrack() {
        if (!this.usbAllowed() || !this.track || this.opening || this.abort) return;
        const generation = this.mediaGeneration; const track = this.track;
        this.opening = true; this.renderControls();
        try {
            const file = await Tb2ContentReader.open(track);
            if (generation !== this.mediaGeneration) return;
            const url = URL.createObjectURL(file);
            const link = document.createElement('a'); link.href = url;
            link.download = `${String(track.position).padStart(2, '0')}-${track.title.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 100)}.opus`;
            document.body.appendChild(link); link.click(); link.remove();
            // Allow the browser to acquire the download before releasing its backing URL.
            const timer = setTimeout(() => { URL.revokeObjectURL(url); this.downloadUrls.delete(url); }, 1000);
            this.downloadUrls.set(url, timer); this.message('Original audio download started. Source files are unchanged.');
        } catch (error) {
            if (generation === this.mediaGeneration) this.message(error.message);
        } finally {
            if (generation === this.mediaGeneration) { this.opening = false; this.renderControls(); }
        }
    }
}

if (typeof module !== 'undefined') module.exports = require('./content-reader.js');
