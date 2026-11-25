
// Startup preferences are scoped to this TB2 Dungeon directory, not the whole origin.
window.CoreFlasherStartup = {
    key(name) { return `core-flasher:${new URL('.', location.href).pathname}:${name}`; },
    read(name) { try { return localStorage.getItem(this.key(name)) === '1'; } catch { return false; } },
    write(name, enabled) { try { localStorage.setItem(this.key(name), enabled ? '1' : '0'); return true; } catch { return false; } }
};
    