/**
 * Risk patterns and decisions per repository, written before any run, only from that repository's own public sources, each
 * with its source pinned to a commit (the design, 40.2.6; V-20). They are frozen in the pre-registration.
 *
 * None of the five has a CODEOWNERS file. Where a repository has published security advisories, those name the paths that
 * have been its risk, so they are the source; that goes beyond the sources V-20 lists, and is flagged for the owner. A repository
 * with no source for a rule has no pattern for it, and the gap is stated rather than filled with a guess.
 */
import type { RepoConfig, Source } from './decisions.js';

const HONO = '61f7c59e50244ab4d2dd83c151928cf7ea448510';
const ZOD = '19c40d2072288b4cafec851e9d056a72a88e5973';
const PYDANTIC = 'dabcc6461dafa4337c52faf3e9941431ea41ce4a';
const CLICK = '8abb77a8432e03ed14a95f972b44f905279415a7';
const PYTEST = '171c924acfd66d03ab51d08da2509461da6233a7';

const advisories = (repo: string, ids: string[], what: string): Source => ({ url: ids.map((id) => `https://github.com/${repo}/security/advisories/${id}`).join(' '), what });
const doc = (repo: string, sha: string, path: string, line: number, what: string): Source => ({ url: `https://github.com/${repo}/blob/${sha}/${path}#L${line}`, what });

const h = (ids: string[], what: string) => advisories('honojs/hono', ids, what);
const p = (ids: string[], what: string) => advisories('pydantic/pydantic', ids, what);

