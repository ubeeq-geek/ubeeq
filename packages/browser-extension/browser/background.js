import { browserApi, state, request, inspect } from './client.js';
// A checkpoint is stored before scheduling; alarms survive popup closure and worker suspension.
async function advance() {
  const connection = await state();
  if (!connection?.jobId || !connection.tabId) return;
  try {
    const tab = await browserApi.tabs.get(connection.tabId);
    if ((tab.cookieStoreId || 'default') !== connection.containerId) throw new Error('The browser container changed. Select the confirmed source again.');
    const observed = await inspect(tab.id);
    if (observed.provider !== connection.source.provider || observed.accountId !== connection.source.accountId)
      throw new Error('The source changed. Return to your confirmed source and choose Resume.');
    const result = await request(connection, `/jobs/${connection.jobId}/step`, { source: observed, profileId: connection.profileId });
    const latest = await state();
    if (latest?.jobId !== connection.jobId || latest?.token !== connection.token) return;
    await browserApi.storage.local.set({ connection: { ...latest, progress: result, error: null } });
    if (result.remaining && !['cancelled', 'waiting_for_authorization', 'waiting_for_browser'].includes(result.state))
      await browserApi.alarms.create('import', { when: Date.now() + 1500 });
  } catch (error) {
    try { await request(connection, `/jobs/${connection.jobId}/pause`, { state: 'waiting_for_browser' }); } catch {}
    const latest = await state();
    if (latest?.jobId === connection.jobId && latest?.token === connection.token)
      await browserApi.storage.local.set({ connection: { ...latest, error: error.message } });
  }
}
browserApi.alarms.onAlarm.addListener(alarm => { if (alarm.name === 'import') void advance(); });
browserApi.runtime.onStartup.addListener(() => { void state().then(connection => { if (connection?.jobId) return browserApi.alarms.create('import', { when: Date.now() + 1000 }); }); });
browserApi.runtime.onMessage.addListener(message => {
  if (message?.type === 'resume') { void browserApi.alarms.create('import', { when: Date.now() + 100 }); }
});
