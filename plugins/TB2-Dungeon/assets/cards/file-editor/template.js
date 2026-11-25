/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-file-editor"] = `<section class="tile dev-only tile-disabled pos-2-0" data-x="2" data-y="0"
                data-tile-class="FileEditorTile" data-dev-view="true" id="tile-file-editor" data-layer="workspace" data-nav-x="-1" data-nav-y="1">
                <div class="p-10 h-full flex flex-col">
                    <div class="flex justify-between items-start mb-3">
                        <div class="min-w-0">
                            <h2 class="text-4xl font-display font-black text-white tracking-tighter">File Editor</h2><button class="js-enable-edit cf-dump-button" type="button">Enable Read / Write</button>
                            <p class="js-file-editor-path mt-2 font-mono text-[11px] text-zinc-500 truncate">
                                NO_FILE_SELECTED
                            </p>
                        </div>
                        <span class="js-file-editor-kind text-[10px] font-mono bg-zinc-800 px-3 py-1 text-zinc-400">
                            TEXT
                        </span>
                    </div>

                    <div class="js-file-editor-crypt-panel hidden mb-3 border border-amber-500/30 bg-amber-500/5 p-3">
                        <div class="flex items-center justify-between gap-4">
                            <div>
                                <p class="font-mono text-[10px] uppercase tracking-wider text-amber-300">
                                    Encrypted .crypt
                                </p>
                                <p class="mt-1 font-mono text-[10px] text-zinc-500">
                                    Decrypt with the detected microcontroller UUID before editing.
                                </p>
                            </div>
                            <button
                                class="js-file-editor-decrypt px-4 py-2 border border-amber-500/40 text-amber-300 font-mono text-[10px] uppercase tracking-wider hover:border-amber-300 disabled:opacity-30"
                                type="button">Decrypt with UUID</button>
                        </div>
                    </div>

                    <textarea
                        class="js-file-editor-text flex-1 min-h-0 resize-none bg-zinc-950 border border-zinc-800 p-4 font-mono text-[12px] leading-relaxed text-zinc-200 outline-none focus:border-primary terminal-scroll"
                        spellcheck="false" disabled></textarea>

                    <div class="mt-3 flex items-center gap-3">
                        <button
                            class="js-file-editor-reload px-5 py-3 border border-zinc-700 text-zinc-300 hover:text-white hover:border-primary font-mono text-[10px] uppercase tracking-wider disabled:opacity-30"
                            type="button" disabled>Reload</button>
                        <button
                            class="js-file-editor-save px-5 py-3 border border-secondary/50 bg-secondary/10 text-secondary hover:border-secondary font-mono text-[10px] uppercase tracking-wider disabled:opacity-30"
                            type="button" disabled>Apply to working image</button>
                        <span class="js-file-editor-dirty hidden font-mono text-[10px] text-amber-300">
                            Draft — not applied
                        </span>
                    </div>

                    <div class="js-file-editor-error error-box hidden mt-3"></div>
                    <p class="js-file-editor-status mt-3 font-mono text-[10px] text-zinc-500">
                        Select a text or .crypt file in File Manager
                    </p>
                </div>


            </section>`;
