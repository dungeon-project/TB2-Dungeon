/* Compact, versioned search evidence shared by the scanner and archive metadata validation. */
(() => {
    'use strict';
    const config = Object.freeze({KERNEL_IDS: ['legacy-v1','optimized-v1','optimized-v2','optimized-v3'],
        BATCH_SIZES: Array.from({length:15}, (_,index) => 2 ** (index + 12)),
        WORKGROUP_SIZES: [64,128,256], MAX_VARIANTS: 256});
    const MASKS = ['500100XXXXXXXXD7','500100XXXXXXXXAA','500100XXXXXXXXXX'];
    const total = plan => plan.stages.at(-1).mask === MASKS[2] ? (257 - plan.stages.length) * 2 ** 32 : 2 ** 32;
    const MAX_COUNTER = 2 ** 40;
    const LEGACY_ALGORITHM_IDS = ['legacy-v1', 'optimized-v1'];
    const LEGACY_MAX_VARIANTS = 26;
    const LEGACY_MAX_BATCH_SIZE = 2 ** 24;
    const finite = value => Number.isFinite(value) && value >= 0;
    const count = value => Number.isSafeInteger(value) && value >= 0;
    const text = (value, limit) => typeof value === 'string' && value.length <= limit && !/[\x00-\x1f]/.test(value);

    /** Cumulative work survives checkpoints; a cursor is deliberately not used as an attempt count. */
    function newTelemetry() {
        return { startedAt: new Date().toISOString(), candidatesTested: 0, activeMs: 0, setupMs: 0,
            cpuCandidates: 0, rejectedCandidates: 0, resumes: 0, variants: [] };
    }
    /** Keep historical evidence rules intact; version two records every dispatched workgroup. */
    function validateTelemetry(value, format = 1) {
        if (format !== 1 && format !== 2) throw new Error('Unsupported UUID search statistics format.');
        const maximumVariants = format === 1 ? LEGACY_MAX_VARIANTS : config.MAX_VARIANTS;
        if (!value || !text(value.startedAt, 40) || !Number.isFinite(Date.parse(value.startedAt))
            || !['candidatesTested','cpuCandidates','rejectedCandidates','resumes'].every(key => count(value[key]))
            || !finite(value.activeMs) || !finite(value.setupMs) || !Array.isArray(value.variants)
            || value.variants.length > maximumVariants || value.rejectedCandidates > value.cpuCandidates) {
            throw new Error('Invalid UUID search statistics.');
        }
        for (const variant of value.variants) {
            const allowedAlgorithms = format === 1 ? LEGACY_ALGORITHM_IDS : config.KERNEL_IDS;
            const maximumBatch = format === 1 ? LEGACY_MAX_BATCH_SIZE : config.BATCH_SIZES.at(-1);
            if (!allowedAlgorithms.includes(variant.algorithm) || !text(variant.kernel, 40)
                || !count(variant.batchSize) || variant.batchSize < config.BATCH_SIZES[0] || variant.batchSize > maximumBatch
                || (variant.batchSize & (variant.batchSize - 1)) !== 0 || !count(variant.candidatesTested)
                || !finite(variant.activeMs) || !finite(variant.setupMs)
                || (format === 2 && !config.WORKGROUP_SIZES.includes(variant.workgroupSize))) {
                throw new Error('Invalid UUID search variant.');
            }
        }
        return value;
    }

    function validatePlan(plan, next, mask) {
        if (!plan || plan.version !== 1 || !MASKS.includes(plan.startMask)
            || !Array.isArray(plan.stages) || !plan.stages.length || plan.stages.length > 3) {
            throw new Error('Invalid UUID search plan.');
        }
        const expected = MASKS.slice(MASKS.indexOf(plan.startMask));
        for (const [index, stage] of plan.stages.entries()) {
            const partial = { stages: plan.stages.slice(0, index + 1) };
            if (stage.mask !== expected[index] || !Number.isSafeInteger(stage.covered)
                || stage.covered < 0 || stage.covered > total(partial)
                || (index < plan.stages.length - 1 && stage.covered !== total(partial))
                || !Number.isSafeInteger(stage.candidatesTested) || stage.candidatesTested < 0
                || !Number.isFinite(stage.activeMs) || stage.activeMs < 0
                || !Number.isFinite(stage.setupMs) || stage.setupMs < 0) throw new Error('Invalid UUID stage evidence.');
        }
        if (plan.stages.at(-1).covered !== next || plan.stages.at(-1).mask !== mask) {
            throw new Error('UUID search plan does not match its cursor.');
        }
        return plan;
    }

    /** Reject malformed optional reports during normal archive reads and metadata restore alike. */
    function validateReport(value) {
        validateTelemetry(value, value?.format === 3 ? 2 : value?.format);
        if (![1, 2, 3].includes(value.format) || !/^500100[0-9A-F]{10}$/.test(value.uuid)
            || !['500100XXXXXXXXD7','500100XXXXXXXXAA','500100XXXXXXXXXX'].includes(value.mask)
            || !/^[a-f0-9]{64}$/.test(value.inputSha256) || !count(value.inputBytes) || value.inputBytes < 33
            || !Number.isInteger(value.padding) || value.padding < 1 || value.padding > 16
            || !count(value.start) || !count(value.endExclusive) || !count(value.next)
            || value.start > value.next || value.next > value.endExclusive || value.endExclusive > MAX_COUNTER
            || !text(value.foundAt,40) || !Number.isFinite(Date.parse(value.foundAt))
            || !text(value.websiteVersion,40) || !text(value.browser,256)
            || value.acceptance !== 'cpu-zero-padding') throw new Error('Invalid successful UUID search report.');
        if (value.adapter && (!['vendor','architecture','description'].every(key => text(value.adapter[key],256))
            || typeof value.adapter.isFallbackAdapter !== 'boolean')) throw new Error('Invalid search adapter details.');
        if (value.format === 3) {
            const planner = {validate: validatePlan, total};
            planner.validate(value.plan, value.next, value.mask);
            if (value.endExclusive !== planner.total(value.plan)) throw new Error('Invalid UUID report range.');
            for (const field of ['candidatesTested', 'activeMs', 'setupMs']) {
                const sum = value.plan.stages.reduce((total, stage) => total + stage[field], 0);
                if (Math.abs(sum - value[field]) > 0.01) throw new Error('Inconsistent UUID stage statistics.');
            }
        }
        return value;
    }
    /** Freeze a detached success report so a later scan cannot change the pending save. */
    function snapshot(value) {
        const copy = JSON.parse(JSON.stringify(value));
        const freeze = item => { if (item && typeof item === 'object') { Object.values(item).forEach(freeze); Object.freeze(item); } };
        freeze(copy);
        return copy;
    }
    const api = { schema:config, validatePlan, planTotal:total, newTelemetry, validateTelemetry, validateReport, snapshot, WEBSITE_VERSION: '1.0.0' };
    globalThis.CoreFlasherUuidRecord = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
