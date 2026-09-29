import type { GymConfig } from './config/gym.js';
import type { Pool } from './db/pool.js';
import type { Outbox } from './services/outbox.js';
import type { Logger } from './utils/logger.js';

/** Everything services need, passed explicitly so it can be swapped in tests. */
export interface AppContext {
  pool: Pool;
  config: GymConfig;
  adminPhones: string[];
  outbox: Outbox;
  logger: Logger;
  now: () => Date;
}
