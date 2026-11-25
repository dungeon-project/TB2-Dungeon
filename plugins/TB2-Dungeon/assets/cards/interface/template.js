/* Static card markup. Control IDs remain compatible with existing integrations. */
CoreFlasherApp.cardTemplates["tile-interface"] = `<section class="tile tile-disabled pos--1-0" data-x="-1" data-y="0"
                data-tile-class="InterfaceTile" data-start-enabled="true" id="tile-interface" data-layer="entry" data-nav-x="0" data-nav-y="0">
                <div class="p-12 flex-1 flex flex-col justify-between">
                    <div>
                        <div class="flex items-center gap-4 mb-2">
                            <span
                                class="dev-only text-xs font-mono text-primary bg-primary/10 px-2 py-0.5 tracking-tighter">NODE_IF</span>
                            <span class="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Source
                                Interface</span>
                        </div>
                        <div class="flex flex-wrap items-center justify-between gap-3 mb-8">
                            <h1 class="text-6xl font-display font-black tracking-tighter text-white">Interface</h1>
                            <button type="button" class="layer-link" data-image-manager="browse">Image Manager · Shift + I</button>
                        </div>
                        <details class="dungeon-identity">
                            <summary>Microcontroller UUID</summary>
                            <label>Active UUID <input class="js-dungeon-uuid" maxlength="23" placeholder="500100…" autocomplete="off" spellcheck="false"></label>
                            <button type="button" class="cf-dump-button js-dungeon-uuid-load">Load UUID</button>
                            <button type="button" class="cf-dump-button js-dungeon-uuid-save">Save UUID</button>
                            <p class="js-dungeon-uuid-status" role="status"></p>
                        </details>
                        <p class="js-image-load-error text-error text-xs" role="alert"></p>
                        <div class="cf-interface-grid grid grid-cols-2 gap-16 mt-20">
                            <div class="space-y-4">
                                <button
                                    class="w-full py-6 px-6 border border-zinc-800 bg-zinc-900 text-left hover:border-primary transition-colors js-source-btn"
                                    data-source="disk" type="button">
                                    <span class="flex items-center gap-4 text-white font-mono text-lg">
                                        <span class="material-symbols-outlined text-3xl">folder_open</span>
                                        Load flash image
                                    </span>
                                </button>
                                <button
                                    class="w-full py-6 px-6 border border-zinc-800 bg-zinc-900 text-left hover:border-primary transition-colors js-source-btn"
                                    data-source="esp32c3" type="button">
                                    <span class="flex items-center gap-4 text-white font-mono text-lg">
                                        <span class="material-symbols-outlined text-3xl">developer_board</span>
                                        ESP32-C3 based SPI flash reader
                                    </span>
                                </button>
                                <button
                                    class="w-full py-6 px-6 border border-zinc-800 bg-zinc-900 text-left hover:border-primary transition-colors js-source-btn"
                                    data-source="pico" type="button">
                                    <span class="flex items-center gap-4 text-white font-mono text-lg">
                                        <span class="material-symbols-outlined text-3xl">memory</span>
                                        Pico based SPI flash reader
                                    </span>
                                </button>
                                <button
                                    class="w-full py-6 px-6 border border-zinc-800 bg-zinc-900 text-left hover:border-primary transition-colors js-source-btn"
                                    data-source="fliptdi" type="button">
                                    <span class="flex items-center gap-4 text-white font-mono text-lg">
                                        <span class="material-symbols-outlined text-3xl">usb</span>
                                        Flipper Zero based SPI flash reader
                                    </span>
                                </button>
                                <input class="hidden" id="flashdump-file-input" type="file" />
                                <p class="hidden text-sm text-zinc-400 js-secure-context-help" role="status">Hardware connections require a secure context. Open TB2 Dungeon over HTTPS or localhost to use WebUSB (Flipper) and Web Serial (Pico / ESP32-C3). Local image files remain available.</p>
                            </div>

                            <div class="cf-interface-config border-l border-zinc-800 pl-16 flex items-center">
                                <div class="w-full space-y-6">
                                    <div class="hidden js-source-config">
                                        <p class="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-3">
                                            Interface Configuration
                                        </p>
                                        <h3 class="text-2xl font-display font-bold text-white mb-6 js-config-title">
                                            Reader Options
                                        </h3>
                                        <div class="space-y-3 js-generic-reader-config font-mono text-xs">
                                            <div class="flex flex-wrap gap-2">
                                                <button type="button" class="js-ser-connect border border-zinc-600 px-3 py-2">Connect</button>
                                                <button type="button" class="js-ser-disconnect border border-zinc-600 px-3 py-2" disabled>Disconnect</button>
                                                <button type="button" class="js-ser-cancel border border-zinc-600 px-3 py-2" disabled>Cancel</button>
                                            </div>
                                            <p class="js-ser-status text-zinc-300" role="status" aria-live="polite">Disconnected</p>
                                            <p class="js-ser-frequency text-zinc-500">Device default — frequency unknown</p>
                                            <details><summary>Connection settings</summary>
                                            <label class="block">SPI clock
                                                <select class="js-ser-clock bg-zinc-900 border border-zinc-700 p-2">
                                                    <option value="250000">250 kHz</option><option value="500000">500 kHz</option>
                                                    <option value="1000000">1 MHz</option><option value="2000000" selected>2 MHz</option>
                                                    <option value="4000000">4 MHz</option><option value="8000000">8 MHz</option><option value="16000000">16 MHz</option>
                                                </select>
                                            </label>
                                            <button type="button" class="js-ser-apply border border-zinc-600 px-3 py-2" disabled>Apply SPI clock</button>

                                                <label class="block mt-2">Baud rate
                                                    <select class="js-ser-baud bg-zinc-900 border border-zinc-700 p-2">
                                                        <option>115200</option><option>230400</option><option>460800</option><option>921600</option>
                                                    </select>
                                                </label>
                                                <p class="mt-2 text-zinc-500">Requires compatible serprog firmware and Chrome or Edge over HTTPS or localhost. Select the adapter port when prompted.</p>
                                            </details>
                                            <details class="js-ser-help border-t border-zinc-700 pt-2">
                                                <summary>Hardware, firmware &amp; wiring</summary>
                                                <div class="mt-3 space-y-3 text-zinc-300 max-h-64 overflow-y-auto terminal-scroll pr-2">
                                                    <div class="js-ser-help-pico space-y-2">
                                                        <p><strong>1. Get the firmware:</strong> This guide uses a Raspberry Pi Pico with RP2040, not Pico 2 or Pico W. Download the <a class="underline text-primary" href="https://github.com/stacksmashing/pico-serprog/archive/7f4c4b7c948ee774bdb7e5b2040d67154c8916f8.zip" target="_blank" rel="noopener noreferrer">Pico firmware source ZIP</a> (snapshot 7f4c4b7). This is source code, not a ready-to-install UF2. The reference project has no published release package; build the UF2 below. MicroPython is not serprog firmware.</p>
                                                        <p><strong>2. Build without pin changes:</strong> Follow the <a class="underline text-primary" href="https://www.raspberrypi.com/documentation/microcontrollers/c_sdk.html" target="_blank" rel="noopener noreferrer">official Pico C/C++ SDK setup</a>. Install the Arm embedded compiler, CMake, Ninja and Python; obtain the SDK including its submodules (USB needs TinyUSB). Set PICO_SDK_PATH to that SDK directory. In the configured build terminal, open the extracted firmware directory containing CMakeLists.txt and run:</p>
                                                        <pre class="whitespace-pre-wrap break-words border border-zinc-700 p-2"><code>cmake -S . -B build -G Ninja -DPICO_BOARD=pico
cmake --build build</code></pre>
                                                        <p>The output is <code>build/pico_serprog.uf2</code>. Keep the source pin definitions unchanged: CS=GP1, SCK=GP2, MOSI=GP3, MISO=GP4. They match the table below. No TB2 Dungeon protocol patch is required by the inspected source. This is not a claim of a tested firmware build or hardware compatibility.</p>
                                                        <p><strong>3. Install on the Pico:</strong> Leave the target flash disconnected. Hold BOOTSEL while connecting the Pico to the PC with a USB data cable, then release it when the RPI-RP2 drive appears. Copy <code>pico_serprog.uf2</code> to that drive. The drive disappears as the Pico restarts. Afterwards, use its USB serial port; do not hold BOOTSEL for normal use. If no serial port appears, check the build's USB/TinyUSB support and the cable.</p>
                                                        <p><strong>4. Connect to TB2 Dungeon:</strong> Connect the Pico directly by USB. Once the powered-off SPI wiring below is complete and the target is correctly powered, select Pico, keep 115200 baud and 2 MHz SPI, then click Connect. The baud setting is the serial-port setting, not the SPI clock. Other firmware builds may have different GPIO assignments.</p>
                                                        <p><strong>Adapter to flash:</strong> Wire while power is off. Identify pin 1 from the chip marking. These numbers apply only to the W25Q128FV 8-pin SOIC/VSOP or 8-pad WSON package, not a 16-pin package or a board connector. On an assembled board, use confirmed test points for the same signals.</p>
                                                        <table class="w-full text-left text-xs"><thead><tr><th class="pb-1">Adapter GPIO</th><th class="pb-1">Flash signal</th><th class="pb-1">Chip pin</th></tr></thead><tbody>
                                                            <tr><td class="js-ser-pin-cs"></td><td>/CS</td><td>1</td></tr>
                                                            <tr><td class="js-ser-pin-miso"></td><td>DO / MISO</td><td>2</td></tr>
                                                            <tr><td>GND</td><td>GND</td><td>4</td></tr>
                                                            <tr><td class="js-ser-pin-mosi"></td><td>DI / MOSI</td><td>5</td></tr>
                                                            <tr><td class="js-ser-pin-clock"></td><td>CLK / SCK</td><td>6</td></tr>
                                                        </tbody></table>
                                                        <p><strong>Power:</strong> Use 3.3 V signal levels and one suitable regulated 3.3 V supply for flash VCC (pin 8); never connect USB 5 V to it. Share ground. On a standalone chip, keep /WP (pin 3) and /HOLD or /RESET (pin 7) high with pull-ups to its supply. Do not hard-wire those signals against an assembled board's outputs. Do not join independent supply outputs or try to power the whole box from the adapter's 3.3 V pin.</p>
                                                        <p><strong>In-circuit access:</strong> The box must not run or drive the SPI bus during programming. Its power and bus-isolation arrangement must be established for the actual board; a clip alone does not provide isolation. Disconnect the box's battery and USB.</p>
                                                        <p><strong>Start and troubleshoot:</strong> Use Chrome or Edge over HTTPS or localhost. These adapters need an operating-system serial port; do not apply the Flipper WinUSB driver setup to them. Close other serial tools. Continue after W25Q128 detection. The same initialized connection serves subsequent reads and writes. Disconnecting or detecting the chip again invalidates the device-baseline proof. Keep a recovery copy; Create Backup makes two complete matching reads without replacing your working image. If detection or repeated reads fail, disconnect and inspect wiring and power; try a lower SPI clock such as 500 kHz or 250 kHz. Use Disconnect before rewiring.</p>
                                                    </div>
                                                    <div class="js-ser-help-esp32c3 hidden space-y-2">
                                                        <p><strong>1. Check the firmware:</strong> The firmware must match the ESP32-C3 board being used.</p>
                                                        <p><strong>2. Find the C3 serial port:</strong> Disconnect the SOP8 clip from the target. Connect the SuperMini to the PC with a USB-C <strong>data</strong> cable. In Windows Device Manager, note its current COM port. Windows 10/11 normally installs the native USB serial driver automatically; if the port is missing, use <a class="underline text-primary" href="https://docs.espressif.com/projects/esp-iot-solution/en/latest/usb/usb_overview/usb_serial_jtag.html" target="_blank" rel="noopener noreferrer">Espressif’s driver guidance</a>. Do <strong>not</strong> apply the Flipper WinUSB instructions to the C3’s serial port.</p>
                                                        <p><strong>3. Manufacturer documentation:</strong> <a class="underline text-primary" href="https://docs.espressif.com/projects/esptool/en/latest/esp32c3/esptool/basic-commands.html" target="_blank" rel="noopener noreferrer">Espressif esptool documentation</a> · <a class="underline text-primary" href="https://docs.espressif.com/projects/esp-idf/en/stable/esp32c3/get-started/establish-serial-connection.html" target="_blank" rel="noopener noreferrer">Espressif serial connection documentation</a>.</p>
                                                        <p><strong>4. Wire the adapter to the flash while everything is unpowered.</strong> Identify chip pin 1 from its package marking; do not infer it from the cable connector’s numbering. For the eight-pin SPI flash used in this setup:</p>
                                                        <table class="w-full text-left text-xs"><thead><tr><th class="pb-1">ESP32-C3 / supply</th><th class="pb-1">Flash signal</th><th class="pb-1">Chip pin</th></tr></thead><tbody>
                                                            <tr><td>GPIO4</td><td>/CS</td><td>1</td></tr>
                                                            <tr><td>GPIO5</td><td>DO / MISO</td><td>2</td></tr>
                                                            <tr><td>Target-side 3.3 V</td><td>/WP</td><td>3</td></tr>
                                                            <tr><td>GND</td><td>GND</td><td>4</td></tr>
                                                            <tr><td>GPIO7</td><td>DI / MOSI</td><td>5</td></tr>
                                                            <tr><td>GPIO6</td><td>CLK / SCK</td><td>6</td></tr>
                                                            <tr><td>Target-side 3.3 V</td><td>/HOLD</td><td>7</td></tr>
                                                            <tr><td>Target-side 3.3 V</td><td>VCC</td><td>8</td></tr>
                                                        </tbody></table>
                                                        <p><strong>R1 is required:</strong> connect a <strong>10 kΩ pull-up from /CS to target-side 3.3 V</strong>. It is a branch off the /CS line, not a resistor inserted in series. If the wiring already provides this pull-up, do not add a second one. With the existing SOP8 cable socket viewed into its eight holes and its guide bump on the right, the left column corresponds to chip pins <strong>8, 7, 6, 5</strong> and the right column to <strong>1, 2, 3, 4</strong>.</p>
                                                        <p><strong>5. Check power and isolation:</strong> Use 3.3 V signal levels and a common ground; never connect USB 5 V to flash VCC. Keep the box’s USB disconnected and its own power isolated for in-circuit access. A clip does not isolate the box’s SPI bus, and the adapter’s 3.3 V output must not be used to power the whole box. Check continuity, the /CS pull-up and the absence of supply shorts before reconnecting USB. SPI lines may still backfeed the target, so a reset is confirmed only if you measure VCC falling.</p>
                                                        <p><strong>6. Continue in <a class="underline text-primary" href="https://github.com/dungeon-project/TB2-Dungeon" target="_blank" rel="noopener noreferrer">TB2 Dungeon</a>:</strong> The C3 presents serprog through its native USB serial port, which the browser accesses through WebSerial. <strong>8 MHz is this guide’s recommended target-SPI setting</strong>; do not assume it is already the firmware or website default. Start with read-only checks. If detection or repeated reads fail, disconnect and inspect clip contact, wiring and supply before trying a lower SPI clock.</p>
                                                        <p>The direct-wire arrangementshown here has <strong>not</strong> been physically verified on its own; target writes and erases have not been demonstrated.</p>
                                                    </div>
                                                </div>
                                            </details>
                                        </div>
                                        <div class="hidden space-y-4 js-fliptdi-config">
                                            <details class="js-ftdi-clock border border-zinc-800 p-4 space-y-3 font-mono text-[11px]"><summary>Connection settings</summary>
                                                <label class="block">Bridge profile
                                                    <select class="js-clock-profile mt-1 w-full bg-zinc-900 border border-zinc-700 p-2">
                                                        <option value="legacy">Legacy / unknown firmware (device default)</option>
                                                        <option value="flipper-64mhz">Clock-compatible (64 MHz kernel)</option>
                                                    </select>
                                                </label>
                                                <p class="text-zinc-500">Select the compatible profile only for TB2 Dungeon 1.0.3. USB identification alone cannot confirm support.</p>
                                                <label class="block">SPI clock
                                                    <select class="js-clock-target mt-1 w-full bg-zinc-900 border border-zinc-700 p-2" disabled></select>
                                                </label>
                                                <p class="js-clock-warning text-amber-300" hidden>16 MHz requires confirmation for the connected chip and wiring. The default is 8 MHz.</p>
                                                <button class="js-clock-apply border border-zinc-700 px-4 py-2 disabled:opacity-40 disabled:cursor-not-allowed" disabled type="button">Apply SPI clock</button>
                                                <div class="js-clock-status text-zinc-400 whitespace-pre-line" role="status" aria-live="polite"></div>
                                                <p class="js-clock-error text-amber-300" role="alert" hidden></p>
                                            </details>
                                            <div class="prod-only space-y-4">
                                                <button
                                                    class="js-ftdi-prod-connect w-full px-5 py-4 border border-secondary/70 bg-secondary/10 text-secondary font-mono text-[11px] uppercase tracking-widest hover:border-secondary hover:bg-secondary/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                    type="button">Connect Flipper Zero</button>

                                                <p class="font-mono text-[10px] leading-relaxed text-zinc-500">
                                                    Start the TB2 Dungeon app on the Flipper with target power off.
                                                    Switch 3.3 V on when the status changes to
                                                    <span class="text-zinc-300">Waiting for chip power</span>.
                                                </p>

                                                <div class="border border-zinc-800 bg-black/40 p-4 font-mono text-[10px] leading-relaxed">
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">Connection</span>
                                                        <span class="js-ftdi-prod-connection text-zinc-300">Disconnected</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">Flash</span>
                                                        <span class="js-ftdi-prod-chip text-zinc-300">Not detected</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">Status</span>
                                                        <span class="js-ftdi-prod-status text-zinc-300 text-right">Ready to connect</span>
                                                    </div>
                                                </div>

                                                <div class="border border-zinc-700 bg-zinc-950/70 p-4 font-mono text-[10px] leading-relaxed">
                                                    <p class="text-zinc-300 uppercase tracking-wider mb-2">Windows first-time setup</p>
                                                    <p class="text-zinc-500">
                                                        The TB2 Dungeon USB device must be switched to
                                                        <span class="text-zinc-200">WinUSB</span> once before WebUSB can use it.
                                                    </p>
                                                    <p class="mt-2 text-zinc-500">
                                                        In Zadig: <span class="text-zinc-300">Options → List All Devices</span>,
                                                        select the device with <span class="text-zinc-300">VID:PID 0403:6014</span>,
                                                        choose <span class="text-zinc-300">WinUSB</span>, then
                                                        <span class="text-zinc-300">Install/Replace Driver</span>.
                                                        Verify the VID:PID before replacing a driver.
                                                    </p>
                                                    <a class="production-help-link inline-block mt-3"
                                                        href="https://zadig.akeo.ie/" target="_blank"
                                                        rel="noopener noreferrer">Open Zadig website</a>
                                                </div>

                                                <div class="js-ftdi-driver-help hidden border border-amber-500/30 bg-amber-500/5 p-4 font-mono text-[10px] leading-relaxed">
                                                    <p class="text-amber-300 uppercase tracking-wider">Flipper not available through WebUSB</p>
                                                    <p class="mt-2 text-zinc-400">
                                                        If TB2 Dungeon is running and the USB device is connected,
                                                        Windows may still be using a different driver. Configure the
                                                        0403:6014 device once as WinUSB with Zadig, reconnect it, and try again.
                                                    </p>
                                                    <div class="mt-3 flex gap-2">
                                                        <a class="production-help-link px-3 py-2 border border-zinc-700"
                                                            href="https://zadig.akeo.ie/" target="_blank"
                                                            rel="noopener noreferrer">Zadig</a>
                                                        <button
                                                            class="js-ftdi-prod-retry px-3 py-2 border border-zinc-700 text-zinc-300 hover:border-primary"
                                                            type="button">Try again</button>
                                                    </div>
                                                </div>

                                                <p class="js-ftdi-prod-error hidden border border-error/30 bg-error/5 p-3 font-mono text-[10px] text-error"
                                                    role="alert"></p>

                                                <button
                                                    class="js-ftdi-prod-disconnect w-full px-3 py-2 border border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500 hover:text-white hover:border-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    type="button" disabled>Disconnect</button>
                                            </div>

                                            <div class="dev-only space-y-4">
                                                <button
                                                    class="js-ftdi-auto-flow w-full px-5 py-4 border border-secondary/70 bg-secondary/10 text-secondary font-mono text-[11px] uppercase tracking-widest hover:border-secondary hover:bg-secondary/15 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                                    type="button">Connect TB2</button>

                                                <p class="font-mono text-[10px] leading-relaxed text-zinc-500">
                                                    Start the connection with target power off. Switch 3.3 V on when the status
                                                    changes to <span class="text-zinc-300">Waiting for chip power</span>.
                                                </p>

                                                <div class="border border-zinc-800 bg-black/40 p-4 font-mono text-[10px] leading-relaxed">
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">Connection</span>
                                                        <span class="js-ftdi-usb text-zinc-300">Disconnected</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">Chip</span>
                                                        <span class="js-ftdi-chip-state text-zinc-300">Not detected</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">Status</span>
                                                        <span class="js-ftdi-operation text-zinc-300 text-right">Idle</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">VID:PID</span>
                                                        <span class="js-ftdi-vidpid text-zinc-300">-</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">Interface</span>
                                                        <span class="js-ftdi-interface text-zinc-300">-</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">MPSSE</span>
                                                        <span class="js-ftdi-mpsse-state text-zinc-300 text-right">disabled</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">EP1</span>
                                                        <span class="js-ftdi-ep1-state text-zinc-300">not primed</span>
                                                    </div>
                                                    <div class="flex items-center justify-between gap-4 py-1">
                                                        <span class="text-zinc-600 uppercase tracking-wider">GPIO</span>
                                                        <span class="js-ftdi-gpio-state text-zinc-300">-</span>
                                                    </div>
                                                </div>

                                                <div class="grid grid-cols-3 gap-2">
                                                    <button class="js-ftdi-connect px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Select USB</button>
                                                    <button class="js-ftdi-open px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Open</button>
                                                    <button class="js-ftdi-mpsse px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">MPSSE</button>
                                                    <button class="js-ftdi-prime px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Prime</button>
                                                    <button class="js-ftdi-wait-chip px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Wait Chip</button>
                                                    <button class="js-ftdi-jedec px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">JEDEC</button>
                                                    <button class="js-ftdi-status1 px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Status-1</button>
                                                    <button class="js-ftdi-gpio px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">GPIO</button>
                                                    <button class="js-ftdi-ctrl-pins px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">EP0 Pins</button>
                                                    <button class="js-ftdi-info px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Device Info</button>
                                                    <button class="js-ftdi-ifaces px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">Interfaces</button>
                                                    <button class="js-ftdi-gpio-probe px-2 py-2 border border-zinc-700 font-mono text-[9px]" type="button">GPIO JEDEC</button>
                                                </div>

                                                <div class="border border-zinc-800 bg-black/40 p-3 font-mono text-[9px]">
                                                    <div>Probe: <span class="js-ftdi-probe-state text-zinc-300">not run</span></div>
                                                </div>

                                                <p class="js-ftdi-fault hidden error-box" role="alert"></p>
                                                <pre class="js-ftdi-log max-h-28 overflow-auto border border-zinc-800 bg-black/60 p-3 font-mono text-[9px] text-zinc-500 whitespace-pre-wrap"></pre>

                                                <button
                                                    class="js-ftdi-disconnect w-full px-3 py-2 border border-zinc-800 font-mono text-[10px] uppercase tracking-wider text-zinc-500 hover:text-white hover:border-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed"
                                                    type="button">Disconnect</button>
                                            </div>
                                        </div>
                                    </div>

                        <div class="js-box-identity cf-box-identity" hidden aria-live="polite">
                            <span class="js-box-picture" aria-hidden="true"></span>
                            <div><p class="js-box-status"></p><small class="js-box-chip-id"></small></div>
                            <button type="button" class="layer-link js-assign-box" hidden>Assign to box</button>
                        </div>
                                    <div class="dev-only border border-zinc-800 bg-zinc-900/40 p-4 js-interface-info">
                                        <p class="text-[10px] font-mono text-zinc-500 uppercase tracking-widest mb-2">
                                            Sparse Image Info
                                        </p>
                                        <div class="space-y-1 font-mono text-[11px] text-zinc-300">
                                            <p>Loaded: <span class="text-zinc-100 js-iface-info-loaded">no</span></p>
                                            <p>Name: <span class="text-zinc-100 js-iface-info-name">-</span></p>
                                            <p>Size: <span class="text-zinc-100 js-iface-info-size">-</span></p>
                                            <p>Pending writes: <span class="text-zinc-100 js-iface-info-pending">-</span></p>
                                            <p>Readable bytes: <span class="text-zinc-100 js-iface-info-readable">-</span></p>
                                        </div>
                                        <button
                                            class="mt-4 w-full py-3 bg-zinc-900 text-white font-mono font-bold text-[11px] uppercase tracking-[0.16em] border border-zinc-700 hover:border-primary transition-all flex items-center justify-center gap-2 js-interface-save-image-btn"
                                            type="button">
                                            <span class="material-symbols-outlined text-base">save</span>
                                            Save Image to Disk
                                        </button>
                                        <p class="js-interface-dirty-note hidden mt-2 font-mono text-[11px] text-amber-300 border border-amber-400/40 bg-amber-500/10 px-3 py-2">
                                            Firmware image has changed
                                        </p>
                                    </div>
                                    <div class="prod-only border border-zinc-800 bg-zinc-900/40 p-4">
                                        <div class="flex items-center justify-between gap-4">
                                            <p class="text-[10px] font-mono text-zinc-500 uppercase tracking-widest">Image</p>
                                            <span class="js-prod-iface-changes font-mono text-[10px] text-zinc-400">No pending changes</span>
                                        </div>
                                        <div class="mt-3 space-y-1 font-mono text-[11px] text-zinc-300">
                                            <p>Name: <span class="text-zinc-100 js-prod-iface-name">-</span></p>
                                            <p>Size: <span class="text-zinc-100 js-prod-iface-size">-</span></p>
                                        </div>
                                        <button
                                            class="js-prod-save-image-btn mt-4 w-full py-3 bg-zinc-900 text-white font-mono font-bold text-[11px] uppercase tracking-[0.16em] border border-zinc-700 hover:border-primary transition-all disabled:opacity-30 disabled:cursor-not-allowed"
                                            type="button" disabled>Open Dump / Flash</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                </div>
                <div class="interface-opening-overlay hidden js-interface-opening-overlay">
                    <div class="interface-opening-card">OPENING...</div>
                </div>

            </section>`;
