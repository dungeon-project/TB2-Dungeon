/** Data-only descriptor; the core owns loading and lifecycle. */
CoreFlasherApp.extensions.describe({
  "id": "uuid-scanner",
  "version": "1.0.3",
  "coreApi": 1,
  "role": "cards",
  "files": [
    "assets/uuid-search-config.js",
    "assets/cards/detect-uuid/template.js",
    "assets/cards/detect-uuid/card.css",
    "assets/cards/detect-uuid/search-runtime.js",
    "assets/cards/detect-uuid/search-plan.js",
    "assets/cards/detect-uuid/optimized-shader.js",
    "assets/cards/detect-uuid/optimized-v2-shader.js",
    "assets/cards/detect-uuid/optimized-v3-shader.js",
    "assets/cards/detect-uuid/search-tuner.js",
    "assets/cards/detect-uuid/controller.js",
    "assets/cards/detect-uuid/card.js",
    "assets/documentation.js"
  ],
  "resources": [],
  "cards": [
    {
      "id": "tile-cracker-pane",
      "files": [
        "assets/cards/detect-uuid/template.js",
        "assets/cards/detect-uuid/card.css",
        "assets/cards/detect-uuid/search-runtime.js",
        "assets/cards/detect-uuid/search-plan.js",
        "assets/cards/detect-uuid/optimized-shader.js",
        "assets/cards/detect-uuid/optimized-v2-shader.js",
        "assets/cards/detect-uuid/optimized-v3-shader.js",
        "assets/cards/detect-uuid/search-tuner.js",
        "assets/cards/detect-uuid/controller.js",
        "assets/cards/detect-uuid/card.js"
      ]
    }
  ]
}, document.currentScript.src);