export const REPOS: readonly RepoConfig[] = [
  {
    repo: 'honojs/hono',
    sourcesAt: HONO,
    language: 'TypeScript',
    riskPatterns: [
      { glob: 'src/middleware/jwt/**', source: h(['GHSA-f67f-6cw9-8mq4', 'GHSA-f577-qrjj-4474'], 'JWT middleware: algorithm confusion, any Authorization scheme') },
      { glob: 'src/middleware/jwk/**', source: h(['GHSA-3vhc-576x-3qv4'], 'JWK middleware: algorithm confusion') },
      { glob: 'src/utils/jwt/**', source: h(['GHSA-hm8q-7f3q-5f36', 'GHSA-m732-5p4w-x69g'], 'JWT verification: claims validation, authorization') },
      { glob: 'src/middleware/basic-auth/**', source: h(['GHSA-gq3j-xvxp-8hrf'], 'timing comparison in basic auth') },
      { glob: 'src/middleware/bearer-auth/**', source: h(['GHSA-gq3j-xvxp-8hrf'], 'timing comparison in bearer auth') },
      { glob: 'src/middleware/csrf/**', source: h(['GHSA-46wx-v44x-9hh2', 'GHSA-2234-fmw7-43wr', 'GHSA-rpfr-3m35-5vx5'], 'CSRF middleware bypasses') },
      { glob: 'src/middleware/cors/**', source: h(['GHSA-8j4g-w8fx-2239', 'GHSA-88fw-hqm2-52qc', 'GHSA-q7jf-gf43-6x6p'], 'CORS: ReDoS, reflected origin, Vary injection') },
      { glob: 'src/middleware/body-limit/**', source: h(['GHSA-rv63-4mwf-qqc2', 'GHSA-9vqf-7f2p-gf9v', 'GHSA-92vj-g62v-jqhh'], 'body limit bypasses') },
      { glob: 'src/middleware/ip-restriction/**', source: h(['GHSA-xrhx-7g5j-rcj5', 'GHSA-xpcf-pg52-r92g'], 'IP restriction bypasses') },
      { glob: 'src/utils/ipaddr.ts', source: h(['GHSA-r354-f388-2fhh'], 'IPv4 validation bypass') },
      { glob: 'src/middleware/cache/**', source: h(['GHSA-p77w-8qqv-26rm', 'GHSA-6wqw-2p9w-4vw4'], 'cross-user cache leakage') },
      { glob: 'src/middleware/language/**', source: h(['GHSA-54fx-42gc-7vw4'], 'algorithmic complexity DoS') },
      { glob: 'src/middleware/serve-static/**', source: h(['GHSA-5r4p-p66f-jhc7', 'GHSA-wmmm-f939-6g9c', 'GHSA-q5qw-h33p-qvwr'], 'serveStatic: middleware bypass, arbitrary file access') },
      { glob: '**/serve-static*', source: h(['GHSA-wwfh-h76j-fc44', 'GHSA-w332-q679-j88p', 'GHSA-3mpf-rcc7-5347'], 'runtime adapters of serveStatic: path traversal, key read') },
      { glob: 'src/helper/cookie/**', source: h(['GHSA-3hrh-pfw6-9m5x', 'GHSA-26pp-8wgv-hjvm', 'GHSA-5pq2-9x2x-5p6w'], 'Set-Cookie injection') },
      { glob: 'src/utils/cookie.ts', source: h(['GHSA-r5rp-j6wh-rvv4'], 'cookie name handling') },
      { glob: 'src/helper/ssg/**', source: h(['GHSA-gqvv-2mrq-wpjv', 'GHSA-xf4j-xp2r-rqqx'], 'toSSG path traversal') },
      { glob: 'src/helper/proxy/**', source: h(['GHSA-79qm-7rj5-m7r9'], 'proxy header handling') },
      { glob: 'src/helper/css/**', source: h(['GHSA-3gg2-335m-rxc6'], 'css helper escaping') },
      { glob: 'src/helper/streaming/**', source: h(['GHSA-p6xx-57qc-3wxr'], 'SSE control field injection') },
      { glob: 'src/adapter/aws-lambda/**', source: h(['GHSA-xh87-mx6m-69f3', 'GHSA-j6c9-x7qj-28xf', 'GHSA-xgm2-5f3f-mvvc'], 'Lambda adapter: IP spoofing, header handling') },
      { glob: 'src/adapter/lambda-edge/**', source: h(['GHSA-wgpf-jwqj-8h8p'], 'Lambda@Edge header handling') },
      { glob: 'src/jsx/**', source: h(['GHSA-hxh3-vqpv-xpqv', 'GHSA-f23p-vx2j-j53r', 'GHSA-w62v-xxxg-mg59', 'GHSA-458j-xx4x-4375'], 'JSX: XSS and cross-request data disclosure') },
      { glob: 'src/validator/**', source: h(['GHSA-4h7h-rv7c-7m2v'], 'validation skipped for multipart') },
      { glob: 'src/router/reg-exp-router/**', source: h(['GHSA-h7mg-cq63-vhpq'], 'RegExpRouter skips middleware') },
      { glob: 'src/router/trie-router/**', source: h(['GHSA-f6gv-hh8j-q8vq'], 'TrieRouter parameter override') },
      { glob: 'src/utils/body.ts', source: h(['GHSA-g6gw-c38x-mqfc', 'GHSA-v8w9-8mx6-g223'], 'parseBody memory exhaustion, __proto__') },
      { glob: 'src/utils/url.ts', source: h(['GHSA-crvj-82cr-hjcx', 'GHSA-9hp6-4448-45g2'], 'URL and query parsing confusion') },
      { glob: 'src/hono-base.ts', source: h(['GHSA-4m76-xfj5-7975', 'GHSA-2gcr-mfcq-wcc3'], 'mount() routing bypass') },
    ],
    decisions: [],
    gaps: ['No decisions: its CONTRIBUTING and migration guide state no rule a diff can be checked against, so rule 3 is not tested on hono.'],
  },
  {
    repo: 'colinhacks/zod',
    sourcesAt: ZOD,
    language: 'TypeScript',
    riskPatterns: [{ glob: '.github/workflows/release*', source: doc('colinhacks/zod', ZOD, 'AGENTS.md', 53, 'publishing is a maintainer-only dispatch behind an approval') }],
    decisions: [
      {
        id: 'zod-no-version-bump',
        statement: "A change doesn't bump the version in any package's package.json.",
        source: doc('colinhacks/zod', ZOD, 'AGENTS.md', 53, 'its contributor rules: no version bumps, publishing is maintainer-only'),
        rule: { kind: 'added-line', path: '**/package.json', pattern: '^\\s*"version"\\s*:' },
      },
      {
        id: 'zod-tests-in-typescript',
        statement: 'Tests are written in TypeScript, never JavaScript.',
        source: doc('colinhacks/zod', ZOD, 'AGENTS.md', 34, 'its contributor rules on tests'),
        rule: { kind: 'file-added', path: '**/*.test.js' },
      },
      {
        id: 'zod-no-type-branching',
        statement: 'Shared code never branches on a specific schema type.',
        source: doc('colinhacks/zod', ZOD, 'AGENTS.md', 45, 'its contributor rules on shared code'),
        rule: { kind: 'added-line', path: 'packages/zod/src/**', pattern: 'def\\.type\\s*===' },
      },
    ],
    gaps: ['Risk patterns: no published advisories and no CODEOWNERS, so rule 2 fires only on its release workflow.'],
  },
  {
    repo: 'pydantic/pydantic',
    sourcesAt: PYDANTIC,
    language: 'Python',
    riskPatterns: [
      { glob: 'pydantic-core/src/validators/model_fields.rs', source: p(['GHSA-qpmf-fgh3-ff25'], 'validation bypass of extra data keys') },
      { glob: 'pydantic-core/src/validators/typed_dict.rs', source: p(['GHSA-3r8g-cqwr-jr29'], 'validation bypass of aliased fields') },
      { glob: 'pydantic-core/src/validators/dataclass.rs', source: p(['GHSA-3r8g-cqwr-jr29'], 'validation bypass of aliased fields') },
      { glob: 'pydantic-core/src/validators/url.rs', source: p(['GHSA-955g-x97g-8mcp'], 'quadratic multi-host URL validation') },
      { glob: 'pydantic-core/src/validators/fraction.rs', source: p(['GHSA-gj4f-r7mf-jjxh'], 'unbounded exponent in Fraction validation') },
    ],
    decisions: [
      {
        id: 'pydantic-keep-deprecated',
        statement: 'Functionality marked as deprecated is not removed before V3.',
        source: doc('pydantic/pydantic', PYDANTIC, 'docs/version-policy.md', 5, 'its version policy for V2'),
        rule: { kind: 'removed-line', path: 'pydantic/**', pattern: '@deprecated\\(|PydanticDeprecatedSince' },
      },
    ],
    gaps: [],
  },
  {
    repo: 'pallets/click',
    sourcesAt: CLICK,
    language: 'Python',
    riskPatterns: [],
    decisions: [
      {
        id: 'click-no-new-dependency',
        statement: 'A change adds no unnecessary dependency.',
        source: doc('pallets/click', CLICK, 'docs/contributing.md', 39, 'its contributing guide'),
        rule: { kind: 'added-line', path: 'pyproject.toml', pattern: '^\\s*"[A-Za-z0-9_.\\-]+\\s*([<>=~!].*)?",?\\s*$' },
      },
      {
        id: 'click-no-ternary',
        statement: 'Code avoids ternary expressions, because coverage cannot measure both branches.',
        source: doc('pallets/click', CLICK, 'docs/contributing.md', 35, 'its contributing guide'),
        rule: { kind: 'added-line', path: 'src/click/**', pattern: '\\S\\s+if\\s+\\S.*\\s+else\\s+\\S' },
      },
    ],
    gaps: ['Risk patterns: no published advisories and no CODEOWNERS, so rule 2 does not fire on click.'],
  },
  {
    repo: 'pytest-dev/pytest',
    sourcesAt: PYTEST,
    language: 'Python',
    riskPatterns: [],
    decisions: [
      {
        id: 'pytest-changelog-entry',
        statement: "A change to pytest's source comes with a changelog entry, unless it doesn't affect documented behaviour.",
        source: doc('pytest-dev/pytest', PYTEST, 'CONTRIBUTING.rst', 405, 'its contributing guide. The exception can\'t be checked from a diff, so this rule can fire on a change that needs no entry'),
        rule: { kind: 'requires-file', when: 'src/**', requires: 'changelog/*.rst' },
      },
      {
        id: 'pytest-keep-deprecated',
        statement: 'Deprecated functionality is only removed in major releases.',
        source: doc('pytest-dev/pytest', PYTEST, 'doc/en/backwards-compatibility.rst', 21, 'its backwards compatibility policy'),
        rule: { kind: 'removed-line', path: 'src/**', pattern: 'PytestRemovedIn\\d+Warning' },
      },
    ],
    gaps: ['Risk patterns: no published advisories and no CODEOWNERS, so rule 2 does not fire on pytest.'],
  },
];
