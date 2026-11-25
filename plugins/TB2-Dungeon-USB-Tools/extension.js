/** Data-only descriptor; the core owns loading and lifecycle. */
CoreFlasherApp.extensions.describe({
  "id": "usb-tools",
  "version": "1.0.2",
  "coreApi": 1,
  "role": "cards",
  "files": [
    "assets/content-backup.js",
    "assets/fat32-image.js",
    "assets/content-catalog.js",
    "assets/content-collection.js",
    "assets/audio-converter.js",
    "assets/content-figures.js",
    "assets/content-reader.js",
    "assets/content-browser.js",
    "assets/core/mcu-serial.js",
    "assets/cards/sd-content-backup/template.js",
    "assets/cards/sd-content-backup/controller.js",
    "assets/cards/sd-content-backup/card.js",
    "assets/cards/teddybench/card.css",
    "assets/cards/teddybench/template.js",
    "assets/cards/teddybench/controller.js",
    "assets/cards/teddybench/card.js",
    "assets/cards/uuid-alternative/template.js",
    "assets/cards/uuid-alternative/controller.js",
    "assets/cards/uuid-alternative/card.js",
    "assets/documentation.js"
  ],
  "resources": [
    "assets/audio-converter-worker.js"
  ],
  "cards": [
    {
      "id": "tile-content-backup",
      "files": [
        "assets/cards/sd-content-backup/template.js",
        "assets/cards/sd-content-backup/controller.js",
        "assets/cards/sd-content-backup/card.js"
      ]
    },
    {
      "id": "tile-content-browser",
      "files": [
        "assets/cards/teddybench/card.css",
        "assets/cards/teddybench/template.js",
        "assets/cards/teddybench/controller.js",
        "assets/cards/teddybench/card.js"
      ]
    },
    {
      "id": "tile-firmware-0408",
      "files": [
        "assets/cards/uuid-alternative/template.js",
        "assets/cards/uuid-alternative/controller.js",
        "assets/cards/uuid-alternative/card.js"
      ]
    }
  ]
}, document.currentScript.src);
