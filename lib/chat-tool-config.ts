export const MAX_TOOL_STEPS = 8;
export const MAX_RUN_TOKENS = 200_000;

export function getRunTokenTotal({
  steps,
}: {
  steps: ReadonlyArray<{
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    };
  }>;
}) {
  const totalTokens = steps.reduce(
    (total, step) =>
      total + (step.usage.inputTokens ?? 0) + (step.usage.outputTokens ?? 0),
    0,
  );
  return totalTokens;
}

export function isRunTokenBudgetExceeded({
  steps,
}: {
  steps: ReadonlyArray<{
    usage: {
      inputTokens: number | undefined;
      outputTokens: number | undefined;
    };
  }>;
}) {
  return getRunTokenTotal({ steps }) >= MAX_RUN_TOKENS;
}
