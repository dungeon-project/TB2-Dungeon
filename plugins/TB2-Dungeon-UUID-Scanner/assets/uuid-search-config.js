/* Shared scanner limits and tuning policy; no browser or GPU initialization. */
(() => {
    'use strict';
    const KERNEL_IDS = Object.freeze(['legacy-v1', 'optimized-v1', 'optimized-v2', 'optimized-v3']);
    const BATCH_SIZES = Object.freeze(Array.from({ length: 15 }, (_, index) => 2 ** (index + 12)));
    const WORKGROUP_SIZES = Object.freeze([64, 128, 256]);
    const CA_CRYPT_PATH = '/cert/ca.der.crypt';
    const DEFAULTS = Object.freeze({ algorithm: 'optimized-v3', batchSize: 2 ** 24, workgroupSize: 256 });
    const TUNING = Object.freeze({
        policyRevision: 'throughput-v1',
        pilotTargetMs: 100,
        switchThreshold: 0.05, plateauThreshold: 0.03, warmupCount: 1, sampleCount: 3,
        maxConfigurations: KERNEL_IDS.length * WORKGROUP_SIZES.length,
        driftSamples: 8, driftMinMs: 30000, driftThreshold: 0.25,
        recoveryCooldownMs: 30000, stabilityThreshold: 0.25, finalistCount: 2
    });
    // Four kernels, fifteen batch sizes and three workgroups need 180 entries;
    // bounded headroom retains evidence from earlier kernel revisions on resume.
    const MAX_VARIANTS = 256;
    const MAX_PIPELINES = 16;
    const PROFILE_VERSION = 2;
    const MAX_PROFILES = 8;
    const DISPLAY_INTERVAL_MS = 500;
    const api = Object.freeze({ KERNEL_IDS, BATCH_SIZES, WORKGROUP_SIZES, CA_CRYPT_PATH, DEFAULTS,
        MAX_VARIANTS, MAX_PIPELINES, PROFILE_VERSION, MAX_PROFILES, DISPLAY_INTERVAL_MS, TUNING });
    globalThis.CoreFlasherUuidConfig = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
