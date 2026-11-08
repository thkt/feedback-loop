import { applyFeedback } from '../../support/feedback-loop-batch.ts';
import { commitFixture } from '../../support/runner-affected.ts';
import {
  config as batchConfig,
  files as batchFiles,
  run as runFeedback,
} from '../../support/feedback-loop-batch.ts';
import { expect, test } from 'bun:test';
import { readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { baseEnv, fixture, git, header } from '../../support/runner-affected.ts';
import type { Fixture } from '../../support/runner-affected.ts';

function run(f: Fixture, args: string[]) {
  return runFeedback(
    f,
    args,
    {
      ...baseEnv(f),
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      FEEDBACK_TRACE: join(f.signals, 'executed.log'),
    },
    30000,
  );
}

async function observations(f: Fixture) {
  return (await readFile(join(f.signals, 'executed.log'), 'utf8'))
    .trim()
    .split('\n')
    .filter(Boolean);
}

const source =
  "import type { Generated } from '../generated/value.ts';\nexport type Value = number;\nexport const value: Generated = 1;\n";
const generated = 'export type Generated = number;\n';

for (const prepared of [false, true]) {
  test(`Bunの型検査を${prepared ? '既存prepare' : 'package script'}から接続し、検査範囲と修正後の復帰を保つ`, async () => {
    const prefix = [...(prepared ? ['generate'] : []), 'typecheck', 'legacy'];
    const scripts = {
      typecheck:
        'bun scripts/trace.ts typecheck && bun check --no-script -p tsconfig.type-tests.json',
      'check:legacy': 'bun scripts/legacy.ts',
      'prepare:tests': 'bun scripts/generate.ts && bun run typecheck && bun run check:legacy',
      check:
        (prepared ? 'bun run prepare:tests' : 'bun run typecheck && bun run check:legacy') +
        ' && bun test ./test && bun scripts/trace.ts build',
    };
    const config = {
      ...batchConfig,
      assurance: [{ path: 'test/assurance.test.ts', reason: '資源の後始末だけを確認する対照' }],
      prepare: prepared ? [process.execPath, 'run', 'prepare:tests'] : [],
      bunArgs: ['--no-env-file'],
      testArgs: [],
      globalChanges: ['scripts/**', 'tsconfig*.json', 'prepare-input.json'],
      dependencies: [],
    };
    await fixture(
      {
        'package.json': JSON.stringify({
          private: true,
          type: 'module',
          packageManager: 'bun@1.4.4',
          scripts,
        }),
        '.gitignore': 'generated/\n',
        '.feedback-loop.json': JSON.stringify(config),
        'tsconfig.json': JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            target: 'ESNext',
            module: 'Preserve',
            allowImportingTsExtensions: true,
            types: [],
          },
          include: ['src/**/*.ts'],
        }),
        'tsconfig.type-tests.json': JSON.stringify({
          extends: './tsconfig.json',
          include: ['src/**/*.ts', 'type-tests/**/*.ts', 'generated/**/*.ts'],
          exclude: ['outside/**'],
        }),
        'src/value.ts': source,
        'generated/value.ts': generated,
        'type-tests/contract.ts':
          "import type { Value } from '../src/value.ts';\nexport const compatible: Value = 1;\n",
        'outside/excluded.ts': 'export const excluded: number = "outside existing scope";\n',
        'prepare-input.json': '{"compatible":true}\n',
        'scripts/trace.ts':
          "import { appendFileSync } from 'node:fs';\nappendFileSync(process.env.FEEDBACK_TRACE!, process.argv[2] + '\\n');\n",
        'scripts/generate.ts':
          "import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';\n" +
          "appendFileSync(process.env.FEEDBACK_TRACE!, 'generate\\n');\n" +
          "mkdirSync('generated', { recursive: true });\n" +
          `writeFileSync('generated/value.ts', ${JSON.stringify(generated)});\n`,
        'scripts/legacy.ts':
          "import { appendFileSync, readFileSync } from 'node:fs';\n" +
          "appendFileSync(process.env.FEEDBACK_TRACE!, 'legacy\\n');\n" +
          "if (!JSON.parse(readFileSync('prepare-input.json', 'utf8')).compatible) { console.error('LEGACY_PREPARE_DIAGNOSTIC'); process.exit(7); }\n",
        'scripts/collect.ts': batchFiles['scripts/collect.ts'],
        'test/quality.test.ts':
          header +
          "import { appendFileSync } from 'node:fs';\nimport { value } from '../src/value.ts';\n" +
          "test('value', () => { appendFileSync(process.env.FEEDBACK_TRACE!, 'quality\\n'); expect(value).toBe(1); });\n",
        'test/assurance.test.ts':
          header +
          "import { appendFileSync, existsSync, unlinkSync, writeFileSync } from 'node:fs';\n" +
          "test('cleanup', () => { const trace = process.env.FEEDBACK_TRACE!; appendFileSync(trace, 'assurance\\n'); const resource = trace + '.resource'; writeFileSync(resource, 'temporary'); unlinkSync(resource); expect(existsSync(resource)).toBe(false); });\n",
      },
      async (f) => {
        const trace = join(f.signals, 'executed.log');
        await writeFile(trace, '');
        const before = run(f, ['run', 'check']);
        expect(before.code, before.output).toBe(0);
        const originalChecks = await observations(f);
        expect(originalChecks.slice(0, prefix.length)).toEqual(prefix);
        expect(originalChecks.slice(prefix.length).sort()).toEqual([
          'assurance',
          'build',
          'quality',
        ]);

        const feedback = prepared
          ? 'bun run test:affected'
          : 'bun run typecheck && bun run check:legacy && bun run test:affected';
        const installed = applyFeedback(f, feedback, run);
        expect(installed.code, installed.output).toBe(0);
        const packageAfter: unknown = JSON.parse(
          await readFile(join(f.repo, 'package.json'), 'utf8'),
        );
        expect(packageAfter).toMatchObject({ scripts });
        expect(await readFile(join(f.repo, '.feedback-loop.json'), 'utf8')).toBe(
          JSON.stringify(config),
        );
        await writeFile(trace, '');
        const classified = run(f, ['run', 'check:classification']);
        expect(classified.code, classified.output).toBe(0);
        expect(await observations(f)).toEqual([]);
        expect(classified.output).toContain('test/quality.test.ts');
        expect(classified.output).toContain('test/assurance.test.ts');
        commitFixture(f.repo, 'configured typecheck');

        const invalidSource = source.replace('Value = number', 'Value = string');
        await writeFile(join(f.repo, 'src/value.ts'), invalidSource);
        // 変更ファイルだけでは正常でも、既存tsconfig内の変更外利用先では型が合わない。
        const narrowed = run(f, ['check', '--no-script', 'src/value.ts']);
        expect(narrowed.code, narrowed.output).toBe(0);

        for (const state of ['normal', 'type-error', 'repaired']) {
          const input = state === 'type-error' ? invalidSource : source + `// ${state}\n`;
          await writeFile(join(f.repo, 'src/value.ts'), input);
          expect(git(f.repo, 'diff', '--name-only')).toBe('src/value.ts');
          if (prepared) {
            await unlink(join(f.repo, 'generated/value.ts'));
          }
          await writeFile(trace, '');
          const checked = run(f, ['run', 'check:feedback']);
          expect(await readFile(join(f.repo, 'src/value.ts'), 'utf8')).toBe(input);
          if (state === 'type-error') {
            expect(checked.code, checked.output).not.toBe(0);
            expect(checked.output).toContain('type-tests/contract.ts');
            expect(checked.output).toContain('TS2322');
            expect(await observations(f)).toEqual(prefix.slice(0, -1));
          } else {
            expect(checked.code, checked.output).toBe(0);
            expect(await observations(f)).toEqual([...prefix, 'quality']);
          }
        }

        await writeFile(join(f.repo, 'prepare-input.json'), '{"compatible":false}\n');
        await writeFile(trace, '');
        const legacyFailed = run(f, ['run', 'check:feedback']);
        expect(legacyFailed.code, legacyFailed.output).not.toBe(0);
        expect(legacyFailed.output).toContain('LEGACY_PREPARE_DIAGNOSTIC');
        expect(await observations(f)).toEqual(prefix);
        await writeFile(join(f.repo, 'prepare-input.json'), '{"compatible":true}\n');
        await writeFile(trace, '');
        const restored = run(f, ['run', 'check:feedback']);
        expect(restored.code, restored.output).toBe(0);
        expect(await observations(f)).toEqual([...prefix, 'quality']);

        await writeFile(trace, '');
        const full = run(f, ['run', 'check']);
        expect(full.code, full.output).toBe(0);
        const finalChecks = await observations(f);
        expect(finalChecks.slice(0, prefix.length)).toEqual(prefix);
        expect(finalChecks.slice(prefix.length).sort()).toEqual(
          originalChecks.slice(prefix.length).sort(),
        );
      },
    );
  }, 60000);
}
