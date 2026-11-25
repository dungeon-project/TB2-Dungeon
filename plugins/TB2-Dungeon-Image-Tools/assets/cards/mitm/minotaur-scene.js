/** Decorative MITM companion. It never owns or delays an image operation. */
(() => {
    const ASSET_BASE = new URL('minotaur/', document.currentScript.src).href;
    const DISPLAY_HEIGHT = Minotaur.defaults.height;

    class MinotaurScene {
        constructor() {
            this.generation = 0;
            this.canvas = null;
            this.player = null;
        }

        /** Lazy-load sprites for an explicit appearance; stale loads cannot reappear. */
        async start() {
            if (this.canvas || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
            const generation = ++this.generation;
            const canvas = document.createElement('canvas');
            canvas.className = 'mitm-minotaur-scene';
            canvas.setAttribute('aria-hidden', 'true');
            document.body.appendChild(canvas);
            this.canvas = canvas;

            try {
                const player = await Minotaur.mount(canvas, {
                    assetBase: ASSET_BASE, height: DISPLAY_HEIGHT,
                    onComplete: () => this.stop()
                });
                // Navigation/reset may have happened while the sprite files were loading.
                if (generation !== this.generation) {
                    player.destroy();
                    return;
                }
                this.player = player;
                player.play();
            } catch (error) {
                if (generation === this.generation) this.stop();
                console.warn('MITM companion unavailable; image preparation is unaffected.', error);
            }
        }

        /** Release canvas, animation frame and resize observer without touching the image. */
        stop() {
            this.generation++;
            this.player?.destroy();
            this.player = null;
            this.canvas?.remove();
            this.canvas = null;
        }
    }

    CoreFlasherApp.MinotaurScene = MinotaurScene;
    // Both triggers share one player; repeated shortcuts cannot stack appearances.
    CoreFlasherApp.minotaurScene = new MinotaurScene();
})();
