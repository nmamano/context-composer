# UI feedback ledger (Phase 5e live testing)

Intake for Nil's UI test reports. The session agent records every report
here IMMEDIATELY (this file is the durable truth; chat is not). Process and
gates: plans/phase5e-feedback-loop.md.

Format per item:

    ## F-NNN — <one-line title>
    - reported: <date> · class: bug | refinement | design-question
    - status: new | triaged | in-batch-N | fixed@<commit> | parked-for-Nil | wontfix (Nil)
    - what: <what Nil saw — verbatim where possible>
    - where: <view/tab + conv id + frame id if known>
    - expected: <what should happen>
    - evidence: <wiretap ts / control API reads / screenshot path — filled at triage>
    - resolution: <fix summary + regression test, or the parked options>

Batches: group 3–6 related items; one reviewer diff-review + one commit per
batch (`ui-fix batch N: <summary>`); update statuses in the same commit.

---

(no items yet — F-001 starts here)
