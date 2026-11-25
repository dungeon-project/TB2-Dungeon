/* Card definition: one source for navigation, help and presentation. */
CoreFlasherApp.registry.register({
    id: "tile-boot-image",
    title: "Diagnostic Image (Production)",
    shortTitle: "Diagnostic Image",
    category: "edit",
    shortcut: "p",
    placement: {"layer": "images", "x": 0, "y": 1},
    legacyCoordinates: {"x": 2, "y": -1},
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
