/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-file-manager"] = `<section class="tile tile-disabled pos-1-0" data-x="1" data-y="0" data-tile-class="ReplaceFileTile"
                id="tile-file-manager" data-layer="workspace" data-nav-x="-1" data-nav-y="0">
                <div class="p-12 h-full flex flex-col">
                    <div class="flex justify-between items-start">
                        <h2 class="text-5xl font-display font-black text-white tracking-tighter">File Manager</h2>
                        <span class="text-[10px] font-mono bg-zinc-800 px-3 py-1 text-zinc-400 dev-only">MODULE_0x02</span>
                    </div>
                    <div class="flex-1 flex flex-col gap-4">
                        <div class="file-tree js-replace-file-tree"></div>
                        <div class="flex flex-wrap items-center gap-3">
                            <select class="js-file-export-mode cf-dump-button" aria-label="File export format" hidden>
                                <option value="original">Original encrypted file</option><option value="decrypted">Decrypted file</option>
                            </select>
                            <button
                                class="js-replace-save-btn px-5 py-3 border border-zinc-700 text-zinc-300 hover:text-white hover:border-primary transition-colors font-mono text-xs uppercase tracking-widest disabled:opacity-40"
                                disabled type="button">Download file</button>
                            <button
                                class="js-replace-replace-btn px-5 py-3 border border-zinc-700 text-zinc-300 hover:text-white hover:border-primary transition-colors font-mono text-xs uppercase tracking-widest disabled:opacity-40"
                                disabled type="button">Replace file…</button>
                            <input class="hidden js-replace-input" type="file" />
                        </div>
                        <p class="js-uuid-guidance font-mono text-xs" hidden>
                            <span></span> <button class="cf-dump-button js-detect-uuid" type="button">Go to Detect UUID</button>
                        </p>
                        <div class="error-box js-replace-error dev-only hidden"></div>
                        <p class="font-mono text-xs tracking-widest text-zinc-500 js-replace-status">
                            Load an image or connect a reader to browse files</p>
                    </div>
                </div>

            </section>`;
