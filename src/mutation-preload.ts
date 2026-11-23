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
