export type BunTestState =
  | { status: 'pending' | 'running' | 'skipped' | 'excluded' }
  | { status: 'passed'; modules: Set<string> };

export function bunRecordUpdates(states: Map<string, BunTestState>, succeeded: boolean) {
  const ran = new Map<string, Set<string>>();
  const failed: string[] = [];
  for (const [file, state] of states) {
    switch (state.status) {
      case 'pending':
      case 'excluded':
        break;
      case 'passed':
        if (succeeded) {
          ran.set(file, state.modules);
        } else {
          failed.push(file);
        }
        break;
      case 'running':
      case 'skipped':
        failed.push(file);
        break;
    }
  }
  return { ran, failed };
}
