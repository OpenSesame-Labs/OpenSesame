# ADR 0221 — First-run guidance: screens speak first, once, and an act earns one recommendation

- **Status:** Accepted
- **Date:** 2026-11-10
- **Builds on:** [ADR 0163](0163-tutorial-mode.md) (a tour a person walks),
  [ADR 0166](0166-gate-help-launcher.md) (gates have tutorials),
  [ADR 0162](0162-device-receipts-inbox-and-local-notifications.md) (a toast is the echo of a notice),
  [ADR 0130](0130-operator-controlled-capability-composition.md) (a feature is
  a consented switch), [ADR 0189](0189-settings-features-and-integrations.md)
  (features and integrations), [ADR 0149](0149-nothing-stored-in-the-clear.md)
  (nothing the client stores rests in the clear)
- **Amends:** ADR 0163 "Consequences" (which tutorials a person has finished is
  not recorded) — narrowed, not reversed, in §2 below.
  [ADR 0154](0154-setup-configuration-choice.md)'s choice screen — Default
  leads it and it gains one line of prose, in §4.
  [ADR 0153](0153-minimal-pwa-optional-sections.md) is unchanged: Minimal
  still approves nothing optional. DESIGN.md § Empty states and § Actions are
  symbols — one more first-run road and one worded key on a toast, in §4–§5.

## Context

First-time testers were given the app with no instructions. Three things
happened, in order:

1. **They could not tell what to press on the first screen.** The front door
   drew three equal boxes, and the setup choice behind it drew four more with
   no sentence over them. The first box was *Minimal*, it carried a check
   mark, and it was where the keyboard landed. They took it.
2. **Minimal has no password type.** That is ADR 0153 working as designed: a
   bare installation holds the generic secret, and item types are a switch.
   A person who came for a password manager found a rail with `secrets` and
   `files` and nothing called a password. The switch that fixes it is three
   screens away, under a word (*Features*) they had no reason to look behind.
3. **Nothing walked them through anything.** ADR 0163 gave every feature a
   replayable tour and a library that lists them. Both are behind a question
   mark. A person who has never seen the product does not know that the
   question mark is where the product explains itself, so the tours existed
   and nobody met one.

The same shape repeats later. A person regenerates a password by hand and
never learns the vault can change it on the site; exports a file and never
learns a connected forge keeps that copy current. The integration that would
have helped is invisible at exactly the moment it would have helped.

ADR 0163 chose not to remember anything: "a library that remembered would be
a record of what somebody could not work out on their own." That is right for
a transcript. It also made it impossible to offer a tour *once*, which is the
only polite way to offer one unasked.

## Decision

### 1. A screen offers its tour the first time it is met

`FIRST_VISIT_TOURS` (`tutorial/registry/first-visit.ts`) names, per route, the
tours that introduce it, most useful first. After those come the tours written
for that route that no list names — a tour scoped to `/identity` is offered on
`/identity`, a `feature.*` tour on Settings › Features, an `integration.*`
tour on Settings › Integrations — in library order. On arriving at a route,
the first candidate that the library's own gate offers (`goalOffered`) and that
this device has not answered is offered: a card with the tour's name, its
length, one worded key (**Show me**) and a dismiss.

A route with no entry inherits its parent's. `first-visit.test.ts` fails a
route that resolves to nothing, a name that is not a tour, a tour that cannot
start from its route, and **a tour that no route offers** — so neither a
screen nor a walkthrough can be added without a first visit that reaches it.
Every one of the library's tours is therefore offered somewhere, once.

A screen with several tours offers one per session: once an offer on a route
has been answered, that route says nothing more until the page is loaded
again, and then offers the next. Coming back to the vault is not met with the
next card each time.

The card is a toast (`ToastStack`), not the tour and not a modal. It takes no
focus, dims nothing and blocks no control; a person who already knows the
screen carries on, and every existing keyboard and touch contract holds with
it on screen. It does not leave on a clock — an offer nobody read is not an
offer — and it is taken back when the person moves on, opens the Support
sheet, or starts a tour another way. One press starts the same `tour` run
ADR 0163 defines; nothing about the runtime, the HUD or the language changes.

It rides inside the support capability (`SupportLauncher`), on the shell and
on every gate, so a build without guided help has no offers.

### 2. What is remembered is a preference, not a transcript

`guidance.v1` (`lib/guidance.ts`) holds three things: how tours are offered
(`mode`), the ids of walkthroughs whose offer was answered — started or
declined — and the ids of recommendations already made. Registry ids only,
validated on read; never a question, an item, a route parameter or anything a
person typed. It is per device, because the gates are met before a vault
exists, and it rests in the device KV sealed like every other file there
(ADR 0149).

