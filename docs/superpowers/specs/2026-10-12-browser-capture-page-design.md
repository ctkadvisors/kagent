# Browser evidence capture

The operator authorized a new explicit `browser.capture_page` tool. Browser
extraction currently drops anchor URLs and forces agents to transcribe primary
inputs into their workspace. Capturing the rendered page directly removes both
sources of fictional evidence.

The Playwright driver reads current URL, document title, visible body text, and
HTTP(S) anchor labels and resolved hrefs in one evaluation. The gateway saves the
exact text as UTF-8 and provenance JSON with URL, title, capture time, SHA-256 of
those bytes, and links. It uses an automatic unique relative directory and the
calling task's existing code runner. A concise receipt names paths, hash and
counts. No successful receipt precedes completed writes; failures stay visible.
Existing task deadlines, browser/pod resources and workspace limits bound work.

This explicitly granted workspace-writing tool is distinct from unchanged
`browser.extract_text`. It accepts no output path or browser script, performs no
click/type or website write, and leaves sandbox internet blocked. Root will grant
only existing code-capable profiles in the GitOps consumer after release; the
read-only verifier remains ungranted.

Adding links to extract_text still requires transcription; allowing code to fetch
websites widens egress. Explicit capture preserves the existing network boundary
and produces hash-checkable reusable evidence.

Acceptance: relative links resolve against document base URI; unsafe schemes are
omitted; saved text is byte-identical including whitespace and Unicode; paths are
unique and runners task-isolated. Gateway and pod advertise the explicit tool
without labeling its workspace write read-only. Tests cover failures; real
Chromium smoke capture verifies the complete path.

The operator also authorized explicit `fleet.playground_commit_files`: folder,
message and a mapping from destinations relative to that folder to task-workspace-relative
sources. The repository path is `folder/destination`; source paths retain their
existing workspace directory prefixes. The gateway reads full UTF-8 strings through the same task code runner,
checks every returned path (no missing, duplicate or mismatched results), enforces
the existing 60-file/512-KiB commit bounds, then signs the exact JSON sent to the
existing playground /commit endpoint. It returns that endpoint's SHA/URL plus
per-file hashes. The original inline-content commit tool remains unchanged. This
closes the remaining model-transcription step from workspace to pinned commit.
The capture explicitly identifies its representation as browser-visible-text;
its hash binds rendered UTF-8, not raw HTTP response or HTML bytes.

Navigation reports the actual Playwright response HTTP status alongside URL and
title. Responses at or above 400 return a tool error so failed navigation cannot
reset the repeated-call progress guard. Null/undefined navigation responses keep
the existing URL/title-only behavior; status is never guessed from page content.
