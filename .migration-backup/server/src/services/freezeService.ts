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

    async freezeGlobal(reason: string, actor: string): Promise<FreezeState> {
        const state: FreezeState = {
            isFrozen: true,
            reason,
            frozenAt: new Date(),
            updatedBy: actor,
        };
        cache.set(this.GLOBAL_KEY, state);
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
        const state: FreezeState = {
            isFrozen: true,
            reason,
            frozenAt: new Date(),
            updatedBy: actor,
        };
        cache.set(`${this.PROTOCOL_PREFIX}${protocol.toLowerCase()}`, state);
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
}

export const freezeService = new FreezeService();
