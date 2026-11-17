---------------------------- MODULE TutorialRoute ----------------------------
\* Atomic abstraction of useSupportRouteSync after React effects settle.
\* `loaded` models the optional route contributions, not an authorization to
\* execute a guide. `gate` models the separate, declared screen override.

Screens == {"github", "late", "sibling", "settings", "vault"}
Contexts == Screens \cup {"gate"}
Events == {"init", "user", "guide", "load", "unload", "gate", "refused"}

VARIABLES screen, loaded, gate, context, previous, event
vars == <<screen, loaded, gate, context, previous, event>>

Context(at, available, overridden) ==
  IF overridden THEN "gate"
  ELSE CASE at = "github" -> "github"
         [] at = "late" -> IF available THEN "late" ELSE "settings"
         [] at = "sibling" -> "settings"
         [] OTHER -> at

Init == /\ screen = "settings"
        /\ loaded = FALSE
        /\ gate = FALSE
        /\ context = "settings"
        /\ previous = screen
        /\ event = "init"

Move(destination, source) ==
  /\ screen' = destination
  /\ context' = Context(destination, loaded, gate)
  /\ previous' = screen
  /\ event' = source
  /\ UNCHANGED <<loaded, gate>>

Contribution(available) ==
  /\ loaded' = available
  /\ context' = Context(screen, available, gate)
  /\ previous' = screen
  /\ event' = IF available THEN "load" ELSE "unload"
  /\ UNCHANGED <<screen, gate>>

Override(active) ==
  /\ gate' = active
  /\ context' = Context(screen, loaded, active)
  /\ previous' = screen
  /\ event' = "gate"
  /\ UNCHANGED <<screen, loaded>>

RefuseGateNavigation ==
  /\ previous' = screen
  /\ event' = "refused"
  /\ UNCHANGED <<screen, loaded, gate, context>>

Next == \/ \E destination \in Screens: Move(destination, "user")
        \/ \E destination \in {"settings", "vault"}: Move(destination, "guide")
        \/ \E available \in BOOLEAN: Contribution(available)
        \/ \E active \in BOOLEAN: Override(active)
        \/ RefuseGateNavigation

Spec == Init /\ [][Next]_vars

TypeOK == /\ screen \in Screens
          /\ loaded \in BOOLEAN
          /\ gate \in BOOLEAN
          /\ context \in Contexts
          /\ previous \in Screens
          /\ event \in Events

\* Context is a description of where the person is; updating it must not
\* itself navigate. Gate destinations asked for by a guide are also refused.
ContextChangesDoNotNavigate ==
  event \in {"load", "unload", "gate", "refused"} => screen = previous

GitHubContextSurvivesLateLoading ==
  screen = "github" /\ ~gate => context = "github"

UnrelatedSiblingDoesNotInheritGitHubContext ==
  screen = "sibling" /\ ~gate => context = "settings"

LateContributionIsReflected ==
  screen = "late" /\ ~gate =>
    context = IF loaded THEN "late" ELSE "settings"

GateOverrideWins == gate => context = "gate"
=============================================================================
