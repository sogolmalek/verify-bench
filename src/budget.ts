/**
 * The two budgets (the design, 40.4, 40.5; V-4): the frontier part in dollars, on its own ledger, outside the $10 measurement
 * cap; and the open-weight part in Nosana credits. Every call reserves its worst case first, so a budget can't be crossed.
 * The run stops at either: without one part, arm C can't be scored.
 */
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import type { Budget } from './models.js';

export type LedgerLine = { kind: 'budget'; budget: Budget; total: number; by: string } | { kind: 'reserve' | 'settle' | 'release'; id: string; budget: Budget; amount: number; label?: string };

export class BudgetRefused extends Error {}

export class Budgets {
  private readonly totals = new Map<Budget, number>();
  private readonly settled = new Map<Budget, number>();
  private readonly reserved = new Map<string, { budget: Budget; amount: number }>();
  private seq = 0;

  /** With a path, every line is appended there, and an earlier run's lines are read back first. */
  constructor(private readonly path?: string) {
    if (path && existsSync(path)) for (const l of readFileSync(path, 'utf8').split('\n').filter(Boolean)) this.apply(JSON.parse(l) as LedgerLine);
  }

  private apply(l: LedgerLine) {
    if (l.kind === 'budget') this.totals.set(l.budget, l.total);
    else if (l.kind === 'reserve') this.reserved.set(l.id, { budget: l.budget, amount: l.amount });
    else {
      this.reserved.delete(l.id);
      if (l.kind === 'settle') this.settled.set(l.budget, (this.settled.get(l.budget) ?? 0) + l.amount);
    }
  }

  private write(l: LedgerLine) {
    this.apply(l);
    if (this.path) appendFileSync(this.path, `${JSON.stringify(l)}\n`);
  }

  /** Only the owner states a budget; a run without one spends nothing. */
  state(budget: Budget, total: number, by: string) {
    this.write({ kind: 'budget', budget, total, by });
  }

  remaining(budget: Budget): number {
    const held = [...this.reserved.values()].filter((r) => r.budget === budget).reduce((s, r) => s + r.amount, 0);
    return (this.totals.get(budget) ?? 0) - (this.settled.get(budget) ?? 0) - held;
  }

  spent(budget: Budget): number {
    return this.settled.get(budget) ?? 0;
  }

  /** Reserves a call's worst case, or refuses before the call is made. */
  reserve(budget: Budget, worstCase: number, label?: string): string {
    if (worstCase > this.remaining(budget)) throw new BudgetRefused(`${budget}: ${worstCase.toFixed(4)} would cross what is left, ${this.remaining(budget).toFixed(4)}`);
    const id = `r${++this.seq}-${Date.now().toString(36)}`;
    this.write({ kind: 'reserve', id, budget, amount: worstCase, ...(label ? { label } : {}) });
    return id;
  }

  /** Replaces a reservation with what the call cost. */
  settle(id: string, actual: number) {
    const r = this.reserved.get(id);
    if (!r) throw new Error(`no reservation ${id}`);
    this.write({ kind: 'settle', id, budget: r.budget, amount: actual });
  }

  /** A call that failed before any charge. */
  release(id: string) {
    const r = this.reserved.get(id);
    if (!r) throw new Error(`no reservation ${id}`);
    this.write({ kind: 'release', id, budget: r.budget, amount: 0 });
  }

  /** Whether a whole next task fits in both budgets: the run goes one whole task at a time (40.5). */
  affords(need: Partial<Record<Budget, number>>): boolean {
    return Object.entries(need).every(([b, n]) => (n as number) <= this.remaining(b as Budget));
  }
}
