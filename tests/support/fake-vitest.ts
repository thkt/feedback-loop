export function vitestConfig<T extends { bunArgs?: unknown }>(config: T) {
  const result = { ...config, runner: 'vitest' };
  Reflect.deleteProperty(result, 'bunArgs');
  return result;
}

export function fakeVitest(options: { cli: string; relevant?: string[] }) {
  return {
    'node_modules/vitest/package.json': JSON.stringify({
      name: 'vitest',
      type: 'module',
      bin: { vitest: './vitest.mjs' },
      exports: { './package.json': './package.json', './node': './node.mjs' },
    }),
    'node_modules/vitest/vitest.mjs': options.cli,
    'node_modules/vitest/node.mjs':
      options.relevant === undefined
        ? 'export {};\n'
        : `import { resolve } from 'node:path';
export const parseCLI = () => ({ options: {} });
export const createVitest = async () => ({
  config: {},
  getRelevantTestSpecifications: async () => ${JSON.stringify(options.relevant)}.map(path => ({ moduleId: resolve(path) })),
  close: async () => {},
});\n`,
  };
}

export function passedVitestReportSource(selected: string, paths = false) {
  const count = selected === "['a', 'b']" ? '2' : selected + '.length';
  return `{
  success: true,
  numTotalTestSuites: ${count}, numPassedTestSuites: ${count},
  numFailedTestSuites: 0, numPendingTestSuites: 0,
  numTotalTests: ${count}, numPassedTests: ${count},
  numFailedTests: 0, numPendingTests: 0, numTodoTests: 0,
  testResults: ${selected}.map(name => ({
    name: resolve(${paths ? 'name' : "'test/' + name + '.test.ts'"}), status: 'passed', message: '',
    assertionResults: [{ title: name, fullName: name, ancestorTitles: [], status: 'passed', failureMessages: [] }],
  })),
}`;
}
