---
description: Consult Oracle for an explicit second-model review in the current repository.
---
Use the `oracle_consult` tool for this request.

User request: $ARGUMENTS

Workflow:
- If the user supplied no request text, ask what Oracle should evaluate and stop.
- Inspect the repository first and select the smallest file set that contains the relevant context.
- Build a stand-alone Oracle prompt that explains the task, relevant constraints, and what the attached files contain.
- Call `oracle_consult` once with these defaults unless the user asked for something different:
  - `engine: "browser"`
  - `model: "gpt-5.4-pro"`
  - `wait: true`
- Pass the selected files through the `files` array. Do not attach the whole repository unless the user explicitly asked for that scope.
- If the tool returns a preview or dry-run result, state clearly that Oracle did not perform a real external consultation and summarize only the preview metadata.
- If the tool returns background startup logs or a reattach command, state clearly that no final Oracle answer is available yet and report how to reattach.
- If the tool returns a failure, state clearly that the Oracle run failed, summarize the failure message, and do not treat the returned text as an Oracle assessment.
- Otherwise summarize Oracle's answer, state any agreement or disagreement with your own assessment, and mention the Oracle session id when it is available.
- Because the user invoked `/oracle`, treat this as explicit permission to call Oracle.
