import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { CommerceError, type MemberAccount, type CommerceMemberAccount } from '@ubeeq/commerce';
import type { createCommerceRuntime } from './runtime.js';
import { resolveStorefrontAccountConfig, type StorefrontBrandConfig } from './brandConfig.js';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');

const derive = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scrypt(password, salt, 64, (error, key) => (error ? reject(error) : resolve(key)))
  );

export interface CustomerAccountUserProfile {
  userId: string;
  username: string;
  displayName?: string;
  status?: 'active' | 'inactive';
}

export interface CustomerAccountIdentityProvider {
  getUser?(email: string): Promise<{ userId: string; emailVerified: boolean; passwordSetupRequired: boolean } | null>;
  createUser?(email: string): Promise<{ userId: string }>;
  setPassword?(userId: string, password: string): Promise<void>;
  verifyPassword?(email: string, password: string): Promise<boolean>;
  changePassword?(userId: string, current: string, next: string): Promise<void>;
}

export interface CustomerAccountConfiguration {
  tenantId: string;
  brand?: StorefrontBrandConfig;
  getUserProfile?(userId: string): Promise<CustomerAccountUserProfile | undefined>;
  upsertUserProfile?(profile: CustomerAccountUserProfile): Promise<void>;
  identityProvider?: CustomerAccountIdentityProvider;
}

