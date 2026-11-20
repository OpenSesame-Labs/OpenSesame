---------------------------- MODULE TutorialPause ----------------------------
\* A tour speaks only when guidance is not off and this session is not paused.
\* Reload drops the pause and keeps the queued ids. A profile name is not an id.
\* A superseded stop does not queue.

CONSTANTS Goals, Profiles

VARIABLES mode, paused, queue, spoken, profileStored

vars == <<mode, paused, queue, spoken, profileStored>>

Modes == {"off", "auto", "offer"}

MaySpeak == mode # "off" /\ ~paused

TypeOK ==
  /\ mode \in Modes
  /\ paused \in BOOLEAN
  /\ queue \subseteq Goals
  /\ spoken \in BOOLEAN
  /\ profileStored \in BOOLEAN

Init ==
  /\ mode = "auto"
  /\ paused = FALSE
  /\ queue = {}
  /\ spoken = FALSE
  /\ profileStored = FALSE

SetMode(m) ==
  /\ m \in Modes
  /\ mode' = m
  /\ spoken' = IF m = "off" \/ paused THEN FALSE ELSE spoken
  /\ UNCHANGED <<paused, queue, profileStored>>

PauseSession ==
  /\ ~paused
  /\ paused' = TRUE
  /\ spoken' = FALSE
  /\ UNCHANGED <<mode, queue, profileStored>>

\* forgetSessionTutorialPause on a new document. The ids stay.
Reload ==
  /\ paused
  /\ paused' = FALSE
  /\ UNCHANGED <<mode, queue, spoken, profileStored>>

Queue(g) ==
  /\ g \in Goals
  /\ queue' = queue \union {g}
  /\ profileStored' = FALSE
  /\ UNCHANGED <<mode, paused, spoken>>

RefuseProfile(p) ==
  /\ p \in Profiles
  /\ profileStored' = FALSE
  /\ UNCHANGED <<mode, paused, queue, spoken>>

Speak ==
  /\ spoken' = MaySpeak
  /\ UNCHANGED <<mode, paused, queue, profileStored>>

Resume(g) ==
  /\ g \in queue
  /\ queue' = queue \ {g}
  /\ UNCHANGED <<mode, paused, spoken, profileStored>>

\* The product does not call the queue for a stop it takes itself.
Superseded ==
  UNCHANGED vars

NoSpeechWhileQuiet == spoken => MaySpeak

NoProfileStored == profileStored = FALSE

Next ==
  \/ \E m \in Modes: SetMode(m)
  \/ PauseSession
  \/ Reload
  \/ \E g \in Goals: Queue(g)
  \/ \E p \in Profiles: RefuseProfile(p)
  \/ Speak
  \/ \E g \in Goals: Resume(g)
  \/ Superseded

Spec == Init /\ [][Next]_vars

====
