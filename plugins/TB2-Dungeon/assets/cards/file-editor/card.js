/* Card definition: one source for navigation, help and presentation. */
CoreFlasherApp.registry.register({
    id: "tile-file-editor",
    title: "File Editor",
    shortTitle: "Text Editor",
    category: "edit",
    shortcut: "e",
    placement: {"layer": "workspace", "x": -1, "y": 1},
    legacyCoordinates: {"x": 2, "y": 0},
    visibility: "dev",
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
