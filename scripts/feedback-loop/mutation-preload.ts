// 生成元: thkt/feedback-loop scripts/build.ts。直接編集せず、正本を変更して再生成してください
// バージョン: 0.4.6
if (
  process.env.FEEDBACK_LOOP_MUTATION_BUN_OPTIONS !== undefined &&
  process.env.MUTATOR_BUN_MANIFEST !== undefined
) {
  const value: unknown = JSON.parse(process.env.FEEDBACK_LOOP_MUTATION_BUN_OPTIONS);
  if (typeof value === 'string') {
    process.env.BUN_OPTIONS = value;
  } else {
    delete process.env.BUN_OPTIONS;
  }
}
