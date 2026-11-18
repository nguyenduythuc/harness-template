// Task budget (docs/plan.md, "Budget", B9). One budget covers the executor and every R session of a task.
// The Claude Code cap is a client-side estimate and can pass the limit by about one response, so the
// orchestrator keeps headroom, and parallel sessions share the remainder instead of each taking all of it.

import type { Usage } from "./runs.js";
import { totalTokens } from "./runs.js";

export class Budget {
  spentUsd = 0;
  spentTokens = 0;
  stopped = false;

  constructor(
    readonly limitUsd: number,
    readonly limitTokens: number,
    readonly headroomUsd: number,
  ) {}

  remainingUsd(): number {
    return Math.max(0, this.limitUsd - this.spentUsd);
  }

  remainingTokens(): number {
    return Math.max(0, this.limitTokens - this.spentTokens);
  }

  /**
   * USD cap for each of `concurrent` sessions that start now: (remaining - headroom) / concurrent.
   * Returns 0 when nothing is left; the caller must not start a session with a cap of 0.
   */
  allocate(concurrent: number): number {
    if (concurrent < 1) throw new Error("concurrent must be 1 or more");
    const usable = this.remainingUsd() - this.headroomUsd;
    return usable > 0 ? usable / concurrent : 0;
  }

  record(costUsd: number, usage: Usage): void {
    this.spentUsd += costUsd;
    this.spentTokens += totalTokens(usage);
    if (this.spentUsd >= this.limitUsd || this.spentTokens >= this.limitTokens) this.stopped = true;
  }

  /** True when a new session cannot start: no money above the headroom, or no tokens left. */
  exhausted(): boolean {
    return this.stopped || this.allocate(1) <= 0 || this.remainingTokens() <= 0;
  }
}
