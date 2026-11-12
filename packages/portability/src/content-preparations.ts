import { captureContentPreset, validateContentObjects, validateContentPreparation, type ContentWorkflowDraft, type ContentUnitPreset } from '@ubeeq/core';
export interface ContentPreparationArchive {
    schemaVersion: 1;
    drafts: ContentWorkflowDraft[];
    presets: ContentUnitPreset[];
    destinationBindingsRequireReview: true;
}
function portableAnnouncement(value: ContentWorkflowDraft['settings']['announce']): ContentWorkflowDraft['settings']['announce'] {
    const result = structuredClone(value);
    result.destinationIds = [];
    result.mode = result.mode === 'off' ? 'off' : 'draft';
    const clearBindings = (template: typeof result.template) => { if (template) {
        delete template.destinationOverrides;
        delete template.destinationCustomizations;
    } return template; };
    result.template = clearBindings(result.template);
    if (result.timing?.mode === 'at_time')
        result.timing = { mode: 'after_publication', timeZone: result.timing.civilTime.timeZone };
    if (result.followUp) {
        result.followUp.destinationIds = [];
        result.followUp.template = clearBindings(result.followUp.template);
        if (result.followUp.timing.mode === 'at_time')
            result.followUp.timing = { mode: 'delay_after_parent', durationMs: 86400000, timeZone: result.followUp.timing.civilTime.timeZone, anchor: { mode: 'corresponding_destination' } };
    }
    // A restored preparation requires fresh destination selection before follow-ups can be activated.
    delete result.followUp;
    delete result.followUpDelayMs;
    return result;
}
/** Private draft history is portable; accepted review/send authority and storage capabilities are not. */
export function portableContentPreparations(drafts: readonly ContentWorkflowDraft[], presets: readonly ContentUnitPreset[]): ContentPreparationArchive {
    return { schemaVersion: 1, destinationBindingsRequireReview: true, drafts: drafts.filter(d => d.state !== 'cancelled').map(source => {
            const draft = structuredClone(source);
            delete draft.review;
            draft.state = 'draft';
            draft.actorId = 'restore-required';
            draft.operationIds = [];
            draft.settings.releaseTime = undefined;
            draft.settings.publishDestinations = draft.settings.publishDestinations.map(d => ({ ...d, connectionId: undefined, targetId: undefined }));
            draft.settings.announce = portableAnnouncement(draft.settings.announce);
            return draft;
        }), presets: presets.map(source => { const preset = captureContentPreset({ ...source, settings: { ...source.settings, publishDestinations: source.settings.publishDestinations.map(d => ({ ...d, connectionId: undefined, targetId: undefined })), announce: portableAnnouncement(source.settings.announce) } }); return { ...preset, isDefault: false, archived: source.archived }; }) };
}
export function validateContentPreparationArchive(value: unknown, scope: {
    tenantId: string;
    creatorId: string;
}, references?: {
    workIds: ReadonlySet<string>;
    collectionIds: ReadonlySet<string>;
}): ContentPreparationArchive {
    const archive = value as ContentPreparationArchive;
    if (!archive || archive.schemaVersion !== 1 || archive.destinationBindingsRequireReview !== true || !Array.isArray(archive.drafts) || !Array.isArray(archive.presets) || archive.drafts.length > 1000 || archive.presets.length > 1000 || new Set(archive.drafts.map(d => d.id)).size !== archive.drafts.length || new Set(archive.presets.map(p => `${p.id}:${p.revision}`)).size !== archive.presets.length)
        throw Error('Invalid preparation archive.');
    for (const draft of archive.drafts) {
        if (!draft || draft.creatorId !== scope.creatorId || draft.tenantId !== scope.tenantId || draft.schemaVersion !== 1 || typeof draft.id !== 'string' || !Number.isSafeInteger(draft.revision) || draft.revision < 1 || !Array.isArray(draft.units) || !Array.isArray(draft.previews) || draft.review || draft.state !== 'draft')
            throw Error('Invalid portable preparation.');
        validateContentObjects(draft.objects);
        validateContentPreparation(draft.settings);
        for (const ref of [...draft.units, ...(draft.entry.target ? [draft.entry.target] : [])])
            if (references && !(ref.kind === 'work' ? references.workIds : references.collectionIds).has(ref.id))
                throw Error('Preparation references missing content.');
    }
    for (const preset of archive.presets) {
        if (preset.creatorId !== scope.creatorId)
            throw Error('Foreign portable preset.');
        captureContentPreset(preset);
    }
    return portableContentPreparations(archive.drafts, archive.presets);
}
