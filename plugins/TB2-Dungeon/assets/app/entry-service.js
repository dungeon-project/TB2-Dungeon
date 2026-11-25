/** Read-only readiness contract for the future Overworld entrance. Never grants writes. */
class DungeonEntryService {
    constructor(context) { this.context = context; this.last = ''; }

    /** Successful publication or a verified flash connection, never merely a selected port. */
    getState() {
        const image = this.context.image.current;
        const hardware = window.AppState.hardwareController;
        const imageReady = !!(image?.completeSnapshot && image.size === FirmwareImage.SIZE);
        const hardwareReady = !!(hardware?.ready && hardware.detectedId && !hardware.fault &&
            (hardware.device || hardware.port));
        return Object.freeze({ready: imageReady || hardwareReady, imageReady, hardwareReady});
    }
    openInterface() { return this.context.navigation.moveToCard('tile-interface'); }
    subscribe(listener) { return this.context.subscribe('entry-readiness', listener); }

    /** Call from existing state notifications; there is no independent polling/session flag. */
    refresh() {
        const state = this.getState(), signature = JSON.stringify(state);
        if (signature === this.last) return;
        this.last = signature;
        this.context.emit('entry-readiness', state);
    }
}
