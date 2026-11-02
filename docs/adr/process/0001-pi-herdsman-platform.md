# 0001. pi + herdsman as the agent platform

- **Status**: Trial
- **Date**: 2026-10-30

## Context

The repository's development workflow is executed by AI coding agents: a
Manager maintains the Forgejo backlog and opens PRs, project Leads run assigned
issues end to end with stage agents. The tools for this exist in the pi
coding agent (extensions, packages) and pi-herdsman (role profiles, agent
delegation). The IntraWeb project has proven this pipeline at scale, but its
setup is heavyweight (project-local agent definitions, pipeline skills,
German rules); a library package needs only the lean core.

## Decision

pi with herdsman is the only agent platform for this repository. The setup is
lean and English-only:

- `AGENTS.md` at the repo root loads into every session (rules index, commands,
  layout).
- `.pi/workflow.md` is the workflow reference (roles, stages, never-list).
- `.pi/forgejo-tools.md` holds the Forgejo constants, label IDs and the REST
  fallback.
- `.pi/pi-herdsman/roles/{manager,managed-lead}.md` are the reserved
  role-profile overlays, adapted (not copied) from IntraWeb.
- Agent definitions come from herdsman's bundled set (`generalist`,
  `implementer`, `researcher`, `reviewer`, `scout`); no project-local
  `.pi/agents/`, no pipeline skills, no codemode policy.

## Consequences

- Every session — local or herdsman-spawned — gets the same binding rules
  through `AGENTS.md`, without project trust.
- Less maintenance surface than a full pipeline: no project agent
  definitions to keep in sync with herdsman updates.
- If the project later needs heavier orchestration (adversarial review
  lenses, gates), it must be added consciously, not inherited.
