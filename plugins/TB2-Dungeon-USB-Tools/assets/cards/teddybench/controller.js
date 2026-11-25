/* TeddyBench 2 Web (beta) controller. Shared services are supplied by the card context. */
(() => {
class CardController extends Tile {
    init() { this.contentBrowser = new Tb2ContentBrowser(this); }
    onUsbLost() { this.contentBrowser.usbDisconnected(); }
    get picking() { return !!this.contentBrowser?.picking; }
    dispose() {
        this.contentBrowser?.dispose();
        super.dispose();
    }
    update() { this.contentBrowser.renderControls(); }
    blur() {
        if (this.isFocused) { this.contentBrowser.stop(); this.contentBrowser.renderControls(); }
        super.blur();
    }
}
CoreFlasherApp.cardControllers["tile-content-browser"] = CardController;
})();
