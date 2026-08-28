import NodeCache from "node-cache";

// Using NodeCache for persistence during runtime. In production, this would be in Redis/Postgres.
const cache = new NodeCache();

export interface FreezeState {
    isFrozen: boolean;
    reason?: string;
    frozenAt?: Date;
    updatedBy?: string;
}

export class FreezeService {
    private GLOBAL_KEY = "freeze:global";
    private PROTOCOL_PREFIX = "freeze:protocol:";
    private GLOBAL_LAST_FROZEN_KEY = "freeze:last:global";
    private PROTOCOL_LAST_PREFIX = "freeze:last:protocol:";

    async freezeGlobal(reason: string, actor: string): Promise<FreezeState> {
        const now = new Date();
        const state: FreezeState = {
            isFrozen: true,
            reason,
            frozenAt: now,
            updatedBy: actor,
        };
        cache.set(this.GLOBAL_KEY, state);
        cache.set(this.GLOBAL_LAST_FROZEN_KEY, now);
        return state;
    }

    async resumeGlobal(actor: string): Promise<FreezeState> {
        const state: FreezeState = {
            isFrozen: false,
            updatedBy: actor,
        };
        cache.set(this.GLOBAL_KEY, state);
        return state;
    }

    async freezeProtocol(protocol: string, reason: string, actor: string): Promise<FreezeState> {
        const now = new Date();
        const state: FreezeState = {
            isFrozen: true,
            reason,
            frozenAt: now,
            updatedBy: actor,
        };
        cache.set(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`, state);
        cache.set(`${this.PROTOCOL_LAST_PREFIX}${protocol.toLowerCase()}`, now);
        return state;
    }

    async resumeProtocol(protocol: string, actor: string): Promise<FreezeState> {
        const state: FreezeState = {
            isFrozen: false,
            updatedBy: actor,
        };
        cache.set(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`, state);
        return state;
    }

    isFrozen(protocol?: string): boolean {
        const globalState = cache.get<FreezeState>(this.GLOBAL_KEY);
        if (globalState?.isFrozen) return true;

        if (protocol) {
            const protocolState = cache.get<FreezeState>(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`);
            if (protocolState?.isFrozen) return true;
        }

        return false;
    }

    getFreezeStatus(protocol?: string): FreezeState {
        const globalState = cache.get<FreezeState>(this.GLOBAL_KEY);
        if (globalState?.isFrozen) return globalState;

        if (protocol) {
            const protocolState = cache.get<FreezeState>(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`);
            if (protocolState) return protocolState;
        }

        return { isFrozen: false };
    }

    getLastFrozenAt(protocol?: string): Date | undefined {
        if (protocol) {
            const protocolLast = cache.get<Date>(`${this.PROTOCOL_LAST_PREFIX}${protocol.toLowerCase()}`);
            if (protocolLast) return protocolLast;
        }
        const globalLast = cache.get<Date>(this.GLOBAL_LAST_FROZEN_KEY);
        return globalLast;
    }

    /**
     * Returns true if a quote created at `quotedAtIso` is invalidated because
     * a global or protocol-specific freeze happened after the quote was created.
     * Also returns true if the protocol is currently frozen — the caller should
     * treat any pending quote as stale until unfreeze + requote.
     */
    isQuoteInvalidatedByFreeze(quotedAtIso: string, protocol?: string): boolean {
        const quotedAtMs = new Date(quotedAtIso).getTime();
        if (Number.isNaN(quotedAtMs)) return true;

        // If currently frozen, any pending quote is considered invalid.
        if (this.isFrozen(protocol)) {
            return true;
        }

        const globalLast = cache.get<Date>(this.GLOBAL_LAST_FROZEN_KEY);
        if (globalLast && globalLast.getTime() > quotedAtMs) {
            return true;
        }

        if (protocol) {
            const protocolLast = cache.get<Date>(`${this.PROTOCOL_LAST_PREFIX}${protocol.toLowerCase()}`);
            if (protocolLast && protocolLast.getTime() > quotedAtMs) {
                return true;
            }
        }

        return false;
    }

    /** Test helper: clear all freeze state */
    clearAll(): void {
        cache.flushAll();
    }
}

export const freezeService = new FreezeService();
