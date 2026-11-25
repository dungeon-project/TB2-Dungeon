/* Card definition: one source for navigation, help and presentation. */
CoreFlasherApp.registry.register({
    id: "tile-interface",
    title: "Interface",
    shortTitle: "Interface",
    category: "info",
    shortcut: "i",
    placement: {"layer": "entry", "x": 0, "y": 0},
    legacyCoordinates: {"x": -1, "y": 0},
    visibility: "all",
    dependencies: ["image", "filesystem", "hardware", "operations", "uuid", "navigation", "settings", "dialogs", "usbPresence"],
    createView() {
        const template = document.createElement("template");
        template.innerHTML = CoreFlasherApp.cardTemplates[this.id];
        return template.content.firstElementChild;
    },
    createController(context, element) {
        return new CoreFlasherApp.cardControllers[this.id](element, context);
    }
});
