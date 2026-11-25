/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-settings-editor"] = `<section class="tile tile-disabled pos-1--1" data-x="1" data-y="-1" data-tile-class="SettingsEditorTile"
                id="tile-settings-editor" data-layer="settings" data-nav-x="1" data-nav-y="0">
                <div class="p-10 h-full flex flex-col">
                    <div class="flex justify-between items-start mb-3">
                        <h2 class="text-4xl font-display font-black text-white tracking-tighter">Settings</h2><button class="js-enable-edit cf-dump-button" type="button">Enable Read / Write</button>
                        <span class="text-[10px] font-mono bg-zinc-800 px-3 py-1 text-zinc-400 dev-only">MODULE_0x04</span>
                    </div>
                    <p class="text-[11px] font-mono text-zinc-400 mb-3">
                        Opens /settings automatically from the working image.
                    </p>
                    <p class="settings-help">Apply to working image applies your edits to the working image. Reload discards unsaved edits.</p>
                    <label class="settings-help">Operating mode
                        <select class="js-settings-lifecycle cf-dump-button" disabled aria-label="Operating mode"></select>
                    </label>
                    <p class="settings-help js-settings-lifecycle-status">Unknown</p>
                    <div class="settings-grid js-settings-grid"></div>
                    <div class="flex items-center gap-3 mt-3">
                        <button class="js-settings-add-btn px-5 py-3 border border-zinc-700
                            text-zinc-300 hover:text-white font-mono text-xs uppercase"
                            disabled type="button">Add Row</button>
                        <button
                            class="js-settings-save-btn px-5 py-3 border border-zinc-700 text-zinc-300 hover:text-white hover:border-primary transition-colors font-mono text-xs uppercase tracking-widest disabled:opacity-40"
                            disabled type="button">Apply to working image</button>
                        <button
                            class="js-settings-reload-btn px-5 py-3 border border-zinc-700 text-zinc-300 hover:text-white hover:border-primary transition-colors font-mono text-xs uppercase tracking-widest disabled:opacity-40"
                            disabled type="button">Reload</button>
                    </div>
                    <div class="error-box js-settings-error dev-only hidden mt-3"></div>
                    <p class="font-mono text-xs tracking-widest text-zinc-500 js-settings-status mt-2">Load an image to edit its settings.</p>
                </div>

            </section>`;
