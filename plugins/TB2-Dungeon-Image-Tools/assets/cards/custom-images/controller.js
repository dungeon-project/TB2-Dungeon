/* Build Update Image controller. Shared services are supplied by the card context. */
(() => {
class CardController extends Tile {
    init() { this.custom = new CustomImageController(this); }
    focus() { super.focus(); this.custom?.update(); }
    update() { this.custom?.update(); }
}
CoreFlasherApp.cardControllers["tile-custom-image"] = CardController;
})();
