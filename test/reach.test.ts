import { describe, expect, it } from 'vitest';
import { callSites, changedExported, definitionOn, filesOf } from '../src/reach.js';

const diff = [
  'diff --git a/src/fee.ts b/src/fee.ts',
  '--- a/src/fee.ts',
  '+++ b/src/fee.ts',
  '@@ -10,4 +10,4 @@ export function calculateFee(amount: number) {',
  '   const base = amount * rate;',
  '-  return base;',
  '+  return base / 100;',
  ' }',
  '@@ -30,3 +30,4 @@ function helperOnly() {',
  '+  x();',
  'diff --git a/pkg/limits.go b/pkg/limits.go',
  '--- a/pkg/limits.go',
  '+++ b/pkg/limits.go',
  '@@ -1,3 +1,5 @@',
  ' func MaxRetries() int {',
  '-  return 3',
  '+  return 5',
  ' }',
  ' func helper() {}',
  'diff --git a/app/models.py b/app/models.py',
  '--- a/app/models.py',
  '+++ b/app/models.py',
  '@@ -1,2 +1,3 @@',
  '+def _private_thing(x):',
  '+def public_thing(x):',
  '+    return x',
].join('\n');

describe('cross-file reach', () => {
  it('finds the exported functions a patch changes, by a changed line or the hunk that encloses it', () => {
    expect(changedExported(diff).map((d) => `${d.file}:${d.name}`)).toEqual(['src/fee.ts:calculateFee', 'pkg/limits.go:MaxRetries', 'app/models.py:public_thing']);
  });
  it('reads definitions by each language’s convention, and not statements', () => {
    expect(definitionOn('export const toCents = (x: number) => x * 100;', 'ts')).toEqual({ name: 'toCents', exported: true });
    expect(definitionOn('pub fn parse_header(x: &str) -> u32 {', 'rs')).toEqual({ name: 'parse_header', exported: true });
    expect(definitionOn('fn private_one() {', 'rs')).toEqual({ name: 'private_one', exported: false });
    expect(definitionOn('    public static int computeTotal(List<Item> items) {', 'jvm')).toEqual({ name: 'computeTotal', exported: true });
    expect(definitionOn('        return computeTotal(items);', 'jvm')).toBeNull();
    expect(definitionOn('fun formatAmount(cents: Long): String {', 'jvm')).toEqual({ name: 'formatAmount', exported: true });
    expect(definitionOn('  if (ready) {', 'ts')).toBeNull();
  });
  it('counts call sites in files the patch didn’t change, of the same language, and not the definition', () => {
    const grep = [
      'abc1234:src/billing.ts:88:  const f = calculateFee(total);',
      'abc1234:src/billing.ts:90:  log(calculateFee (x));',
      'abc1234:src/fee.ts:10:export function calculateFee(amount: number) {',
      'abc1234:src/other.ts:3:export function calculateFee(a: number) {',
      'abc1234:docs/api.md:4:calculateFee(1)',
      'abc1234:src/names.ts:2:const precalculateFee = 1; precalculateFee(2)',
      'abc1234:pkg/x.go:7:  n := MaxRetries()',
      'abc1234:src/view.tsx:5:  return <calculateFee amount={1} />;',
    ].join('\n');
    const got = callSites(grep, [{ name: 'calculateFee', family: 'ts' }, { name: 'MaxRetries', family: 'go' }], filesOf(diff));
    expect(got).toEqual({ sites: 4, files: 3, perName: { calculateFee: 3, MaxRetries: 1 } });
  });
});
