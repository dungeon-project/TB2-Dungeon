/* Search tuning uses verified production work; the controller owns coverage and persistence. */
(() => {
    'use strict';
    const config = globalThis.CoreFlasherUuidConfig || (typeof require === 'function'
        ? require('../../uuid-search-config.js') : null);
    if (!config) throw new Error('UUID search configuration is not loaded.');
    const policy = config.TUNING;
    const copy = value => ({ algorithm: value.algorithm, batchSize: value.batchSize,
        workgroupSize: value.workgroupSize });
    const pairKey = value => value.algorithm + '|' + value.workgroupSize;
    const key = value => pairKey(value) + '|' + value.batchSize;
    const median = values => {
        const sorted = [...values].sort((left, right) => left - right);
        return (sorted[Math.floor((sorted.length - 1) / 2)] + sorted[Math.ceil((sorted.length - 1) / 2)]) / 2;
    };
    const spread = values => (Math.max(...values) - Math.min(...values)) / median(values);

    /** Tune only Auto dimensions. Times are milliseconds and rates are candidates per millisecond. */
    class Tuner {
        constructor(requested, options = {}) {
            this.requested = { ...config.DEFAULTS, ...requested };
            for (const [field, values] of [['algorithm', config.KERNEL_IDS], ['batchSize', config.BATCH_SIZES],
                ['workgroupSize', config.WORKGROUP_SIZES]]) {
                if (this.requested[field] !== 'auto' && !values.includes(this.requested[field])) {
                    throw new Error('Invalid UUID tuning ' + field + '.');
                }
            }
            this.workgroups = config.WORKGROUP_SIZES.filter(value =>
                (options.availableWorkgroups || config.WORKGROUP_SIZES).includes(value));
            if (!this.workgroups.length || (this.requested.workgroupSize !== 'auto'
                && !this.workgroups.includes(this.requested.workgroupSize))) {
                throw new Error('Requested UUID workgroup size is unavailable.');
            }
            this.now = options.now || (() => performance.now());
            this.remaining = options.remaining;
            this.excluded = new Map();
            this.scores = new Map();
            this.batchCeiling = config.BATCH_SIZES.at(-1);
            this.rechecks = 0;
            this.evidenceRevision = 0;
            this.cacheRejected = false;
            this.automatic = Object.values(this.requested).includes('auto');
            const fallback = this.fixed({ algorithm: config.KERNEL_IDS[0],
                batchSize: config.BATCH_SIZES[0], workgroupSize: this.workgroups.includes(config.DEFAULTS.workgroupSize)
                    ? config.DEFAULTS.workgroupSize : this.workgroups.at(-1) });
            const stored = options.profile;
            this.cached = this.validProfile(stored) ? { ...stored, ...copy(stored) } : null;
            if (this.cached) this.evidenceRevision = this.cached.evidenceRevision;
            this.measuredPairs = this.cached?.measuredPairs || 0;
            this.eligiblePairs = this.cached?.eligiblePairs || 0;
            this.maxBatchTested = this.cached?.maxBatchTested || 0;
            this.selected = copy(this.cached || fallback);
            this.current = copy(this.selected);
            this.incumbent = copy(this.selected);
            this.incumbentEvidence = this.cached ? copy(this.cached) : null;
            this.complete = false;
            this.stable = false;
            this.measurementStable = false;
            this.publishedRate = 0;
            this.reason = '';
            this.steadySamples = [];
            this.steadyObservation = null;
            this.nextRecoveryAt = this.now() + policy.recoveryCooldownMs;
            if (!this.automatic) {
                this.phase = 'fixed';
                this.reason = 'Manual configuration.';
            } else if (this.cached) {
                // A saved batch is a hint, not a ceiling or a reason to rewrite it after one slow launch.
                this.startStage('cached-check', [this.current]);
                this.reason = 'Checking the complete saved configuration.';
            } else this.startCalibration();
        }

        fixed(value) {
            const result = copy(value);
            for (const field of ['algorithm', 'batchSize', 'workgroupSize']) {
                if (this.requested[field] !== 'auto') result[field] = this.requested[field];
            }
            return result;
        }

        compatible(value) {
            return !!value && config.KERNEL_IDS.includes(value.algorithm)
                && config.BATCH_SIZES.includes(value.batchSize) && this.workgroups.includes(value.workgroupSize)
                && ['algorithm', 'batchSize', 'workgroupSize'].every(field =>
                    this.requested[field] === 'auto' || this.requested[field] === value[field]);
        }

        validProfile(value) {
            return this.compatible(value) && value.complete === true && value.stable === true
                && value.provisional === false && Number.isFinite(value.rate) && value.rate > 0
                && Number.isSafeInteger(value.evidenceRevision) && value.evidenceRevision >= 0
                && value.policyRevision === policy.policyRevision
                && Number.isSafeInteger(value.measuredPairs) && value.measuredPairs > 0
                && value.measuredPairs === value.eligiblePairs && value.eligiblePairs <= policy.maxConfigurations
                && config.BATCH_SIZES.includes(value.maxBatchTested) && value.maxBatchTested >= value.batchSize;
        }

        /** No elapsed-time deadline or latency prediction can truncate the winner search. */
        next() { return copy(this.current); }
        get calibrating() { return this.phase !== 'fixed' && this.phase !== 'steady'; }
        get status() {
            return { phase: this.phase, calibrating: this.calibrating, reason: this.reason,
                provisional: !this.measurementStable, complete: this.complete, stable: this.stable,
                config: copy(this.current), excluded: this.excluded.size,
                driftRecheckUsed: this.rechecks > 0, rechecks: this.rechecks, cacheRejected: this.cacheRejected };
        }
        get profile() {
            return { ...copy(this.selected), rate: this.publishedRate,
                provisional: !this.measurementStable, complete: this.complete, stable: this.stable,
                evidenceRevision: this.evidenceRevision, policyRevision: policy.policyRevision,
                measuredPairs: this.measuredPairs, eligiblePairs: this.eligiblePairs,
                maxBatchTested: this.maxBatchTested };
        }

        /** Start an independent evidence epoch; old rates are never compared as fresh trial samples. */
        startCalibration() {
            this.complete = false;
            this.stable = false;
            this.measurementStable = false;
            this.publishedRate = 0;
            this.measuredPairs = 0;
            this.eligiblePairs = 0;
            this.maxBatchTested = 0;
            this.incumbent = copy(this.incumbentEvidence || this.selected);
            this.scores.clear();
            this.ranked = [];
            this.finalists = [];
            this.batchScores = [];
            this.reason = 'Measuring automatic selections with complete production batches.';
            if (this.requested.batchSize === 'auto') {
                this.current = this.fixed({ ...this.selected, batchSize: config.BATCH_SIZES[0] });
                this.phase = 'pilot';
            } else this.startRanking(this.requested.batchSize);
        }

        /** Prefer the incumbent, then give every kernel a turn before another workgroup. */
        pairs(batchSize) {
            const prefer = value => (left, right) => Number(right === value) - Number(left === value);
            const algorithms = [...(this.requested.algorithm === 'auto' ? config.KERNEL_IDS : [this.requested.algorithm])]
                .sort(prefer(this.incumbent.algorithm));
            const workgroups = [...(this.requested.workgroupSize === 'auto' ? this.workgroups : [this.requested.workgroupSize])]
                .sort(prefer(this.incumbent.workgroupSize));
            return workgroups.flatMap(workgroupSize => algorithms.map(algorithm =>
                ({ algorithm, workgroupSize, batchSize }))).filter(value => !this.excluded.has(pairKey(value)))
                .slice(0, policy.maxConfigurations);
        }

        /** Interleave all configurations once per round, rotating the start to avoid fixed-order bias. */
        startStage(phase, values) {
            if (!values.length) throw new Error('No eligible UUID search configuration remains.');
            this.phase = phase;
            this.stage = { values: values.map(copy), round: 0, position: 0,
                trials: values.map(value => ({ config: copy(value), rates: [], durations: [] })) };
            this.current = copy(this.stage.values[0]);
        }

        startRanking(batchSize) {
            const values = this.pairs(batchSize);
            this.eligiblePairs = values.length;
            this.startStage('ranking', values);
        }

        /** Observe only completed, CPU-verified full batches. Prefix tails never influence selection. */
        observe({ config: measured, count, elapsedMs, fullBatch, now } = {}) {
            if (!measured || key(measured) !== key(this.current)) throw new Error('Unexpected UUID tuning configuration.');
            if (!Number.isSafeInteger(count) || count < 1 || count > measured.batchSize
                || !Number.isFinite(elapsedMs) || elapsedMs < 0) throw new Error('Invalid UUID tuning sample.');
            const at = now === undefined ? this.now() : now;
            if (!Number.isFinite(at)) throw new Error('Invalid UUID tuning clock.');
            if (typeof this.remaining === 'number') this.remaining = Math.max(0, this.remaining - count);
            if (!fullBatch || count !== measured.batchSize || elapsedMs === 0 || this.phase === 'fixed') return;
            const rate = count / elapsedMs;
            if (!Number.isFinite(rate) || rate <= 0) throw new Error('Invalid UUID tuning rate.');
            this.maxBatchTested = Math.max(this.maxBatchTested, measured.batchSize);
            if (this.phase === 'steady') { this.observeSteady(rate, at); return; }
            if (this.phase === 'pilot') {
                const next = config.BATCH_SIZES.find(value => value > measured.batchSize && value <= this.batchCeiling);
                if (next && elapsedMs <= policy.pilotTargetMs && next / rate <= policy.pilotTargetMs) {
                    this.current = this.fixed({ ...measured, batchSize: next });
                } else this.startRanking(measured.batchSize);
                return;
            }
            this.observeStage(rate, elapsedMs, at);
        }

        observeStage(rate, elapsedMs, at) {
            const stage = this.stage;
            const index = (stage.position + stage.round) % stage.values.length;
            const trial = stage.trials[index];
            if (stage.round >= policy.warmupCount) {
                trial.rates.push(rate);
                trial.durations.push(elapsedMs);
            }
            stage.position++;
            if (stage.position === stage.values.length) { stage.position = 0; stage.round++; }
            if (stage.round < policy.warmupCount + policy.sampleCount) {
                this.current = copy(stage.values[(stage.position + stage.round) % stage.values.length]);
                return;
            }
            this.completeStage(stage.trials.map(value => this.score(value)), at);
        }

        score(trial) {
            const score = { config: copy(trial.config), rate: median(trial.rates),
                elapsedMs: median(trial.durations), stable: spread(trial.rates) <= policy.stabilityThreshold };
            this.scores.set(key(score.config), score);
            return score;
        }

        /** Apply pair hysteresis only to comparable, newly measured rates. */
        choosePair(scores) {
            const valid = scores.filter(score => !this.excluded.has(pairKey(score.config)));
            const best = [...valid].sort((left, right) => right.rate - left.rate)[0];
            const incumbent = valid.find(score => pairKey(score.config) === pairKey(this.incumbent));
            return incumbent && best.rate < incumbent.rate * (1 + policy.switchThreshold) ? incumbent : best;
        }

        /** Keep the smaller batch when it is within the configured plateau tolerance of the best. */
        chooseBatch(scores) {
            const best = Math.max(...scores.map(score => score.rate));
            return scores.filter(score => score.rate >= best * (1 - policy.plateauThreshold))
                .sort((left, right) => left.config.batchSize - right.config.batchSize)[0];
        }

        /** A saved incumbent may join confirmation, but never displace a raw Top-2 ladder candidate. */
        startConfirmation(winners) {
            this.finalists = winners;
            const values = winners.map(score => score.config);
            const incumbent = this.incumbentEvidence;
            if (incumbent && incumbent.batchSize <= this.batchCeiling && !this.excluded.has(pairKey(incumbent))
                && !values.some(value => pairKey(value) === pairKey(incumbent))) values.push(incumbent);
            this.startStage('confirm', values);
        }

        completeStage(scores, at) {
            if (this.phase === 'cached-check') { this.finishCachedCheck(scores[0], at); return; }
            if (this.phase === 'ranking') {
                this.ranked = scores;
                this.measuredPairs = scores.length;
                // Rank raw measurements first: pair hysteresis must not hide a candidate that scales better.
                this.finalists = [...scores].sort((left, right) => right.rate - left.rate).slice(0, policy.finalistCount);
                if (this.requested.batchSize !== 'auto') {
                    this.startConfirmation(this.finalists);
                    return;
                }
                const ladder = config.BATCH_SIZES.filter(size => size <= this.batchCeiling);
                this.startStage('batch', ladder.flatMap(batchSize => this.finalists.map(score =>
                    ({ ...score.config, batchSize }))));
            } else if (this.phase === 'batch') {
                this.batchScores = scores;
                const winners = this.finalists.map(finalist => this.chooseBatch(scores.filter(score =>
                    pairKey(score.config) === pairKey(finalist.config))));
                this.startConfirmation(winners);
            } else if (this.phase === 'confirm') {
                const agreement = scores.every(score => {
                    const previous = this.finalists.find(value => key(value.config) === key(score.config));
                    // A confirmation-only incumbent has no fresh same-size ladder reference.
                    return !previous || Math.abs(score.rate / previous.rate - 1) <= policy.stabilityThreshold;
                });
                const winner = this.choosePair(scores);
                this.selected = copy(winner.config);
                this.current = copy(this.selected);
                this.publishedRate = winner.rate;
                this.measurementStable = winner.stable;
                this.complete = true;
                // Noisy losing configurations do not invalidate independently confirmed finalists.
                this.stable = this.finalists.every(score => score.stable) && scores.every(score => score.stable) && agreement;
                if (this.stable) {
                    this.evidenceRevision = this.evidenceRevision < Number.MAX_SAFE_INTEGER ? this.evidenceRevision + 1 : 0;
                    this.incumbentEvidence = copy(this.selected);
                }
                this.cached = null;
                this.enterSteady(this.stable ? 'Complete, stable search comparison.'
                    : 'Comparison completed under changing load; the saved profile is unchanged.', winner.rate, at);
            }
        }

        /** A short cached check cannot replace complete historical evidence with a transient rate. */
        finishCachedCheck(score, at) {
            this.measurementStable = score.stable;
            const agrees = score.stable && Math.abs(score.rate / this.cached.rate - 1) < policy.driftThreshold;
            this.complete = agrees;
            this.stable = agrees;
            this.publishedRate = this.cached.rate;
            this.enterSteady(agrees ? 'Saved configuration checked; retaining its complete evidence.'
                : 'Saved configuration is being observed for sustained load changes.', this.cached.rate, at);
        }

        enterSteady(reason, baseline, at) {
            this.phase = 'steady';
            this.reason = reason;
            this.referenceRate = baseline;
            this.nextRecoveryAt = at + policy.recoveryCooldownMs;
            this.steadySamples = [];
            this.steadyObservation = null;
        }

        /** Reopen calibration on sustained improvement as well as degradation, never on one noisy batch. */
        observeSteady(rate, at) {
            const difference = rate / this.referenceRate - 1;
            const band = difference <= -policy.driftThreshold ? 'slower'
                : difference >= policy.driftThreshold ? 'faster' : 'baseline';
            this.steadySamples.push({ rate, at, band });
            if (this.steadySamples.length > policy.driftSamples) this.steadySamples.shift();
            const rates = this.steadySamples.map(sample => sample.rate);
            if (this.steadySamples.length < policy.driftSamples) return;
            const stableBand = this.steadySamples.every(sample => sample.band === band)
                && spread(rates) <= policy.stabilityThreshold;
            if (!stableBand) { this.steadyObservation = null; return; }
            if (!this.steadyObservation || this.steadyObservation.band !== band) {
                this.steadyObservation = { band, since: this.steadySamples[0].at };
            }
            if (at < this.nextRecoveryAt || at - this.steadyObservation.since < policy.driftMinMs) return;
            const drift = band !== 'baseline';
            if (this.cached && !drift) {
                // A transient mismatch disappeared; keep the old rate rather than publishing a new partial profile.
                this.complete = true;
                this.stable = true;
                this.measurementStable = true;
                this.reason = 'Saved configuration recovered after transient load.';
                return;
            }
            if (!drift && this.complete && this.stable) return;
            this.rechecks++;
            if (this.cached && drift) this.cacheRejected = true;
            this.nextRecoveryAt = at + policy.recoveryCooldownMs;
            this.cached = null;
            this.startCalibration();
            this.reason = drift ? 'Rechecking automatic selections after sustained throughput change.'
                : 'Rechecking incomplete stable evidence after the observation cooldown.';
        }

        /** Exclude only the failed pair; manual dimensions are never silently relaxed. */
        exclude(value, reason) {
            this.excluded.set(pairKey(value), String(reason || 'Configuration failed.'));
            this.cached = null;
            if (this.incumbentEvidence && pairKey(this.incumbentEvidence) === pairKey(value)) this.incumbentEvidence = null;
            const candidates = this.pairs(this.requested.batchSize === 'auto'
                ? config.BATCH_SIZES[0] : this.requested.batchSize);
            if (!candidates.length) throw new Error('No eligible UUID search configuration remains.');
            this.selected = copy(candidates[0]);
            this.startCalibration();
            this.reason = String(reason || 'Configuration excluded.');
        }

        /** The controller retries the same uncommitted range; the overflow ceiling is never grown past. */
        overflow(value) {
            if (this.requested.batchSize !== 'auto') throw new Error('Candidate overflow: reduce the manual batch size before resuming.');
            const smaller = config.BATCH_SIZES.filter(size => size < value.batchSize).at(-1);
            if (!smaller) throw new Error('Candidate overflow at the minimum automatic batch size.');
            this.batchCeiling = Math.min(this.batchCeiling, smaller);
            this.cached = null;
            if (this.incumbentEvidence?.batchSize > this.batchCeiling) this.incumbentEvidence = null;
            this.selected = this.fixed({ ...value, batchSize: smaller });
            this.startCalibration();
            this.current = copy(this.selected);
            this.reason = 'Retrying the uncommitted range below the candidate-buffer overflow ceiling.';
            return copy(this.current);
        }
    }

    const api = { Tuner };
    globalThis.CoreFlasherUuidTuner = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