This narrows ADR 0163's consequence rather than reversing it. The support
transcript is still memory and only memory, and *finishing* a tour is still
not recorded. What is recorded is that an unasked offer was answered, so that
it is not made twice. Settings › General › Guided tours shows how many
answers are held and forgets them on one press.

### 3. The mode is the person's

Settings › General › Guided tours chooses what happens on a screen that has
not been seen: **Offer the tour** (the default), **Start the tour**, or **Do
nothing**. `auto` starts the tour itself where `offer` would have drawn the
card. `off` silences offers and recommendations both; the library is
unaffected by all three.

Offer is the default, not auto, for two reasons. A tour that starts itself on
every new screen interrupts the person who is there to do something. And an
overlay that appears unasked sits over the controls the browser walks under
`apps/pages/scripts/` press, where an offer does not. Making `auto` the default is
one constant (`DEFAULT_GUIDANCE_MODE`) and a decision about those walks.

### 4. The first screens say which road is for a newcomer

- **The front door** marks *Set up your own* as the lead road (`road--lead`:
  ink on its edge and its mark) and its second line says so.
- **The setup choice** leads with *Default*, marked the same way, where the
  keyboard lands; each road says in plain words what the vault will hold
  (*Minimal*: "Plain secrets and files only. No password, card or note types
  until you turn them on."), and one line above them says the choice can be
  changed later. It is a statement, not a question title. *Skip all* keeps its
  icon key and its accessible name and gains its sentence in sight.
- **An empty vault with no password type** — Minimal, or a skipped setup —
  says why there are no passwords and offers the switch as its first road:
  *Turn on passwords, cards and notes*. One press commits the item types with
  the consent receipt the plan earns, exactly as the switch in Settings ›
  Features does (ADR 0130), and the guided first password takes its place.
  It is offered only where the plan ships and permits the types. The
  build-flagged icon key (`VITE_PWA_OFFER_PASSWORDS_ONBOARDING`) is unchanged.
- The first-password tour (`vault.item.first`) names website, username and
  password fields, so it now requires the item types; a Minimal vault is
  offered the switch first and the tour after.

### 5. An act earns one recommendation

A screen says what just happened (`signalRecommendation`): a password was
generated, a password was copied, an item was saved, the vault was exported,
items were imported. `RECOMMENDATIONS_FOR` names what each act may bring up,
most useful first, and the first one that is still *wanted* and has not been
made on this device is made, once:

| Act | Recommends, in order |
|---|---|
| Password generated | Password reset · its runtime · Breach checks |
| Password copied | Browser autofill |
| Item saved | Backups · Breach checks · Browser autofill |
| Vault exported | Backups |
| Items imported | Backups · Breach checks |

"Wanted" is answered from the device: a feature whose switch is off and could
be on (shipped and permitted), an integration section that is drawn, a backup
that is not saved. A recommendation never names something this build does not
ship, an operator withheld, or the person already set up.

A recommendation is an ordinary notice. It rings as a toast with one worded
key and stays in the tray until dismissed — no second surface. The key either
switches the feature on in place (the feature's own proposal, commit and
consent receipt; nothing is fetched or activated before the press) and then
leads to whatever is left to connect, or opens the integration's section. It
never configures a third party by itself: connecting a forge or a runtime is
still that integration's own ceremony, with its own credential.

### 6. One worded key on a toast

DESIGN.md § Actions are symbols keeps text off controls except as "the object
of a choice". **Show me**, **Turn on password reset** and **Set up backups**
are that: the card is the question and the key is its answer, and an icon
alone there is the mystery meat the rule exists to prevent. The key is
`btn choice`, so `lint:design` holds it to the same contract as every other
worded choice. Dismiss stays an icon key.

## Consequences

- A newcomer who presses the first thing on each first screen now gets
  Default, and one who takes Minimal anyway is one press from passwords.
- Every route owes a first-visit tour and every tour owes a route. The
  sections whose only tour is "Find X" (Activity, Wallet) are introduced by
  that until they have one of their own. A tour with no route of its own
  (`routes: []`) has to be placed in a list by hand; the test says which.
- `ToastMessage` gains `sticky`, `choice` and `onDismiss`, and `NoticeAct`
  gains `worded`. An existing notice is unchanged: its act is not worded, so
  its echo draws no key.
- The setup choice's order is now Default, Minimal, Full, Custom. The walks
  that arrow across it (`verification-checklist-setup.mjs`) follow.
- The browser walks meet an offer card on fresh profiles. It blocks nothing,
  but a walk that asserts "no toast is showing" on arrival needs
  `guidance.v1` set to `off` first.
- Recommendations are authored, five of them. Adding one is a registry entry
  and a signal at the act; `recommendations.test.ts` fails one that points at
  a feature or section that does not exist.
