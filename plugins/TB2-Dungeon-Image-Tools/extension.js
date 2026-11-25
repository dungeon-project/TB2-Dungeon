/** Data-only descriptor; the core owns loading and lifecycle. */
CoreFlasherApp.extensions.describe({
  "id": "image-tools",
  "version": "1.0.5",
  "coreApi": 1,
  "role": "cards",
  "files": [
    "assets/core/firmware-0408.js",
    "assets/custom-image.js",
    "assets/cards/mitm/template.js",
    "assets/cards/mitm/minotaur/player.js",
    "assets/cards/mitm/minotaur-scene.js",
    "assets/cards/mitm/card.css",
    "assets/cards/mitm/controller.js",
    "assets/cards/mitm/card.js",
    "assets/cards/custom-images/template.js",
    "assets/cards/custom-images/controller.js",
    "assets/cards/custom-images/card.js",
    "assets/cards/diagnostic-image/template.js",
    "assets/cards/diagnostic-image/controller.js",
    "assets/cards/diagnostic-image/card.js",
    "assets/documentation.js"
  ],
  "resources": [
    "assets/cards/mitm/minotaur/run-right.webp",
    "assets/cards/mitm/minotaur/snort.webp",
    "assets/cards/mitm/minotaur/stop-turn-front.webp",
    "assets/cards/mitm/minotaur/turn-charge.webp",
    "assets/cards/mitm/minotaur/walk-right.webp"
  ],
  "cards": [
    {
      "id": "tile-mitm-setup",
      "retiredAssets": [
        "assets/cards/mitm/minotaur/walk-right.png",
        "assets/cards/mitm/minotaur/stop-turn-front.png",
        "assets/cards/mitm/minotaur/snort.png",
        "assets/cards/mitm/minotaur/turn-charge.png",
        "assets/cards/mitm/minotaur/run-right.png"
      ],
      "assets": [
        "assets/cards/mitm/minotaur/walk-right.webp",
        "assets/cards/mitm/minotaur/stop-turn-front.webp",
        "assets/cards/mitm/minotaur/snort.webp",
        "assets/cards/mitm/minotaur/turn-charge.webp",
        "assets/cards/mitm/minotaur/run-right.webp"
      ],
      "files": [
        "assets/cards/mitm/template.js",
        "assets/cards/mitm/minotaur/player.js",
        "assets/cards/mitm/minotaur-scene.js",
        "assets/cards/mitm/card.css",
        "assets/cards/mitm/controller.js",
        "assets/cards/mitm/card.js"
      ]
    },
    {
      "id": "tile-custom-image",
      "files": [
        "assets/cards/custom-images/template.js",
        "assets/cards/custom-images/controller.js",
        "assets/cards/custom-images/card.js"
      ]
    },
    {
      "id": "tile-boot-image",
      "files": [
        "assets/cards/diagnostic-image/template.js",
        "assets/cards/diagnostic-image/controller.js",
        "assets/cards/diagnostic-image/card.js"
      ]
    }
  ]
}, document.currentScript.src);
