/* SD Content Backup controller. Shared services are supplied by the card context. */
(() => {
class CardController extends Tile {
    init() {
        this.box = null;this.backup = null;this.operationRunning = false;this.picking = false;
        this.status = this.element.querySelector('.js-content-status');
        this.progress = this.element.querySelector('.js-content-progress');
        this.action = this.element.querySelector('.js-content-action');
        this.cleanup = this.element.querySelector('.js-content-cleanup');
        this.action.addEventListener('change', () => {this.cleanup.checked = false;this.update();});
        for (const role of ['box','backup']) this.element.querySelector('.js-content-' + role).addEventListener('click', event => {
            event.stopPropagation();this.pick(role);
        });
        this.element.querySelector('.js-content-start').addEventListener('click', event => {event.stopPropagation();this.run();});
        this.element.querySelector('.js-content-cancel').addEventListener('click', event => {event.stopPropagation();this.abort?.abort();});
        this.update();
    }
    usbAllowed() { return this.context.usbPresence.allowed(); }
    onUsbLost() {
        this.usbLost = true; this.pickGeneration = (this.pickGeneration || 0) + 1;
        this.abort?.abort();
        const review = this.element.querySelector('.js-content-review');
        if (review.open) { review.returnValue = 'cancel'; review.close(); }
    }
    supported() { return this.usbAllowed() && !!window.isSecureContext && typeof window.showDirectoryPicker === 'function' && typeof ContentBackup !== 'undefined'; }
    update() {
        const busy = this.operationRunning || this.picking || (typeof ContentBackup !== 'undefined' && ContentBackup.running);
        for (const role of ['box','backup']) this.element.querySelector('.js-content-' + role).disabled = busy || !this.supported();
        this.action.disabled = busy || !this.supported();
        this.cleanup.disabled = busy || !this.supported();
        const restoring = this.action.value === 'restore';
        this.element.querySelector('.js-content-start').textContent = restoring ? 'Restore to box' : this.backupExists ? 'Update backup' : 'Create backup';
        this.element.querySelector('.js-content-cleanup-title').textContent = restoring ? 'Delete files on the box that are not in the backup' : 'Delete backup files that no longer exist in the source';
        this.element.querySelector('.js-content-cleanup-hint').textContent = restoring ? 'Removes entries from the selected box folder that are not in the backup.' : 'Applies only to backup content; review deletions before starting.';
        this.element.querySelector('.js-content-start').disabled = busy || !this.box || !this.backup || !this.supported();
        this.element.querySelector('.js-content-cancel').disabled = !this.operationRunning;
        if (!this.usbAllowed()) this.status.textContent = 'TB2 USB interface unavailable. Check TB2 USB tools in Interface.';
        else if (!this.supported()) this.status.textContent = 'File access unavailable. Open the complete website in Chrome or Edge over a secure connection.';
    }
    async pick(role) {
        if (this.operationRunning || this.picking || !this.supported()) return;
        const generation = this.pickGeneration || 0;
        this.picking = true;this.update();
        try {
            const handle = await window.showDirectoryPicker({id:'core-content-' + role, mode:'read'});
            if (!this.usbAllowed() || generation !== (this.pickGeneration || 0)) return;
            const other = role === 'box' ? this.backup : this.box;
            if (other) await ContentBackup.disjoint(handle, other);
            if (role === 'backup') this.backupExists = !!await ContentBackup.load(handle);
            if (!this.usbAllowed() || generation !== (this.pickGeneration || 0)) return;
            this[role] = handle;
            this.cleanup.checked = false;
            this.element.querySelector('.js-content-' + role + '-name').textContent = handle.name;
            this.status.textContent = this.box && this.backup ? 'Ready. Select an action and start.' : 'Select the second folder.';
        } catch (error) {
            this.status.textContent = error.name === 'AbortError' ? 'Folder selection cancelled.' : `Folder selection failed: ${error.message}`;
        } finally { this.picking = false;this.update(); }
    }
    /** Present every deletion candidate in a modal; cancellation never starts target writes. */
    confirmAction(preview) {
        const dialog = this.element.querySelector('.js-content-review');
        const removals = preview.removals || [];
        const files = removals.filter(entry => entry.type === 'file').length;
        this.element.querySelector('.js-content-review-summary').textContent = preview.operation === 'restore'
            ? `Full Restore to “${this.box.name}”\n${preview.created} files to create · ${preview.overwritten} to overwrite\n${(preview.bytes / 1024 / 1024).toFixed(1)} MiB to restore\nDelete ${files} additional files and ${removals.length - files} folders.`
            : `Update backup “${this.backup.name}” and, after successful verification, delete ${files} files and ${removals.length - files} folders from its content folder.`;
        this.element.querySelector('.js-content-review-files').textContent = removals.length ? 'To delete:\n' + removals.map(entry => entry.path + (entry.type === 'directory' ? '/' : '')).join('\n') : 'No additional files will be deleted.';
        if (!this.usbAllowed() || this.abort?.signal.aborted) return Promise.resolve(false);
        dialog.returnValue = 'cancel';
        return new Promise(resolve => {
            dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm'), {once:true});
            dialog.showModal();
        });
    }
    async run() {
        if (this.operationRunning || this.picking || !this.box || !this.backup || !this.supported()) return;
        this.usbLost = false; this.operationRunning = true;this.abort = new AbortController();this.progress.value = 0;this.update();
        this.status.textContent = 'Checking permissions and folders…';
        try {
            const mode = this.action.value === 'restore' ? 'restore' : await ContentBackup.load(this.backup) ? 'incremental' : 'full';
            const result = await ContentBackup.run(mode, this.box, this.backup, {
                signal:this.abort.signal,
                removeExtras:this.cleanup.checked,
                progress:info => {
                    this.status.textContent = `${info.phase}${info.path ? ': ' + info.path : ''}`;
                    if (info.total) this.progress.value = (info.index + (info.totalBytes ? info.bytes / info.totalBytes : 0)) / info.total;
                    else this.progress.removeAttribute('value');
                },
                confirm:preview => this.confirmAction(preview)
            });
            this.abort.signal.throwIfAborted();
            this.backupExists = !!await ContentBackup.load(this.backup);
            this.progress.value = result.cancelled ? 0 : 1;
            this.status.textContent = result.cancelled ? 'Operation cancelled. No files written or deleted.' : `Completed and verified · ${result.copied} files copied · ${result.skipped} unchanged · ${result.removed || 0} entries deleted.`;
        } catch (error) {
            this.progress.value = 0;
            this.status.textContent = this.abort.signal.aborted ? 'Cancelled. Completed copies remain; complete the backup before restoring.' : `Stopped: ${error.message}`;
        } finally {
            const resultMessage = this.status.textContent;
            this.operationRunning = false;this.abort = null;this.cleanup.checked = false;this.update();
            if (this.usbLost) this.context.usbPresence.report(`SD Content Backup: ${resultMessage}`);
        }
    }
}
CoreFlasherApp.cardControllers["tile-content-backup"] = CardController;
})();
