/* Pure search coverage: suffix partitions reuse the existing eight-nibble GPU kernels. */
(() => {
    'use strict';
    const PREFIX = '500100';
    const D7 = `${PREFIX}XXXXXXXXD7`;
    const AA = `${PREFIX}XXXXXXXXAA`;
    const FULL = `${PREFIX}XXXXXXXXXX`;
    const RANGE = 2 ** 32;
    const MASKS = [D7, AA, FULL];
    const preparedSuffixes = new WeakMap();

    /** A new run has no evidence from previous runs, even when their masks match. */
    function create(mask, telemetry, covered = 0) {
        if (!MASKS.includes(mask)) throw new Error('Unsupported UUID search mask.');
        return { version: 1, startMask: mask, stages: [{ mask, covered,
            candidatesTested: telemetry?.candidatesTested || 0,
            activeMs: telemetry?.activeMs || 0, setupMs: telemetry?.setupMs || 0 }] };
    }

    /** Completed stages alone determine exclusions; there is no editable exclusion list. */
    function excluded(plan) {
        return plan.stages.slice(0, -1).map(stage => stage.mask.slice(-2));
    }
    function suffixes(plan) {
        const omitted = new Set(excluded(plan));
        return Array.from({ length: 256 }, (_, index) => index.toString(16).toUpperCase().padStart(2, '0'))
            .filter(suffix => !omitted.has(suffix));
    }
    function total(plan) {
        const mask = plan.stages.at(-1).mask;
        return mask === FULL ? (256 - excluded(plan).length) * RANGE : RANGE;
    }

    /** Mutate only after the caller has verified every candidate in the current stage. */
    function advance(plan) {
        const stage = plan.stages.at(-1);
        if (stage.covered !== total(plan)) throw new Error('Cannot expand an incomplete UUID search.');
        if (stage.mask === FULL) return false;
        plan.stages.push({ mask: stage.mask === D7 ? AA : FULL,
            covered: 0, candidatesTested: 0, activeMs: 0, setupMs: 0 });
        return true;
    }

    /** Return a fixed-suffix segment; direct full scans retain their legacy counter order. */
    function segment(plan, next, batchSize) {
        if (!Number.isSafeInteger(next) || next < 0 || next > total(plan)
            || !Number.isSafeInteger(batchSize) || batchSize < 1) throw new Error('Invalid search plan cursor.');
        if (next === total(plan)) return null;
        const currentMask = plan.stages.at(-1).mask;
        if (currentMask === FULL && plan.stages.length === 1) return { mask: FULL, direct: true };
        // Prepare the remainder once per plan, outside candidate evaluation and GPU dispatch.
        if (currentMask === FULL && !preparedSuffixes.has(plan)) preparedSuffixes.set(plan, suffixes(plan));
        const suffix = currentMask === FULL ? preparedSuffixes.get(plan)[Math.floor(next / RANGE)] : currentMask.slice(-2);
        const low = next % RANGE;
        return { mask: `${PREFIX}XXXXXXXX${suffix}`, low, count: Math.min(batchSize, RANGE - low), direct: false };
    }

    /** Reject forged completion evidence and impossible stage orders before using exclusions. */
    function validate(plan, next, mask) {
        return CoreFlasherUuidRecord.validatePlan(plan, next, mask);
    }

    const api = { D7, AA, FULL, RANGE, create, excluded, suffixes, total, advance, segment, validate };
    globalThis.CoreFlasherUuidPlan = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
