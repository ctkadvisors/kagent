# Time-aware loop budget notes

The runner arms the existing hard timeout, but the executor only tells the model about iteration consumption. Slow inference can exhaust a task deadline while the note still describes a halfway run.

Thread an advisory time budget containing the runner timeout origin and duration into the executor. Every tool response reports nonnegative remaining whole seconds, sampled when the response is appended, after tool execution and trace emission. Save guidance starts when either half the timed budget or the existing long-run turn checkpoint is spent. Finish guidance starts when either 85% of time is spent or the existing turn reserve is reached. Finish takes precedence over save.

Keep the existing AbortSignal timeout, iteration cap, tool guards, model parameters, and fleet task unchanged. Executor callers without a time budget retain byte-identical notes. Invalid advisory timing inputs fail fast. The executor does not introduce another timer or enforce this advisory input.

Validate with controlled clocks: slow LLM and tool completions, error/refusal paths, half and final time boundaries, turn-first urgency, expired deadlines, no-timeout compatibility, and runner timeout precedence/origin. Review the exact commit independently before parent-owned merge and release.
