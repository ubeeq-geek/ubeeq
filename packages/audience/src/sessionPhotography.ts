import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PhotographyBooking, PhotographyGallery, PhotographyRepository, PhotographyState } from './types.js';
import { PhotographyError } from './errors.js';

export const photographyInitial = (): PhotographyState => ({
  revision: 0,
  enabled: false,
  timezone: 'UTC',
  packages: [],
  slots: [],
  bookings: [],
  galleries: [],
  challenges: [],
  sessions: [],
  requests: [],
});

export const photographyEmail = (value: unknown): string => {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (normalized.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new PhotographyError(422, 'Enter a valid email address.');
  }
  return normalized;
};

const hash = (s: string) => createHash('sha256').update(s).digest('hex');

const equal = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const photographyGalleryActive = (g: PhotographyGallery, now: number) =>
  g.active && (!g.expiresAt || Date.parse(g.expiresAt) > now);

export class SessionPhotographyService {
  constructor(
    readonly repository: PhotographyRepository,
    private sendEmail: (email: string, subject: string, message: string) => Promise<void>,
    private now = Date.now
  ) {}

  async state(id: string): Promise<PhotographyState> {
    return (await this.repository.get(id)) ?? photographyInitial();
  }

  async mutate<T>(id: string, fn: (state: PhotographyState) => T): Promise<T> {
    for (let retry = 0; ; retry++) {
      const state = await this.state(id);
      const expected = state.revision;
      const now = this.now();
      state.challenges = state.challenges.filter((c) => c.expires > now);
      state.sessions = state.sessions.filter((s) => s.expires > now);
      state.requests = state.requests.filter((r) => r.at > now - 3600000);
      const result = fn(state);
      state.revision++;
      try {
        await this.repository.save(id, state, expected);
        return result;
      } catch (error) {
        if (!(error instanceof PhotographyError) || error.status !== 409 || retry >= 3) {
          throw error;
        }
      }
    }
  }

  async requestCode(id: string, emailValue: unknown, scope: string, ip: string) {
    const email = photographyEmail(emailValue);
    const now = this.now();
    const code = String(randomInt(100000, 1000000));
    const challengeId = randomUUID();
    let eligible = false;

    await this.mutate(id, (state) => {
      if (!state.enabled) {
        throw new PhotographyError(404, 'Session photography is unavailable.');
      }
      const emailHash = hash(email);
      const ipHash = hash(ip);
      if (
        state.requests.filter((r) => r.emailHash === emailHash).length >= 5 ||
        state.requests.some((r) => r.emailHash === emailHash && r.at > now - 60000) ||
        state.requests.filter((r) => r.ipHash === ipHash).length >= 20 ||
        state.challenges.length >= 200
      ) {
        throw new PhotographyError(429, 'Please wait before requesting another code.');
      }
      eligible =
        scope === 'booking' ||
        (scope === 'client-list' && state.galleries.some((g) => photographyGalleryActive(g, now) && g.emails.includes(email))) ||
        state.galleries.some((g) => g.id === scope && photographyGalleryActive(g, now) && g.emails.includes(email));
      state.requests.push({ emailHash, ipHash, at: now });
      state.challenges = state.challenges.filter((c) => !(c.email === email && c.scope === scope));
      state.challenges.push({
        id: challengeId,
        email,
        scope,
        digest: hash(challengeId + code),
        expires: now + 600000,
        attempts: 0,
        eligible,
      });
    });

    if (eligible) {
      try {
        await this.sendEmail(
          email,
          'Your client access code',
          `Your one-time code is ${code}. It expires in 10 minutes. If you did not request this code, ignore this email.`
        );
      } catch {
        await this.mutate(id, (state) => {
          state.challenges = state.challenges.filter((c) => c.id !== challengeId);
        });
        throw new PhotographyError(503, 'The code could not be delivered. Please try again later.');
      }
    }

    return {
      challengeId,
      message: 'If this email can access the requested service, a code has been sent. It expires in 10 minutes.',
    };
  }

