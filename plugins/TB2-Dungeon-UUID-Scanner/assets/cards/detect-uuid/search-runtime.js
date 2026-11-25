/* Shared, bounded WebGPU session. Kernel selection does not change traversal or acceptance. */
(() => {
    'use strict';
    const config = typeof CoreFlasherUuidConfig !== 'undefined' ? CoreFlasherUuidConfig
        : require('../../uuid-search-config.js');
    const MAX_HITS = 256;
    const ALGORITHMS = config.KERNEL_IDS;

    /** Adapt one literal entry-point workgroup without changing the default baseline bytes. */
    function specializeWorkgroup(code, workgroupSize = config.DEFAULTS.workgroupSize) {
        if (typeof code !== 'string' || !config.WORKGROUP_SIZES.includes(workgroupSize)) {
            throw new Error('Invalid shader workgroup configuration.');
        }
        const annotations = [...code.matchAll(/@workgroup_size\(\s*(\d+)u?\s*\)/g)];
        if (annotations.length !== 1) throw new Error('Expected exactly one literal shader workgroup size.');
        if (Number(annotations[0][1]) === workgroupSize) return code;
        return code.replace(annotations[0][0], `@workgroup_size(${workgroupSize})`);
    }

    class CandidateOverflowError extends Error {
        constructor(count) {
            super(`GPU returned ${count} candidates (limit ${MAX_HITS}). Resume with a smaller batch size.`);
            this.name = 'CandidateOverflowError';
        }
    }

    /** Split a safe-integer cursor at the GPU's 32-bit prefix boundary. */
    function nextBatch(next, endExclusive, unknownCount, batchSize) {
        if (![next, endExclusive, batchSize].every(Number.isSafeInteger)
            || next < 0 || next > endExclusive || endExclusive > 16 ** unknownCount
            || unknownCount < 1 || unknownCount > 10 || batchSize < 1) {
            throw new Error('Invalid UUID search range.');
        }
        if (next === endExclusive) return null;
        const gpuRange = 16 ** Math.min(unknownCount, 8);
        const prefix = Math.floor(next / gpuRange);
        const low = next % gpuRange;
        return { prefix, low, count: Math.min(batchSize, gpuRange - low, endExclusive - next), gpuRange };
    }

    /** Reject malformed encrypted input before requesting an adapter or compiling a shader. */
    function validateBlob(parsed, salt, info) {
        if (!Number.isInteger(parsed?.padding) || parsed.padding < 1 || parsed.padding > 16
            || parsed.iv?.length !== 16 || parsed.ciphertext?.length < 16
            || parsed.ciphertext.length % 16 !== 0 || salt?.length !== 16 || info?.length !== 16) {
            throw new Error('Invalid encrypted file: expected 1–16 padding bytes, a 16-byte IV and complete AES blocks.');
        }
    }

    /** Own one device and its buffers; an old run can only dispose its own resources. */
    class Session {
        constructor(device, adapterInfo) {
            this.device = device;
            this.adapterInfo = adapterInfo;
            this.disposed = false;
            this.buffers = [];
            this.failure = null;
            this.workgroupSize = config.DEFAULTS.workgroupSize;
            this.pipelineCache = new Map();
            this.compiling = false;
            this.failed = new Promise(resolve => { this.fail = resolve; });
            // Resolve a failure signal instead of leaving an unobserved rejecting promise.
            device.lost.then(info => {
                if (!this.disposed) this.markFailed(new Error(`WebGPU device lost: ${info.message || info.reason}`));
            });
            this.onError = event => this.markFailed(new Error(`WebGPU error: ${event.error.message}`));
            device.addEventListener('uncapturederror', this.onError);
            const buffer = (size, usage) => {
                const result = device.createBuffer({ size, usage });
                this.buffers.push(result);
                return result;
            };
            this.uniform = buffer(16, GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST);
            this.hits = buffer((MAX_HITS + 1) * 4, GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST);
            this.readback = buffer((MAX_HITS + 1) * 4, GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ);
            this.layout = device.createBindGroupLayout({ entries: [
                { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
                { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } }
            ] });
            this.bindGroup = device.createBindGroup({ layout: this.layout, entries: [
                { binding: 0, resource: { buffer: this.uniform } },
                { binding: 1, resource: { buffer: this.hits } }
            ] });
        }

        static async create() {
            if (!navigator.gpu) throw new Error('WebGPU is not available in this browser.');
            const adapter = await navigator.gpu.requestAdapter();
            if (!adapter) throw new Error('No WebGPU adapter found.');
            const device = await adapter.requestDevice();
            try {
                const info = adapter.info || {};
                return new Session(device, { vendor: info.vendor || '', architecture: info.architecture || '',
                    description: info.description || '', isFallbackAdapter: !!info.isFallbackAdapter });
            } catch (error) { device.destroy(); throw error; }
        }

        markFailed(error) { this.failure = error; this.fail(error); }
        assertReady() {
            if (this.failure) throw this.failure;
            if (this.disposed) throw new Error('WebGPU session closed.');
        }
        async wait(operation) {
            const result = await Promise.race([operation, this.failed.then(error => { throw error; })]);
            this.assertReady();
            return result;
        }

        /** Compile a bounded, run-owned variant cache without mutating an in-flight dispatch. */
        async compile(code, workgroupSize = config.DEFAULTS.workgroupSize, cacheKey = null) {
            this.assertReady();
            if (this.busy || this.compiling) throw new Error('Cannot change a GPU pipeline while it is busy.');
            if (!config.WORKGROUP_SIZES.includes(workgroupSize)
                || workgroupSize > this.device.limits.maxComputeWorkgroupSizeX
                || workgroupSize > this.device.limits.maxComputeInvocationsPerWorkgroup) {
                throw new Error('Workgroup size exceeds the supported GPU limits.');
            }
            if (typeof code !== 'string' || (cacheKey !== null && typeof cacheKey !== 'string')) {
                throw new Error('Invalid GPU pipeline source or cache key.');
            }
            const declaredWorkgroup = code.match(/@workgroup_size\(\s*(\d+)u?\s*\)/);
            if (declaredWorkgroup && Number(declaredWorkgroup[1]) !== workgroupSize) {
                throw new Error('Shader workgroup size does not match the dispatch configuration.');
            }
            const cached = cacheKey === null ? null : this.pipelineCache.get(cacheKey);
            if (cached && cached.code === code && cached.workgroupSize === workgroupSize) {
                this.pipelineCache.delete(cacheKey);
                this.pipelineCache.set(cacheKey, cached);
                this.pipeline = cached.pipeline;
                this.workgroupSize = workgroupSize;
                return this.pipeline;
            }
            this.compiling = true;
            let pipeline;
            try {
                // Scope parser/pipeline validation so compilation diagnostics stay the primary error.
                this.device.pushErrorScope('validation');
                let validationError;
                try {
                    const shader = this.device.createShaderModule({ code });
                    const diagnostics = await this.wait(shader.getCompilationInfo());
                    const errors = diagnostics.messages.filter(message => message.type === 'error');
                    if (errors.length) throw new Error('WGSL compile error: ' + errors.map(error => error.message).join('; '));
                    pipeline = await this.wait(this.device.createComputePipelineAsync({
                        layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.layout] }),
                        compute: { module: shader, entryPoint: 'main' }
                    }));
                } finally { validationError = await this.device.popErrorScope(); }
                if (validationError) throw new Error('WebGPU pipeline validation failed: ' + validationError.message);
                this.assertReady();
                if (cacheKey !== null) {
                    this.pipelineCache.delete(cacheKey);
                    this.pipelineCache.set(cacheKey, { code, workgroupSize, pipeline });
                    while (this.pipelineCache.size > config.MAX_PIPELINES) {
                        this.pipelineCache.delete(this.pipelineCache.keys().next().value);
                    }
                }
                this.pipeline = pipeline;
                this.workgroupSize = workgroupSize;
                return pipeline;
            } finally { this.compiling = false; }
        }

        /** Submit each uniform update before the next chunk; never accept a truncated hit set. */
        async run(batchStart, batchCount, fixedWord0 = 0, fixedWord1 = 0) {
            this.assertReady();
            if (this.busy || this.compiling) throw new Error('A GPU batch or pipeline preparation is already running.');
            if (!Number.isSafeInteger(batchStart) || !Number.isSafeInteger(batchCount)
                || batchStart < 0 || batchCount < 1 || batchStart + batchCount > 2 ** 32) {
                throw new Error('GPU batch crosses its 32-bit prefix boundary.');
            }
            this.busy = true;
            let mapped = false;
            try {
                const { device } = this;
                const maxCount = device.limits.maxComputeWorkgroupsPerDimension * this.workgroupSize;
                device.queue.writeBuffer(this.hits, 0, new Uint32Array([0]));
                for (let offset = 0; offset < batchCount;) {
                    const count = Math.min(batchCount - offset, maxCount);
                    const uniform = new Uint32Array([batchStart + offset, count, fixedWord0, fixedWord1]);
                    device.queue.writeBuffer(this.uniform, 0, uniform);
                    const encoder = device.createCommandEncoder();
                    const pass = encoder.beginComputePass();
                    pass.setPipeline(this.pipeline);
                    pass.setBindGroup(0, this.bindGroup);
                    pass.dispatchWorkgroups(Math.ceil(count / this.workgroupSize));
                    pass.end();
                    device.queue.submit([encoder.finish()]);
                    offset += count;
                }
                // Read all counters while mapped, copy before unmapping, and fail closed on overflow.
                const encoder = device.createCommandEncoder();
                encoder.copyBufferToBuffer(this.hits, 0, this.readback, 0, (MAX_HITS + 1) * 4);
                device.queue.submit([encoder.finish()]);
                await this.wait(this.readback.mapAsync(GPUMapMode.READ));
                mapped = true;
                const words = new Uint32Array(this.readback.getMappedRange());
                if (words[0] > MAX_HITS) throw new CandidateOverflowError(words[0]);
                return Array.from(words.slice(1, words[0] + 1)).sort((left, right) => left - right);
            } finally {
                if (mapped && !this.disposed) this.readback.unmap();
                this.busy = false;
            }
        }

        dispose() {
            if (this.disposed) return;
            this.disposed = true;
            this.markFailed(new Error('WebGPU session closed.'));
            this.device.removeEventListener('uncapturederror', this.onError);
            this.pipelineCache.clear();
            this.pipeline = null;
            for (const buffer of this.buffers) buffer.destroy();
            this.device.destroy();
        }
    }
    const api = { Session, nextBatch, validateBlob, specializeWorkgroup, CandidateOverflowError, ALGORITHMS, MAX_HITS };
    globalThis.CoreFlasherUuidSearch = api;
    if (typeof module !== 'undefined') module.exports = api;
})();
