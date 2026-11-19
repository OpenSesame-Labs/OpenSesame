# ADR 0224 — Guidance offers live in the current screen's flow

- **Status:** Accepted
- **Date:** 2026-11-16
- **Amends:** [ADR 0221](0221-first-run-guidance-and-recommendations.md), offer and recommendation placement.

## Context

On a small screen, a persistent first-visit toast can cover the controls it
introduces. In particular, a person choosing a setup road can be unable to tap
it until they answer the offer. That contradicts ADR 0221's requirement that
the offer block no control. A persistent recommendation can cover both the
task and the guide's own actions in the same way.

## Decision

A first-visit offer uses an in-flow seat. A screen may provide a specific
seat next to the task it explains; otherwise the unlocked shell or gate gives
it a shared row. The row takes space from the screen's scrollable region, so
both the current task and the offer remain reachable. A gate keeps the same
screen mounted while the row appears or leaves. In the shell, shared guide and
recommendation rows precede the task, keeping its bottom controls and the
status-line prompt in their usual positions on a small screen.

The offer still names the tour and its length, offers Show me and a way to
decline, waits for an answer, and follows the route, consent and focus rules
in ADR 0221. An offer does not start a tour or navigate unless the person
chooses that action; the separate automatic mode is unchanged.

In the shell, an unanswered recommendation has a compact row in the same
flow. Review opens a sheet with its complete explanation and original worded
action; opening the sheet changes nothing. Multiple recommendations can be
reviewed there together, and none is evicted to make room for a later arrival.
Each recommendation supplies a specific compact preview title; the tray,
review sheet, and accessible control names retain the full title. An arrival
without a compact title shows its full title in the preview.
Dismissing an echo still leaves its notice in the tray, and answering or
dismissing the tray notice removes the echo. A gate defers the background
shell's presentation until the gate has gone.

On a shellless screen, the notice corner presents the full latest error and
latest claim notice in flow. It keeps a focused older card while a newer one
arrives. Their duplicate transient echoes and the former fixed claim banner
are omitted; the tray retains the notices until dismissed. Other transient
notices keep their six-second idle timer and fixed placement, so they may
temporarily cover controls; hovering or focusing them pauses that timer and
protects them from eviction. The two transient places are independent of the
in-flow recommendation row. If both places are being read, a later notice
remains available in the tray rather than replacing either one.

Toast cards, recommendation previews, and in-flow gate notices give dismissals
and their optional actions visible wording, with the notification's title in
the dismiss control's accessible name. Duplicate titles gain message context,
and identical messages gain an ordinal, so their controls are distinguishable.
This narrow exception to DESIGN.md's
icon-only action rule makes the purpose and dismissal clear on touch screens.
The existing tray and other executing actions retain their icon-key rule.
