import type {ContentPreparationStore} from './content-preparation.js';

/** The retained host's canonical rows, preparation records and outbox share one
 * accepting transaction. Await all operations. Nested failures abort its owner;
 * an inherited callback cannot reuse a closing or completed scope. */
export interface RetainedContentAtomic<P> extends ContentPreparationStore {
 active():boolean;
 savePublication(value:P):Promise<void>;
 close?():void;
}
