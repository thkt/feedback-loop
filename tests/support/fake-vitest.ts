export function fakeVitest(options: { relevant: string[] }) {
  return {
    'node_modules/vitest/package.json': JSON.stringify({
      name: 'vitest',
      type: 'module',
      bin: { vitest: './vitest.mjs' },
      exports: { './package.json': './package.json', './node': './node.mjs' },
    }),
    'node_modules/vitest/vitest.mjs': `import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
const selected = process.argv.includes('related') ? ['a', 'b'] : ['a', 'b', 'c'];
const report = {
  success: true,
  numTotalTestSuites: selected.length, numPassedTestSuites: selected.length,
  numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: selected.length, numPassedTests: selected.length,
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: selected.map(name => ({
    name: resolve('test/' + name + '.test.ts'), status: 'passed', message: '',
    assertionResults: [{ title: name, fullName: name, ancestorTitles: [], status: 'passed', failureMessages: [] }],
  })),
};
if (process.env.VITEST_RESULT_FAULT === 'missing') report.testResults.splice(1, 1);
if (process.env.VITEST_RESULT_FAULT === 'missing-imported') report.testResults.splice(0, 1);
const argument = process.argv.find(value => value.startsWith('--outputFile='));
if (!argument) throw new Error('JSON report output was not requested');
writeFileSync(argument.slice('--outputFile='.length), JSON.stringify(report));
`,
    'node_modules/vitest/node.mjs': `import { resolve } from 'node:path';
export const parseCLI = () => ({ options: {} });
export const createVitest = async () => ({
  config: {},
  getRelevantTestSpecifications: async () => ${JSON.stringify(options.relevant)}.map(path => ({ moduleId: resolve(path) })),
  close: async () => {},
});\n`,
  };
}
