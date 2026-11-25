/* WiFi Manager controller. Shared services are supplied by the card context. */
(() => {
class CardController extends Tile {
    hasDraft() { return !!this.wifi?.draft?.changed; }
    /** Keep the existing coordinator responsible for focus and availability. */
    init() {
        this.element.querySelector('.js-enable-edit').addEventListener('click', () => this.context.image.setEditMode('rw-buffered')); this.wifi = new WifiManagerController(this); }
    update() { this.wifi?.update(); }
    focus() { super.focus(); this.wifi.update(); }
    blur() { super.blur(); this.wifi.hidePasswords(); }
}
CoreFlasherApp.cardControllers["tile-wifi-manager"] = CardController;
})();
