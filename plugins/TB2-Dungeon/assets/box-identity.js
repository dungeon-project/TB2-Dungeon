/** Box identifiers describe one profile; they are never calculated from each other. */
'use strict';
class BoxIdentity {
    static SERIAL_LIMIT = 64;
    static FIELDS = ['boxSerialNumber', 'uuid', 'flashChipId'];
    static serial(value) {
        if (value === undefined || value === '') return '';
        if (typeof value !== 'string' || /[\x00-\x1f\x7f-\x9f]/.test(value) || value.trim().length > this.SERIAL_LIMIT)
            throw new Error('Invalid box serial number. Use at most 64 characters without control characters.');
        return value.trim();
    }
    /** Include all observed fields: a second identifier must not silently contradict the first. */
    static resolve(profiles, observed = {}) {
        const values = profiles.map(profile => profile.value || profile);
        const matches = new Set();
        for (const field of this.FIELDS) {
            if (!observed[field]) continue;
            const found = values.filter(profile => profile[field] === observed[field]);
            if (found.length > 1) throw new Error(`Multiple boxes share this ${field}. Review Box details.`);
            found.forEach(profile => matches.add(profile));
        }
        if (observed.boxId) values.filter(profile => profile.id === observed.boxId || profile.tcId === observed.boxId)
            .forEach(profile => matches.add(profile));
        if (matches.size > 1) throw new Error('Box identifiers refer to different boxes. Review Box details.');
        const box = [...matches][0] || null;
        if (box && observed.boxId && observed.boxId !== box.id && observed.boxId !== box.tcId)
            throw new Error('Image assignment and observed box identifiers do not match.');
        if (box && this.FIELDS.some(field => observed[field] && box[field] && observed[field] !== box[field]))
            throw new Error('Observed identifiers do not match the saved box profile.');
        // Reject duplicate identifiers belonging to this match, even when another field found it.
        if (box && this.FIELDS.some(field => box[field] && values.some(other => other !== box && other[field] === box[field])))
            throw new Error('This box has a duplicate identifier. Review Box details.');
        return box;
    }
    static assertUnique(profiles) {
        for (const field of ['id', 'tcId', ...this.FIELDS]) {
            const values = profiles.map(profile => (profile.value || profile)[field]).filter(Boolean);
            if (new Set(values).size !== values.length) throw new Error(`Duplicate box ${field}. Review the conflicting profiles.`);
        }
    }
}
if (typeof module !== 'undefined') module.exports = { BoxIdentity };
if (typeof window !== 'undefined') window.BoxIdentity = BoxIdentity;