  async verifyCode(id: string, challengeId: string, code: string) {
    const token = randomBytes(32).toString('base64url');
    const valid = await this.mutate(id, (state) => {
      if (!state.enabled) return false;
      const c = state.challenges.find((item) => item.id === challengeId);
      if (!c || c.attempts >= 5) return false;
      c.attempts++;
      if (!/^\d{6}$/.test(code) || !equal(c.digest, hash(challengeId + code)) || !c.eligible) {
        return false;
      }
      if (c.scope === 'client-list' && !state.galleries.some((g) => photographyGalleryActive(g, this.now()) && g.emails.includes(c.email))) {
        return false;
      }
      if (
        !['booking', 'client-list'].includes(c.scope) &&
        !state.galleries.some((g) => g.id === c.scope && photographyGalleryActive(g, this.now()) && g.emails.includes(c.email))
      ) {
        return false;
      }
      state.challenges = state.challenges.filter((item) => item.id !== c.id);
      state.sessions.push({ digest: hash(token), email: c.email, scope: c.scope, expires: this.now() + 3600000 });
      return true;
    });

    if (!valid) {
      throw new PhotographyError(401, 'The code is invalid or expired. Request a new code if needed.');
    }
    return { token, expiresAt: new Date(this.now() + 3600000).toISOString() };
  }

  session(state: PhotographyState, token: string, scope: string) {
    const s = state.sessions.find((sess) => sess.scope === scope && sess.expires > this.now() && equal(sess.digest, hash(token)));
    if (!state.enabled || !s) {
      throw new PhotographyError(401, 'Sign in with a new email code to continue.');
    }
    return s;
  }

  async gallery(id: string, galleryId: string, token: string): Promise<PhotographyGallery> {
    const state = await this.state(id);
    const sess = this.session(
      state,
      token,
      state.sessions.some((s) => s.scope === 'client-list' && s.digest === hash(token)) ? 'client-list' : galleryId
    );
    const gall = state.galleries.find((g) => g.id === galleryId && photographyGalleryActive(g, this.now()) && g.emails.includes(sess.email));
    if (!gall) {
      throw new PhotographyError(403, 'This gallery is no longer available to this email address.');
    }
    return gall;
  }

  async book(id: string, token: string, input: { slotId?: unknown; name?: unknown; notes?: unknown }): Promise<PhotographyBooking> {
    return this.mutate(id, (state) => {
      const sess = this.session(state, token, 'booking');
      const slot = state.slots.find((s) => s.id === input.slotId);
      if (!slot || Date.parse(slot.startsAt) <= this.now()) {
        throw new PhotographyError(409, 'This time is no longer available.');
      }
      if (state.bookings.some((b) => b.slotId === slot.id && b.status !== 'cancelled')) {
        throw new PhotographyError(409, 'This time has already been requested. Choose another time.');
      }
      if (
        typeof input.name !== 'string' ||
        !input.name.trim() ||
        input.name.length > 200 ||
        (typeof input.notes !== 'string' && input.notes !== undefined) ||
        String(input.notes ?? '').length > 2000
      ) {
        throw new PhotographyError(422, 'Enter your name and notes of up to 2,000 characters.');
      }
      if (state.bookings.filter((b) => b.email === sess.email && b.status !== 'cancelled').length >= 10) {
        throw new PhotographyError(429, 'Please contact the photographer before requesting more sessions.');
      }
      if (state.bookings.length >= 500) {
        throw new PhotographyError(422, 'Booking capacity has been reached. Please contact the photographer.');
      }
      const booking: PhotographyBooking = {
        id: randomUUID(),
        slotId: slot.id,
        email: sess.email,
        name: input.name.trim(),
        notes: String(input.notes ?? ''),
        status: 'requested',
        createdAt: new Date(this.now()).toISOString(),
      };
      state.bookings.push(booking);
      return booking;
    });
  }

  async logout(id: string, token: string): Promise<void> {
    await this.mutate(id, (state) => {
      state.sessions = state.sessions.filter((s) => !equal(s.digest, hash(token)));
    });
  }
}
