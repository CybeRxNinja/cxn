## Auto-Learn (experimental)

`manage_skill`: build reusable managed-skill library.
Managed skills: `SKILL.md` in isolated `~/.cxn/agent/managed-skills`; surfaced in future sessions like other skills.

For repeatable procedures worth codifying—setup sequences, debugging recipes, project-specific workflows—use `manage_skill` to `create` | `update` | `delete`.
Isolation: managed skills ONLY writable skills. NEVER edit user-authored skills in `~/.cxn/agent/skills` or `.cxn/skills`.
Capture sparingly, specifically: skill requires reuse; prefer enhancing existing managed skill to creating near-duplicate.
