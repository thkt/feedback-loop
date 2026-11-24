import { expect, test } from 'bun:test';
import {
  type Effect,
  type Event,
  type State,
  type TransitionSettings,
  judgeResult,
  nextState,
} from '../src/command.ts';

const settings: TransitionSettings = { killAfterMs: 1000, childReports: true };
const monitorExit = { code: 78, signal: null };

function replay(events: Event[]) {
  let state: State = { phase: 'starting' };
  const steps: { state: State; effects: Effect[] }[] = [];
  for (const event of events) {
    const step = nextState(state, event, settings);
    steps.push(step);
    state = step.state;
  }
  return { state, steps };
}

test('取消を受け付けた後に監視プロセスが終了コード78で終わると、取消を伝え、78を表示しない', () => {
  const { state } = replay([
    { type: 'started' },
    { type: 'cancel', signal: 'SIGINT' },
    { type: 'exit', ...monitorExit },
    { type: 'close' },
  ]);
  const outcome = judgeResult(state, monitorExit, { allowFailure: false, childReports: true });
  expect(outcome).toEqual({
    kind: 'failed',
    message: '取り消しました。時間の上限も過ぎていました',
  });
  expect(JSON.stringify(outcome)).not.toContain('78');
});

test('監視プロセスが終了コード78で終わった後に届いた取消は、状態を変えず副作用を出さず、時間切れを伝える', () => {
  const { state, steps } = replay([
    { type: 'started' },
    { type: 'exit', ...monitorExit },
    { type: 'cancel', signal: 'SIGINT' },
    { type: 'close' },
  ]);
  const exitedState: State = { phase: 'running', exit: 'timedOut' };
  expect(steps[1]).toEqual({ state: exitedState, effects: [] });
  expect(steps[2]).toEqual({ state: exitedState, effects: [] });
  const outcome = judgeResult(state, monitorExit, { allowFailure: false, childReports: true });
  expect(outcome).toEqual({ kind: 'timedOut' });
  expect(JSON.stringify(outcome)).not.toContain('78');
});
