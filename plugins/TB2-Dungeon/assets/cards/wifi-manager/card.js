/* Card definition: one source for navigation, help and presentation. */
CoreFlasherApp.registry.register({
    id: "tile-wifi-manager",
    title: "WiFi Manager",
    shortTitle: "WiFi",
    category: "edit",
    shortcut: "w",
    placement: {"layer": "settings", "x": -1, "y": 0},
    legacyCoordinates: {"x": 2, "y": 2},
    visibility: "all",
    dependencies: ["image", "filesystem", "hardware", "operations", "uuid", "navigation", "settings", "dialogs"],
    createView() {
        const template = document.createElement("template");
        template.innerHTML = CoreFlasherApp.cardTemplates[this.id];
        return template.content.firstElementChild;
    },
    createController(context, element) {
        return new CoreFlasherApp.cardControllers[this.id](element, context);
    }
});
