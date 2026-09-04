# Cell goldens

Locked `FrameDump` for `SCENARIOS` in `packages/tui/src/scenarios.ts`.

Update after an intentional visual change:

```bash
TZ=UTC bun scripts/tui-frame.ts dump-scenarios --out packages/tui/test/fixtures/golden
```

Then inspect the git diff of these files before committing. These goldens lock **our** compositor; they are not grok-build runtime dumps (ADR-007).
