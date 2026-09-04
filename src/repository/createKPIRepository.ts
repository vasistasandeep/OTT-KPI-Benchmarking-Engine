/**
 * Boot factory that returns a ready `KPIDataRepository`, degrading gracefully
 * to in-memory storage when IndexedDB cannot be used.
 *
 * On boot it attempts to open the Dexie/IndexedDB database. If the open throws
 * — which is how incognito / private-browsing modes and quota-denied
 * environments manifest — it catches the exception and falls back to the
 * in-memory `Map` adapter, which implements the full `KPIDataRepository`
 * interface so nothing downstream changes. In that case `persistent` is
 * `false` and `advisory` carries a message the UI renders as a banner warning
 * that data will not persist across sessions (incognito fallback; Req 3.1).
 *
 * Requirements: 3.1, 3.3 (restore on reopen when persistence is available).
 */

import { DexieKPIRepository } from "./DexieKPIRepository";
import { InMemoryKPIRepository } from "./InMemoryKPIRepository";
import type { KPIDataRepository } from "./KPIDataRepository";
import type { RepositoryOptions } from "./support";

/** Result of booting the repository, including whether storage persists. */
export interface RepositoryBootResult {
  repository: KPIDataRepository;
  /** True when backed by IndexedDB; false when degraded to in-memory storage. */
  persistent: boolean;
  /** UI advisory to display as a banner when persistence is unavailable. */
  advisory?: string;
}

const INCOGNITO_ADVISORY =
  "Private browsing detected: this session's data is kept in memory only and " +
  "will not persist after you close or reload the page.";

export interface CreateRepositoryOptions extends RepositoryOptions {
  /** Override the IndexedDB database name (used by tests for isolation). */
  databaseName?: string;
  /**
   * Force the in-memory adapter without attempting IndexedDB. Primarily for
   * tests and for exercising the degraded path deliberately.
   */
  forceInMemory?: boolean;
}

export async function createKPIRepository(
  options: CreateRepositoryOptions = {},
): Promise<RepositoryBootResult> {
  if (options.forceInMemory) {
    return {
      repository: new InMemoryKPIRepository(options),
      persistent: false,
      advisory: INCOGNITO_ADVISORY,
    };
  }

  try {
    const repository = await DexieKPIRepository.open(options);
    return { repository, persistent: true };
  } catch (cause) {
    // IndexedDB open (or an early quota check) failed — typical of incognito
    // mode. Degrade to in-memory storage and advise the user (Req 3.1).
    options.onNotify?.({
      level: "warning",
      operation: "open persistent storage",
      message: INCOGNITO_ADVISORY,
      cause,
    });
    return {
      repository: new InMemoryKPIRepository(options),
      persistent: false,
      advisory: INCOGNITO_ADVISORY,
    };
  }
}
