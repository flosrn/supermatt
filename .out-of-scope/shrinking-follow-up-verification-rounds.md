# Shrinking follow-up QA and review rounds

After a fix, `implement` and `implement-spec` run one follow-up round: a fresh QA agent on the behavior the fix can affect, then all three `code-review` axes (Standards, Spec, Adversarial) on the fix diff. This project does not shorten that loop by running fewer review readers on a small fix, by reviewing only the axes that reported findings, or by adding a stop condition that ends the loop on the severity of the remaining review findings.

## Why this is out of scope

The rounds are already sized to the fix. Follow-up QA reruns the earlier fails, the scenarios the fix diff can affect, and one adjacent flow, and carries unaffected passes forward (`qa`, step 1). Follow-up review reads only the fix diff and the behavior it can affect (`code-review`, step 1). Several fix commits already go into one round: `implement` reviews "the fix commits only (since the commit before the first fix)". Transcripts of recent runs show all three rules being followed, and round times falling from one follow-up to the next.

Fewer readers would not make a round shorter. The readers run in parallel with QA, so a round lasts as long as its slowest agent. In the measured runs that was QA or the Adversarial reader, never Standards or Spec. Dropping a reader saves tokens, not wall-clock time.

A stop condition based on review severity would not have removed any measured round either. Every follow-up round started from a failing QA verdict on changed behavior, and some also had verified P1 findings. A QA fail on changed behavior has to be fixed and checked again, and the round that confirms the last fix is required anyway, because every review axis must complete on the final diff.

The rounds also found real defects. Follow-up rounds caught several defects that an earlier fix had introduced. One of them was a P1 that broke startup, found by the Spec and Adversarial readers in a round whose QA had passed. Spec found as many of these regressions as any other reader. In one run, Spec and Adversarial both reported nothing in the first round and both found the defect a fix introduced in the next one, so an axis's earlier findings do not predict whether it will find the next defect. Fixes as small as fifteen production lines introduced a defect, so no diff-size threshold is safe. In review rounds that read only a fix diff, every finding was a real defect, not a style or hardening note.

A long loop comes from fixes that introduce new defects, not from verification that repeats work. Making it shorter means fixing better the first time: `fix-findings` already has a rule for a finding that re-targets an earlier fix.

## What would reopen this

New evidence that the current rules do not cover. For example: follow-up rounds started only by P2 or P3 review findings, with no QA fail and no P1; a host where readers have to run one after another, so their number adds to wall-clock time; or follow-up QA or review that rereads unaffected behavior even though the rules above say not to.

## Prior requests

- #91: "Size follow-up QA and review rounds to the fix diff without weakening independent verification"
