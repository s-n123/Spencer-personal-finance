import type { Db } from "@/server/db/types";
import { AppError } from "@/server/errors";
import type { MediaStorage } from "@/server/media/storage/types";
import type { Clock } from "@/server/time";
import { SimulatorAdapter } from "./simulator/adapter";
import type { AdapterRegistry, ChannelAdapter, Provider } from "./types";

// Builds the provider -> adapter map. M1 has only the simulator; Sendblue joins in M6.

export interface RegistryDeps {
  db: Db;
  storage: MediaStorage;
  clock: Clock;
}

export function createRegistry(deps: RegistryDeps): AdapterRegistry {
  const adapters = new Map<Provider, ChannelAdapter>([
    ["simulator", new SimulatorAdapter(deps.db, deps.storage, deps.clock)],
  ]);
  return {
    get(provider) {
      const adapter = adapters.get(provider);
      if (!adapter) throw new AppError("channel_not_configured");
      return adapter;
    },
  };
}
