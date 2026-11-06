import { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { CollectionSlideshowPanel } from '@ubeeq/ui/react';
import { CollectionSlideshowClient } from '@ubeeq/ui';

interface Collection { id: string; title: string; revision: number; workIds: string[] }
interface Catalogue { collections: Collection[]; works: { id: string; title: string }[]; music: { assetId: string; title: string }[]; slideshowEnabled: boolean }
function Collections() {
  const [token] = useState(() => localStorage.getItem('ubeeq.reference.token') ?? '');
  const client = useMemo(() => new CollectionSlideshowClient(() => token), [token]);
  const [catalogue, setCatalogue] = useState<Catalogue>(), [id, setId] = useState(''), [order, setOrder] = useState<string[]>([]);
  const [title, setTitle] = useState('My image collection'), [message, setMessage] = useState(''), [busy, setBusy] = useState(false);
  const collection = catalogue?.collections.find(c => c.id === id);
  const dirty = JSON.stringify(order) !== JSON.stringify(collection?.workIds ?? []);
  const api = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch('/api/v1/' + path, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), cache: 'no-store', redirect: 'error' });
    const result = await response.json(); if (!response.ok) throw new Error(result.error?.message ?? 'Collection operation failed.'); return result;
  };
  useEffect(() => { let active = true; if (token) void api('collections').then((result: Catalogue) => { if (active) { setCatalogue(result); setId(result.collections[0]?.id ?? ''); setOrder(result.collections[0]?.workIds ?? []); } }).catch(error => { if (active) setMessage(error.message); }); return () => { active = false; }; }, [token]);
  const create = async () => {
    setBusy(true);
    try { const result = await api('collections', 'POST', { title }); const next = { ...result.collection, workIds: [] }; setCatalogue(current => current && { ...current, collections: [...current.collections, next] }); setId(next.id); setOrder([]); setMessage('Collection created. Add image Works in order.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not create collection.'); } finally { setBusy(false); }
  };
  const save = async () => {
    if (!collection) return;
    setBusy(true);
    try { const result = await api(`collections/${encodeURIComponent(id)}/works`, 'PUT', { workIds: order, expectedRevision: collection.revision }); setCatalogue(current => current && { ...current, collections: current.collections.map(c => c.id === id ? { ...result.collection, workIds: result.workIds } : c) }); setMessage('Collection order saved.'); }
    catch (error) { setMessage(error instanceof Error ? error.message : 'Could not save collection.'); } finally { setBusy(false); }
  };
  const move = (index: number, direction: number) => { const next = [...order]; [next[index], next[index + direction]] = [next[index + direction], next[index]]; setOrder(next); };
  if (!token) return <p><a href="/workspace">Sign in and create a creator profile</a> to manage collections.</p>;
  return <><h1>Image collections</h1><p>Arrange image Works and optionally create a downloadable slideshow video.</p><p role="status">{message}</p>
    <fieldset disabled={busy}><legend>Choose a collection</legend>
      <label>Collection<select value={id} onChange={event => { const next = catalogue?.collections.find(c => c.id === event.target.value); setId(next?.id ?? ''); setOrder(next?.workIds ?? []); }}><option value="">Choose a collection</option>{catalogue?.collections.map(c => <option key={c.id} value={c.id}>{c.title}</option>)}</select></label>
      <label>New collection title<input value={title} onChange={event => setTitle(event.target.value)}/></label><button onClick={() => void create()} disabled={!catalogue || !title.trim()}>Create collection</button>
    </fieldset>
    {collection && <><fieldset disabled={busy}><legend>Image order</legend><p>Each Work’s images appear in upload order. Use JPEG, PNG or WebP images.</p>
      <ol>{order.map((workId, index) => <li key={workId}>{catalogue?.works.find(w => w.id === workId)?.title ?? workId} <button disabled={index === 0} onClick={() => move(index, -1)} aria-label={`Move image Work ${index + 1} earlier`}>↑</button> <button disabled={index === order.length - 1} onClick={() => move(index, 1)} aria-label={`Move image Work ${index + 1} later`}>↓</button> <button onClick={() => setOrder(order.filter(w => w !== workId))}>Remove</button></li>)}</ol>
      <label>Add image Work<select value="" onChange={event => { if (event.target.value) setOrder([...order, event.target.value]); }}><option value="">Choose a Work</option>{catalogue?.works.filter(w => !order.includes(w.id)).map(w => <option key={w.id} value={w.id}>{w.title}</option>)}</select></label>
      <button disabled={!dirty} onClick={() => void save()}>Save image order</button>
    </fieldset><CollectionSlideshowPanel key={id} collectionId={id} client={client} music={catalogue?.music ?? []} enabled={catalogue?.slideshowEnabled ?? false} disabled={dirty || busy}/></>}
  </>;
}
const root = document.getElementById('collections'); if (root) createRoot(root).render(<Collections/>);
