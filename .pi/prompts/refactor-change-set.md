---
description: Review the current change set with refactor, typescript, and design-pattern-adopter skills; adopt clear wins
argument-hint: "[instructions]"
---

Load the `refactor`, `typescript`, and `design-pattern-adopter` skills, then apply them together to the current change set (`git diff origin/main`, including uncommitted work):

1. Check the diff for improvements: refactoring opportunities, TypeScript issues, and applicable design patterns.
2. Adopt only the ones that bring clear benefits. Keep changes behavior-preserving.
3. Run the quality gates (`npm run typecheck`, `npm run lint`, `npm test`).
4. Report two lists:
   - Adopted: what you changed and why.
   - Rejected: what you skipped and why.

${ARGUMENTS:-}
