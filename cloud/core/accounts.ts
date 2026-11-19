import { tenantName } from '../../shared/values.ts';
import { conflict, invalid, quota } from './errors.ts';
import { randomSecret, sha256 } from './crypto.ts';
import type { PersonalAccount } from './model.ts';
import type { VerifiedIdentity } from './identity-contract.ts';
import type { StateStore } from './state.ts';

type IdentityLink = { identityKey: string; signupId: string; account: PersonalAccount; status: 'pending' | 'complete' };
export type AccountsState = { link: IdentityLink | null };
export type SignupCapacityState = { reservations: string[] };
export const initialAccountsState = (): AccountsState => ({ link: null });
export const initialSignupCapacityState = (): SignupCapacityState => ({ reservations: [] });

export class SignupCapacity {
  readonly #state: StateStore<SignupCapacityState>;
  readonly #limit: number;

  constructor(options: { state: StateStore<SignupCapacityState>; limit: number }) {
    if (!Number.isSafeInteger(options.limit) || options.limit < 0) throw new Error('Invalid signup capacity.');
    this.#state = options.state;
    this.#limit = options.limit;
  }

  async reserve(signupId: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(signupId)) invalid('Invalid signup reservation.');
    this.#state.update(state => {
      if (state.reservations.includes(signupId)) return;
      if (state.reservations.length >= this.#limit) quota('Registration capacity has been reached.');
      state.reservations.push(signupId);
    });
  }
}

export class Accounts {
  readonly #state: StateStore<AccountsState>;
  readonly #capacity: { reserve(signupId: string): Promise<void> };
  readonly #ensureOwner: (account: PersonalAccount) => Promise<unknown>;

  constructor(options: {
    state: StateStore<AccountsState>;
    capacity: { reserve(signupId: string): Promise<void> };
    ensureOwner: (account: PersonalAccount) => Promise<unknown>;
  }) {
    this.#state = options.state;
    this.#capacity = options.capacity;
    this.#ensureOwner = options.ensureOwner;
  }

  async register(identity: VerifiedIdentity): Promise<PersonalAccount> {
    if (!identity || typeof identity.provider !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/.test(identity.provider)
      || typeof identity.subject !== 'string' || identity.subject.length < 1 || identity.subject.length > 200
      || /[\u0000-\u001f\u007f]/.test(identity.subject)
      || typeof identity.name !== 'string' || identity.name.length < 1 || identity.name.length > 200) {
      invalid('Invalid verified identity.');
    }
    const identityKey = await sha256(JSON.stringify([identity.provider, identity.subject]));
    const link = this.#state.update(state => {
      if (state.link) {
        if (state.link.identityKey !== identityKey) conflict('The account directory belongs to another identity.');
        return state.link;
      }
      const account = { userId: crypto.randomUUID(), tenant: tenantName(`t${randomSecret().slice(0, 16)}`), name: identity.name };
      const created: IdentityLink = { identityKey, signupId: randomSecret(), account, status: 'pending' };
      state.link = created;
      return created;
    });
    if (link.status === 'complete') return link.account;
    await this.#capacity.reserve(link.signupId);
    await this.#ensureOwner(link.account);
    return this.#state.update(state => {
      if (!state.link || state.link.identityKey !== identityKey) throw new Error('Account intent disappeared.');
      state.link.status = 'complete';
      return state.link.account;
    });
  }
}
