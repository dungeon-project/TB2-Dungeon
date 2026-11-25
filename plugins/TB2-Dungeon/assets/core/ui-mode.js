
(() => {
    const storageKey = 'tb2_dev_mode';
    const params = new URLSearchParams(window.location.search);
    const flag = params.get('dev');

    try {
        if (flag === '1') {
            localStorage.setItem(storageKey, '1');
        }
        else if (flag === '0') {
            localStorage.removeItem(storageKey);
        }

        window.DEV_MODE =
            flag === '1' ||
            (flag !== '0' && localStorage.getItem(storageKey) === '1');
    }
    catch (_error) {
        window.DEV_MODE = flag === '1';
    }

    document.documentElement.classList.toggle('dev-mode', !!window.DEV_MODE);
})();
