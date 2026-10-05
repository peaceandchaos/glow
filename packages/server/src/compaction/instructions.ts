// Adapted from the official Kimi CLI and DeepSeek Harness pins in docs/providers.md.
// Changes: general chat wording; no tools, code execution, or custom user directives.
// See KIMI-LICENSE, KIMI-NOTICE, and DEEPSEEK-LICENSE in this directory.
export const kimiInstruction =
  "\n---\n\nThe above is a list of messages in an chat conversation. You are now given a task to compact this conversation context according to specific priorities and rules.\n\n**Compression Priorities (in order):**\n1. **Current Task State**: What is being worked on RIGHT NOW\n2. **Errors & Solutions**: All encountered errors and their resolutions\n3. **Code Evolution**: Final working versions only (remove intermediate attempts)\n4. **System Context**: Project structure, dependencies, environment setup\n5. **Design Decisions**: Architectural choices and their rationale\n6. **TODO Items**: Unfinished tasks and known issues\n\n**Compression Rules:**\n- MUST KEEP: Error messages, stack traces, working solutions, current task\n- MERGE: Similar discussions into single summary points\n- REMOVE: Redundant explanations, failed attempts (keep lessons learned), verbose comments\n- CONDENSE: Long code blocks \u2192 keep signatures + key logic only\n\n**Special Handling:**\n- For code: Keep full version if < 20 lines, otherwise keep signature + key logic\n- For errors: Keep full error message + final solution\n- For discussions: Extract decisions and action items only\n\n**Required Output Structure:**\n\n<current_focus>\n[What we're working on now]\n</current_focus>\n\n<environment>\n- [Key setup/config points]\n- ...more...\n</environment>\n\n<completed_tasks>\n- [Task]: [Brief outcome]\n- ...more...\n</completed_tasks>\n\n<active_issues>\n- [Issue]: [Status/Next steps]\n- ...more...\n</active_issues>\n\n<code_state>\n\n<file>\n[filename]\n\n**Summary:**\n[What this code file does]\n\n**Key elements:**\n- [Important functions/classes]\n- ...more...\n\n**Latest version:**\n[Critical code snippets in this file]\n</file>\n\n<file>\n[filename]\n...Similar as above...\n</file>\n\n...more files...\n</code_state>\n\n<important_context>\n- [Any crucial information not covered above]\n- ...more...\n</important_context>\n";
const SUMMARY_OPEN_TAG = '<compacted-summary>';
export const deepseekInstruction = [
  'You are now acting as a compaction engine for this chat assistant. Condense the conversation ABOVE into a structured checkpoint that lets another model resume the work with no loss of essential context.',
  '',
  'Output EXACTLY the Markdown structure below: keep every section, in order. Use terse bullets, not prose paragraphs. Write "(none)" for an empty section — never drop a section.',
  '',
  '## Primary Request and Intent',
  "- [the user's original and evolving goals; quote verbatim where the exact wording matters]",
  '',
  '## Key Technical Concepts',
  '- [technologies, frameworks, patterns, and conventions in play]',
  '',
  '## Files and Code',
  '- [exact path: why it matters, key changes or snippets]',
  '',
  '## Errors and Fixes',
  '- [error: how it was resolved, plus any related user feedback]',
  '',
  '## Pending Jobs',
  '- [explicitly requested work not yet completed]',
  '',
  '## Current Work',
  '- [precisely what was in progress at this checkpoint]',
  '',
  '## Next Step',
  '- [the single next action, directly in line with the most recent request, or "(none)"]',
  '',
  '## Critical Context',
  '- [decisions and their rationale, constraints, user preferences, open questions, data needed to continue]',
  '',
  'Rules:',
  '- Write concise English engineering prose. Preserve exact file paths, commands, error strings, identifiers, numeric values, function signatures, and syntax fragments.',
  '- Capture user feedback and explicit instructions faithfully, especially corrections.',
  '- Do NOT mention this summarization request or that the context was compacted.',
  '- Output only the checkpoint text: do not call any tool or take any other action.',
  `- If the conversation already contains a ${SUMMARY_OPEN_TAG} block, it is a PRIOR checkpoint. Do not copy it forward verbatim: preserve still-true facts, drop stale ones, and merge newer information into a single consolidated summary under the same structure.`,
].join('\n');
export const deepseekPreamble =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.';
