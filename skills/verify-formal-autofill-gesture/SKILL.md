---
name: verify-formal-autofill-gesture
description: "Check autofill never runs without an extension-owned gesture. Use when changing decideFill or fill guard rules."
---

# Verify autofill gesture gate

`decideFill` must refuse when the arm trigger is not `command` or `popup`.

Replay: `apps/browser-extension-autofill/lib/fill/guard-formal.replay.test.ts`.

Model: `spec/formal-verification/autofill-gesture/AutofillGesture.tla` (`NoFillWithoutGesture`).