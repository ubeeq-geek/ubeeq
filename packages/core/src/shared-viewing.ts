/** Shared viewing coordinates clients; it does not relay media or grant content access. */
export interface ViewingItem { workId: string; kind: 'image' | 'audio' | 'video'; durationSeconds?: number }
export interface ViewingRoom {
  roomId: string; hostId: string; revision: number;
  items: readonly ViewingItem[]; index: number; playing: boolean;
  positionSeconds: number; updatedAtMs: number; expiresAtMs: number; closed: boolean;
}
/** Store and authorization must be bound to the same instance/cell. */
export interface ViewingStore {
  create(room: ViewingRoom): Promise<boolean>;
  get(roomId: string): Promise<ViewingRoom | null>;
  /** Atomic conditional write. Never implement as an unprotected read then write. */
  compareAndSwap(room: ViewingRoom, expectedRevision: number): Promise<boolean>;
}
export interface ViewingAccess {
  /** Check sharing eligibility, current host permissions and create quotas. */
  canHost(actorId: string, items: readonly ViewingItem[]): Promise<boolean>;
  /** Check invitation/room admission AND entitlement, age and visibility of every item.
   * A room ID or invitation alone must not grant media access. Rechecked on every read.
   */
  canView(actorId: string, room: ViewingRoom): Promise<boolean>;
}
export type ViewingAction = { type: 'play' | 'pause' | 'close' } |
  { type: 'seek'; positionSeconds: number } | { type: 'select'; index: number };
export class ViewingError extends Error {
  constructor(readonly code: 'denied' | 'invalid' | 'conflict', message: string) { super(message); this.name = 'ViewingError'; }
}
const deny = (): never => { throw new ViewingError('denied', 'Viewing session unavailable.'); };
const invalid = (): never => { throw new ViewingError('invalid', 'Invalid viewing request.'); };
const validId = (value: string) => typeof value === 'string' && value.trim().length > 0 && value.length <= 256;
/** serverNowMs must use the server clock, or the client's measured server clock offset. */
export function viewingPosition(room: ViewingRoom, serverNowMs: number): number {
  if (!Number.isFinite(serverNowMs)) return invalid();
  const elapsed = room.playing && !room.closed ? Math.max(0, Math.min(serverNowMs, room.expiresAtMs) - room.updatedAtMs) / 1000 : 0;
  return Math.min(room.items[room.index].durationSeconds ?? 0, room.positionSeconds + elapsed);
}
export class SharedViewingService {
  constructor(private readonly store: ViewingStore, private readonly access: ViewingAccess,
    private readonly now: () => number = Date.now) {}
  private clock(): number {
    const now = this.now();
    if (!Number.isSafeInteger(now) || now < 0) return invalid();
    return now;
  }
  async create(actorId: string, roomId: string, items: readonly ViewingItem[], ttlSeconds = 7200): Promise<ViewingRoom> {
    if (!validId(actorId) || !validId(roomId) || !Array.isArray(items) || items.length < 1 || items.length > 100 ||
      !Number.isInteger(ttlSeconds) || ttlSeconds < 60 || ttlSeconds > 86400) return invalid();
    const selected = structuredClone(items);
    for (const item of selected) {
      if (!item || !validId(item.workId) || !['image', 'audio', 'video'].includes(item.kind) ||
        (item.kind === 'image' ? item.durationSeconds !== undefined :
          !Number.isFinite(item.durationSeconds) || item.durationSeconds! <= 0 || item.durationSeconds! > 86400)) return invalid();
    }
    if (!await this.access.canHost(actorId, structuredClone(selected))) return deny();
    const now = this.clock();
    const room: ViewingRoom = { roomId, hostId: actorId, revision: 0, items: selected, index: 0, playing: false,
      positionSeconds: 0, updatedAtMs: now, expiresAtMs: now + ttlSeconds * 1000, closed: false };
    if (!await this.store.create(structuredClone(room))) throw new ViewingError('conflict', 'Session ID already exists.');
    return structuredClone(room);
  }
  private async admitted(actorId: string, roomId: string): Promise<ViewingRoom> {
    if (!validId(actorId) || !validId(roomId)) return deny();
    const stored = await this.store.get(roomId);
    if (!stored || stored.roomId !== roomId) return deny();
    const room = structuredClone(stored);
    if (room.closed || room.expiresAtMs <= this.clock() || !await this.access.canView(actorId, structuredClone(room))) return deny();
    return room;
  }
  async read(actorId: string, roomId: string): Promise<{ room: ViewingRoom; serverNowMs: number; positionSeconds: number }> {
    const room = await this.admitted(actorId, roomId);
    const serverNowMs = this.clock();
    if (room.expiresAtMs <= serverNowMs) return deny();
    return { room, serverNowMs, positionSeconds: viewingPosition(room, serverNowMs) };
  }
  async control(actorId: string, roomId: string, expectedRevision: number, input: ViewingAction): Promise<ViewingRoom> {
    const action = structuredClone(input);
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !action ||
      !['play', 'pause', 'close', 'seek', 'select'].includes(action.type)) return invalid();
    const room = await this.admitted(actorId, roomId);
    if (room.hostId !== actorId || !await this.access.canHost(actorId, structuredClone(room.items))) return deny();
    if (room.revision !== expectedRevision) throw new ViewingError('conflict', 'Refresh the session before controlling playback.');
    const now = this.clock();
    if (room.expiresAtMs <= now) return deny();
    room.positionSeconds = viewingPosition(room, now);
    if (action.type === 'select') {
      if (!Number.isInteger(action.index) || action.index < 0 || action.index >= room.items.length) return invalid();
      room.index = action.index; room.positionSeconds = 0; room.playing = false;
    } else if (action.type === 'seek') {
      if (room.items[room.index].kind === 'image' || !Number.isFinite(action.positionSeconds) ||
        action.positionSeconds < 0 || action.positionSeconds > room.items[room.index].durationSeconds!) return invalid();
      room.positionSeconds = action.positionSeconds;
    } else if (action.type === 'play') {
      if (room.items[room.index].kind === 'image') return invalid();
      room.playing = true;
    } else { room.playing = false; if (action.type === 'close') room.closed = true; }
    room.updatedAtMs = now; room.revision++;
    if (!await this.store.compareAndSwap(structuredClone(room), expectedRevision)) throw new ViewingError('conflict', 'Session changed; refresh and retry.');
    return structuredClone(room);
  }
}