export function createCustomerAccounts(
  config: CustomerAccountConfiguration,
  runtime: ReturnType<typeof createCommerceRuntime>
) {
  const db = runtime.store;
  const brandConfig = config.brand;
  const accountConfig = resolveStorefrontAccountConfig(brandConfig);

  const localProfiles = new Map<string, CustomerAccountUserProfile>();

  const idFor = (email: string) =>
    hash(accountConfig.idHashNamespace + email.trim().toLowerCase());

  const usernameFor = (userId: string) =>
    accountConfig.idPrefix + hash(userId).slice(0, 16);

  const getProfile = async (userId: string): Promise<CustomerAccountUserProfile | undefined> => {
    if (config.getUserProfile) {
      return config.getUserProfile(userId);
    }
    return localProfiles.get(userId);
  };

  const upsertProfile = async (profile: CustomerAccountUserProfile): Promise<void> => {
    if (config.upsertUserProfile) {
      await config.upsertUserProfile(profile);
      return;
    }
    localProfiles.set(profile.userId, profile);
  };

  const find = async (userId: string) =>
    db.transaction((tx) => tx.list('memberAccount').find((a) => a.userId === userId));

  const active = async (userId: string) => {
    const profile = await getProfile(userId);
    if (profile?.status === 'inactive') {
      throw new CommerceError('account_inactive', 403);
    }
  };

  const dto = async (account: MemberAccount): Promise<CommerceMemberAccount> => {
    await active(account.userId);
    const profile = await getProfile(account.userId);
    const username = profile?.username ?? usernameFor(account.userId);
    const displayName = profile?.displayName ?? username;
    return {
      userId: account.userId,
      username,
      displayName,
      email: account.email,
      passwordSetupRequired: account.passwordSetupRequired,
    };
  };

  const ensureProfile = async (account: MemberAccount) => {
    const existing = await getProfile(account.userId);
    if (existing) {
      await active(account.userId);
      return;
    }
    const username = usernameFor(account.userId);
    await upsertProfile({
      userId: account.userId,
      username,
      displayName: username,
      status: 'active',
    });
    await active(account.userId);
  };

  const provision = async (input: { email: string; commerceSubjectId: string }) => {
    const email = input.email.trim().toLowerCase();
    const id = idFor(email);

    let account = await db.transaction((tx) => tx.get('memberAccount', id));

    if (!account) {
      const userId = randomUUID();
      const now = new Date().toISOString();
      const candidate: MemberAccount = {
        id,
        deploymentId: config.tenantId,
        ownerId: accountConfig.ownerId,
        environment: 'live',
        createdAt: now,
        updatedAt: now,
        userId,
        email,
        commerceSubjectId: input.commerceSubjectId,
        provider: 'local',
        passwordSetupRequired: true,
      };

      account = await db.transaction((tx) => {
        const existing = tx.get('memberAccount', id);
        if (existing) return existing;
        if (tx.list('memberAccount').some((a) => a.userId === userId)) {
          throw new CommerceError('account_identity_conflict', 409);
        }
        tx.insert('memberAccount', candidate);
        return candidate;
      });
    }

    await ensureProfile(account);
    await runtime.service.attachAccountCustomer(account.commerceSubjectId, account.userId, account.email);
    const profileDto = await dto(account);
    return {
      ...profileDto,
      commerceSubjectId: account.commerceSubjectId,
    };
  };

  const session = async (credential: string) => {
    const value = await runtime.service.accountSession(credential);
    if (!value) return undefined;
    const account = await find(value.userId);
    if (!account || account.commerceSubjectId !== value.commerceSubjectId) return undefined;
    await active(account.userId);
    return { ...value, account };
  };

  const accountForSession = async (credential: string) => {
    const value = await session(credential);
    if (!value) throw new CommerceError('authentication_required', 401);
    return dto(value.account);
  };

  const setPassword = async (credential: string, password: unknown) => {
    const value = await session(credential);
    if (!value) throw new CommerceError('authentication_required', 401);
    if (Date.now() - Date.parse(value.issuedAt) > 900000) {
      throw new CommerceError('fresh_sign_in_required', 403);
    }
    if (typeof password !== 'string' || password.length < 12 || password.length > 128) {
      throw new CommerceError('password_requirements', 400);
    }

    await db.withLock(
      { deploymentId: config.tenantId, ownerId: 'member:' + value.userId, environment: 'live' },
      async () => {
        const account = await find(value.userId);
        if (!account?.passwordSetupRequired) {
          throw new CommerceError('password_already_set', 409);
        }

        const salt = randomBytes(24).toString('hex');
        const passwordHash = salt + ':' + (await derive(password, salt)).toString('hex');

        await db.transaction((tx) => {
          const current = tx.get('memberAccount', account.id);
          if (!current || !current.passwordSetupRequired) {
            throw new CommerceError('password_already_set', 409);
          }
          tx.put('memberAccount', {
            ...current,
            passwordSetupRequired: false,
            passwordHash,
            updatedAt: new Date().toISOString(),
          });
        });
      }
    );

    return accountForSession(credential);
  };

  const passwordSignIn = async (address: unknown, password: unknown) => {
    if (typeof address !== 'string' || typeof password !== 'string' || address.length > 254 || password.length > 128) {
      throw new CommerceError('invalid_credentials', 401);
    }
    const email = address.trim().toLowerCase();
    await runtime.service.rateLimit(hash(email), 'customer_password_login', 5, 900);

    const account = await db.transaction((tx) => tx.get('memberAccount', idFor(email)));
    const [salt, expected] = account?.passwordHash?.split(':') ?? ['dummy-salt', '00'.repeat(64)];
    const actual = await derive(password, salt);

    if (
      !account ||
      !account.passwordHash ||
      actual.length !== Buffer.from(expected, 'hex').length ||
      !timingSafeEqual(actual, Buffer.from(expected, 'hex'))
    ) {
      throw new CommerceError('invalid_credentials', 401);
    }

    await active(account.userId);
    const result = await runtime.service.issueAccountSession(account.commerceSubjectId, account.userId);
    return { ...result, account: await dto(account) };
  };

  const changePassword = async (credential: string, current: unknown, next: unknown) => {
    const value = await session(credential);
    if (!value) throw new CommerceError('authentication_required', 401);
    if (typeof current !== 'string' || current.length > 128 || typeof next !== 'string' || next.length < 12 || next.length > 128) {
      throw new CommerceError('password_requirements', 400);
    }

    await runtime.service.rateLimit(hash(value.userId), 'customer_password_change', 5, 900);

    await db.withLock(
      { deploymentId: config.tenantId, ownerId: 'member:' + value.userId, environment: 'live' },
      async () => {
        const account = await find(value.userId);
        if (!account || account.passwordSetupRequired) {
          throw new CommerceError('password_setup_required', 409);
        }

        const [salt, expected] = account.passwordHash?.split(':') ?? ['dummy-salt', '00'.repeat(64)];
        const actual = await derive(current, salt);
        if (
          !account.passwordHash ||
          actual.length !== Buffer.from(expected, 'hex').length ||
          !timingSafeEqual(actual, Buffer.from(expected, 'hex'))
        ) {
          throw new CommerceError('invalid_credentials', 401);
        }

        const newSalt = randomBytes(24).toString('hex');
        const passwordHash = newSalt + ':' + (await derive(next, newSalt)).toString('hex');

        await db.transaction((tx) => {
          const record = tx.get('memberAccount', account.id)!;
          tx.put('memberAccount', { ...record, passwordHash, updatedAt: new Date().toISOString() });
          for (const other of tx.list('session')) {
            if (other.accountUserId === value.userId && other.id !== credential.split('.')[0]) {
              tx.remove('session', other.id);
            }
          }
        });
      }
    );

    return { changed: true };
  };

  const commerceSubjectForAuth = async (user: { userId: string; email?: string; emailVerified?: boolean }) => {
    await active(user.userId);
    const existing = await find(user.userId);
    if (existing) return existing.commerceSubjectId;
    if (!user.emailVerified || !user.email) return user.userId;

    const email = user.email.trim().toLowerCase();
    const id = idFor(email);
    const prior = await db.transaction((tx) =>
      tx.list('customer').filter((c) => !c.erasedAt && c.verifiedEmails.includes(email))
    );
    if (prior.length > 1) throw new CommerceError('account_identity_conflict', 409);

    const now = new Date().toISOString();
    const candidate: MemberAccount = {
      id,
      deploymentId: config.tenantId,
      ownerId: accountConfig.ownerId,
      environment: 'live',
      createdAt: now,
      updatedAt: now,
      userId: user.userId,
      email,
      commerceSubjectId: prior[0]?.subjectId ?? user.userId,
      provider: 'local',
      providerUsername: email,
      passwordSetupRequired: false,
    };

    const account = await db.transaction((tx) => {
      const record = tx.get('memberAccount', id);
      if (record) {
        if (record.userId !== user.userId) throw new CommerceError('account_identity_conflict', 409);
        return record;
      }
      tx.insert('memberAccount', candidate);
      return candidate;
    });

    await ensureProfile(account);
    await runtime.service.attachAccountCustomer(account.commerceSubjectId, user.userId, email);
    return account.commerceSubjectId;
  };

  const issueVerifiedLocalSession = async (user: { userId: string; email?: string; displayName?: string }) => {
    const email = (user.email ?? '').trim().toLowerCase();
    const id = idFor(email || user.userId);
    let account = await db.transaction((tx) => tx.get('memberAccount', id));
    if (!account) {
      const now = new Date().toISOString();
      const candidate: MemberAccount = {
        id,
        deploymentId: config.tenantId,
        ownerId: accountConfig.ownerId,
        environment: 'live',
        createdAt: now,
        updatedAt: now,
        userId: user.userId,
        email: email || `${user.userId}@localhost`,
        commerceSubjectId: user.userId,
        provider: 'local',
        passwordSetupRequired: false,
      };
      account = await db.transaction((tx) => {
        const existing = tx.get('memberAccount', id);
        if (existing) return existing;
        tx.insert('memberAccount', candidate);
        return candidate;
      });
    }

    await ensureProfile(account);
    const result = await runtime.service.issueAccountSession(account.commerceSubjectId, account.userId);
    return { ...result, account: await dto(account) };
  };

  return {
    provision,
    session,
    accountForSession,
    setPassword,
    passwordSignIn,
    changePassword,
    commerceSubjectForAuth,
    issueVerifiedLocalSession,
    resolveConfig: () => accountConfig,
  };
}
