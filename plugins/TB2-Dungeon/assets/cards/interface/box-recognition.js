/** Session-bound hardware identification; archive metadata never grants flash privileges. */
class FlashBoxRecognition {
    constructor(hooks) {
        this.hooks = hooks;
        this.generation = 0;
        this.controller = null;
        this.chipId = null;
        this.state = { status: '', chipId: null, box: null };
    }
    /** Called by hardware notifications; duplicate packets do not repeat archive reads. */
    update(controller, force = false, applyUuid = true) {
        const chipId = controller?.ready && !controller.fault ? controller.flashChipId : null;
        const identityError = controller?.flashChipIdError || '';
        if (!force && controller === this.controller && chipId === this.chipId && identityError === this.identityError) return;
        this.identityError = identityError;
        this.controller = controller;
        this.chipId = chipId;
        const generation = ++this.generation;
        this.state = { chipId, box: null, status: chipId ? 'Looking up flash chip…' : controller?.flashChipIdError || '' };
        this.hooks.render(this.state);
        if (!chipId) return;
        const stamp = this.hooks.sourceStamp();
        this.pending = this.lookup(generation, chipId, stamp, applyUuid);
    }
    /** A source action wins over a late network reply, even if the UUID text stayed identical. */
    async lookup(generation, chipId, stamp, applyUuid) {
        const current = () => generation === this.generation;
        let storage;
        try {
            storage = this.hooks.storage();
            if (!storage) throw new Error('Connect through TeddyCloud to assign this flash chip.');
            const archive = new ImageArchive(storage);
            await archive.refresh();
            if (!current()) return;
            const identity = typeof module !== 'undefined' ? require('../../box-identity.js').BoxIdentity : window.BoxIdentity;
            const box = identity.resolve(archive.boxProfiles, {flashChipId:chipId});
            this.state = { chipId, box, status: box ? `Recognized box: ${box.name}` : 'Unassigned flash chip', assignable: true };
            if (box) {
                if (!box.uuid) this.state.status += ' · No MCU UUID saved for this box';
                const latest = this.hooks.sourceStamp();
                if (applyUuid && stamp.every((value, index) => value === latest[index]) && this.hooks.canApplyUuid()) {
                    let compatible = true;
                    try { await this.hooks.validateUuid?.(box.uuid || ''); }
                    catch (error) { compatible = false; this.state.status += ` · ${error.message}`; }
                    if (!current() || !stamp.every((value, index) => value === this.hooks.sourceStamp()[index])) return;
                    if (compatible) this.hooks.loadUuid(box.uuid || '');
                }
            }
            this.hooks.render(this.state);
            // A missing model picture must not hide an already verified identity.
            if (box && storage.boxes) {
                try {
                    const boxes = await storage.boxes();
                    if (!current()) return;
                    this.state.picture = boxes.find(item => item.id === (box.tcId || box.id))?.picture;
                    this.hooks.render(this.state);
                } catch { /* Model pictures are optional; the neutral local box remains visible. */ }
            }
        } catch (error) {
            if (!current()) return;
            this.state = { chipId, box: null, status: `Box recognition unavailable: ${error.message}`, assignable: !!storage };
            this.hooks.render(this.state);
        }
    }
    reset() { this.update(null, true); }
}
if (typeof module !== 'undefined') module.exports = { FlashBoxRecognition };
