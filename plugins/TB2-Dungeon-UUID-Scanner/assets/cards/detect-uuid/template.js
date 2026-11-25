/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-cracker-pane"] = `<section class="tile tile-disabled pos-1-1" data-x="1" data-y="1"
                data-tile-class="CrackerPaneTile" data-requires-source="scanner" id="tile-cracker-pane" data-layer="workspace" data-nav-x="1" data-nav-y="0">
                <div class="p-6 flex-1 flex flex-col overflow-hidden">
                    <div class="flex items-center justify-between mb-3">
                        <h2 class="text-4xl font-display font-black text-white tracking-tighter">Detect UUID</h2>
                        <span class="text-[10px] font-mono bg-zinc-800 px-3 py-1 text-zinc-400 dev-only">MODULE_0x03</span>
                    </div>
                    <div class="flex-1 flex flex-col gap-2 overflow-y-auto terminal-scroll">
                        <p id="uuid-ca-source" class="font-mono text-[11px] text-zinc-400" role="status" aria-live="polite">Load an image to read /cert/ca.der.crypt automatically.</p>
                        <details><summary class="settings-help">Advanced search options</summary>
                        <div class="ci-setting-row flex flex-wrap items-center gap-3">
                            <label class="text-zinc-400 font-mono text-xs w-28 flex-shrink-0" for="ci-mask">UUID mask</label>
                            <select id="ci-mask" class="flex-1 bg-zinc-900 border border-zinc-800 px-2 py-1 font-mono text-sm text-white outline-none focus:border-primary">
                                <option value="500100XXXXXXXXD7" selected>500100XXXXXXXXD7</option>
                                <option value="500100XXXXXXXXAA">500100XXXXXXXXAA</option>
                                <option value="500100XXXXXXXXXX">500100XXXXXXXXXX</option>
                            </select>
                        </div>
                        <div class="ci-setting-row flex flex-wrap items-center gap-3">
                            <label class="text-zinc-400 font-mono text-xs w-28 flex-shrink-0" for="ci-batchSize">Batch size</label>
                            <select id="ci-batchSize" class="flex-1 bg-zinc-900 border border-zinc-800 px-2 py-1 font-mono text-sm text-white outline-none">
                                <option value="4096">4K</option>
                                <option value="8192">8K</option>
                                <option value="16384">16K</option>
                                <option value="32768">32K</option>
                                <option value="65536">64K</option>
                                <option value="131072">128K</option>
                                <option value="262144">256K</option>
                                <option value="524288">512K</option>
                                <option value="1048576">1M</option>
                                <option value="2097152">2M</option>
                                <option value="4194304">4M</option>
                                <option value="8388608">8M</option>
                                <option value="16777216" selected>16M</option>
                                <option value="33554432">32M</option>
                                <option value="67108864">64M</option>
                                <option value="auto">Auto</option>
                            </select>
                        </div>
                        <div class="ci-setting-row ci-algorithm-row flex flex-wrap items-center gap-3">
                            <label class="text-zinc-400 font-mono text-xs w-28 flex-shrink-0" for="ci-algorithm">Search algorithm</label>
                            <select id="ci-algorithm" class="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 px-2 py-1 font-mono text-sm text-white outline-none">
                                <option value="legacy-v1">Legacy</option>
                                <option value="optimized-v1">Optimized v1</option>
                                <option value="optimized-v2">Optimized v2 (experimental)</option>
                                <option value="optimized-v3">Optimized v3 (experimental)</option>
                                <option value="auto">Auto</option>
                            </select>
                        </div>
                        <div class="ci-setting-row flex flex-wrap items-center gap-3">
                            <label class="text-zinc-400 font-mono text-xs w-28 flex-shrink-0" for="ci-workgroupSize">Threads per workgroup</label>
                            <select id="ci-workgroupSize" class="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 px-2 py-1 font-mono text-sm text-white outline-none">
                                <option value="64">64</option>
                                <option value="128">128</option>
                                <option value="256" selected>256</option>
                                <option value="auto">Auto</option>
                            </select>
                        </div>
                        </details>
                        <p id="ci-effectiveConfig" class="font-mono text-[11px] text-zinc-400" role="status" aria-live="polite">Manual settings</p>
                        <details class="ci-performance dev-only font-mono text-[11px] text-zinc-400">
                            <summary class="cursor-pointer">Performance details</summary>
                            <p id="ci-performanceDetails" class="whitespace-pre-wrap py-2"></p>
                        </details>
                        <div class="flex flex-wrap gap-2">
                            <button id="ci-recalibrateBtn" class="cf-dump-button" type="button">Recalibrate</button>
                            <button id="ci-resetTuningBtn" class="cf-dump-button" type="button">Reset tuning</button>
                        </div>
                        <div class="flex gap-2">
                            <button id="ci-startBtn" class="px-4 py-2 border border-zinc-700 text-zinc-300 font-mono text-xs uppercase tracking-widest hover:text-white hover:border-primary transition-colors disabled:opacity-40" disabled type="button">Start</button>
                            <button id="ci-pauseBtn" class="px-4 py-2 border border-zinc-700 text-zinc-300 font-mono text-xs uppercase tracking-widest hover:text-white hover:border-primary transition-colors disabled:opacity-40" disabled type="button">Pause</button>
                            <button id="ci-resetBtn" class="cf-dump-button" type="button">Reset scan</button>
                        </div>
                        <p id="ci-search-stage" class="font-mono text-[11px] text-zinc-400" role="status" aria-live="polite">Search expands automatically: D7, then AA, then the remaining full range.</p>
                        <div class="ci-meter"><div id="ci-progressBar"></div></div>
                        <span id="ci-state" class="hidden">idle</span>
                        <div class="ci-kv">
                            <div class="font-mono text-xs text-zinc-300">Candidates/s<br><span id="ci-rate">0</span></div>
                            <div class="font-mono text-xs text-zinc-300">Current UUID<br><span id="ci-current" class="font-mono">-</span></div>
                            <div class="font-mono text-xs text-zinc-300">ETA<br><span id="ci-eta">-</span></div>
                        </div>
                        <div class="found-card" id="ci-foundCard">
                            <p class="found-title">Microcontroller UUID</p>
                            <div class="flex flex-wrap items-center gap-3">
                                <input id="ci-foundUuid" class="found-uuid flex-1 min-w-0" type="text" value="" maxlength="16" placeholder="" spellcheck="false" autocomplete="off">
                                <button id="ci-saveUuidBtn"
                                    class="px-4 py-2 border border-secondary/60 bg-secondary/10 text-secondary font-mono text-[10px] uppercase tracking-wider hover:border-secondary disabled:opacity-30 disabled:cursor-not-allowed"
                                    type="button">Save UUID</button>
                                <button id="ci-loadUuidBtn" class="cf-dump-button" type="button">Load UUID</button>
                            </div>
                        </div>
                        <div id="ci-status" class="font-mono text-[11px] text-zinc-400 whitespace-pre-wrap max-h-32 overflow-y-auto terminal-scroll border border-zinc-900 bg-zinc-950 p-2"></div>
                    </div>
                </div>

            </section>`;
