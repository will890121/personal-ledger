import type { UserFromGetMe } from "grammy/types";

import type { LedgerRepository } from "../ports/ledger-repository.js";
import type { ReferenceRepository } from "../ports/reference-repository.js";
import type { SummaryRepository } from "../ports/summary-repository.js";

export interface LedgerBotDependencies {
  readonly token: string;
  readonly ownerId: string;
  readonly repository: LedgerRepository;
  readonly referenceRepository: ReferenceRepository;
  readonly summaryRepository: SummaryRepository;
  readonly generateId: () => string;
  readonly now: () => Date;
  readonly today: () => string;
  readonly botInfo?: UserFromGetMe;
}
