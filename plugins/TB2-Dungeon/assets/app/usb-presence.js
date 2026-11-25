/** Passive TB2 USB presence. No device selection, opening, commands or persistent grants. */
class Tb2UsbPresence {
    static DEVICE = Object.freeze({usbVendorId: 0x2FE3, usbProductId: 0x0100});
    static RECHECK_MS = 3000;
    constructor({serial, secureContext, onChange, host = globalThis.window, document = globalThis.document}) {
        Object.assign(this, {serial, secureContext, onChange, host, document});
        this.running = false; this.generation = 0;
        this.state = Object.freeze({status: 'idle', present: false, ports: [], count: 0});
        this.onConnect = () => {
            void this.refresh();
        };
        this.onDisconnect = event => {
            const port = event.port || event.target;
            if (!this.matches(port)) return;
            this.generation++;
            // A second TB2 keeps the tools visible; foreign disconnects do not affect them.
            this.publish('not-visible', this.state.ports.filter(item => item !== port && item.connected === true));
            void this.refresh();
        };
        this.onVisible = () => { if (this.document?.visibilityState !== 'hidden') void this.refresh(); };
        this.onShow = () => { void this.start(); };
        this.onHide = () => this.stop();
    }
    matches(port) {
        if (!port?.getInfo) return false;
        const info = port.getInfo();
        return info.usbVendorId === Tb2UsbPresence.DEVICE.usbVendorId && info.usbProductId === Tb2UsbPresence.DEVICE.usbProductId;
    }
    allowed() { return globalThis.window?.DEV_MODE === true || this.state.present; }
    /** Publish changes only; periodic checks must not disturb navigation or focus. */
    publish(status, ports = []) {
        if (ports.length) status = 'present';
        if (status === this.state.status && ports.length === this.state.ports.length &&
            ports.every((port, index) => port === this.state.ports[index])) return this.state;
        const previous = this.state;
        this.state = Object.freeze({status, present: !!ports.length, ports: Object.freeze(ports), count: ports.length});
        this.onChange(this.state, previous);
        return this.state;
    }
    async refresh() {
        if (!this.running || !this.secureContext || !this.serial?.getPorts) return this.state;
        const generation = ++this.generation;
        try {
            const granted = await this.serial.getPorts();
            if (!this.running || generation !== this.generation) return this.state;
            const matching = granted.filter(port => this.matches(port));
            const ports = matching.filter(port => port.connected === true);
            return this.publish(matching.some(port => typeof port.connected !== 'boolean') ? 'outdated' : 'not-visible', ports);
        } catch {
            if (this.running && generation === this.generation) this.publish('error');
            return this.state;
        }
    }
    async start() {
        if (this.running) return this.refresh();
        this.running = true;
        if (!this.secureContext) return this.publish('insecure');
        if (!this.serial?.getPorts) return this.publish('unsupported');
        this.serial.addEventListener('connect', this.onConnect);
        this.serial.addEventListener('disconnect', this.onDisconnect);
        this.host?.addEventListener('focus', this.onVisible);
        this.document?.addEventListener('visibilitychange', this.onVisible);
        this.timer = this.host?.setInterval(this.onVisible, Tb2UsbPresence.RECHECK_MS);
        return this.refresh();
    }
    bindLifecycle() {
        this.host?.addEventListener('pageshow', this.onShow);
        this.host?.addEventListener('pagehide', this.onHide);
        return this.start();
    }
    stop() {
        this.running = false; this.generation++;
        this.serial?.removeEventListener('connect', this.onConnect);
        this.serial?.removeEventListener('disconnect', this.onDisconnect);
        this.host?.removeEventListener('focus', this.onVisible);
        this.document?.removeEventListener('visibilitychange', this.onVisible);
        this.host?.clearInterval(this.timer); this.timer = null;
        this.publish('stopped');
    }
    dispose() {
        this.stop();
        this.host?.removeEventListener('pageshow', this.onShow);
        this.host?.removeEventListener('pagehide', this.onHide);
    }
    static policy(origin) {
        const url = new URL(origin);
        if (url.username || url.password || (url.protocol !== 'https:' &&
            !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname)))) {
            throw new Error('Open this page over HTTPS or localhost to generate its policy.');
        }
        return JSON.stringify([{devices:[{vendor_id: this.DEVICE.usbVendorId, product_id: this.DEVICE.usbProductId}], urls:[url.origin]}], null, 2);
    }
}
if (typeof module !== 'undefined') module.exports = {Tb2UsbPresence};
