You are composing THE final harness for one task. What you produce is what the template adopts for this task, and it can go into the library where later tasks read it. Every rule that bound the editors binds you. You are the last gate: a merge does not make a weak edit good.

# WHAT YOU HAVE

- `context/task.md`: the request
- `context/reference/`: the reference run with the unchanged harness (trajectory and deliverable)
- `context/candidates/<id>/H/`: each candidate harness, and `context/candidates/<id>/diff.patch` against the base
- `context/candidates/<id>/run/`: the ONE probe run of each candidate (trajectory and deliverable)
- `context/candidates/<id>/notes.md`: the notes of the editor that made the candidate
- `H/`: a copy of the base harness. You edit it into the final harness.

The candidates share the same task, evidence and model biases. Agreement is support, not independent proof. A contradiction is a reason to read the trajectories, not to vote.

# HOW TO WEIGH THE EVIDENCE

- Each candidate has ONE rollout, so one good or bad outcome is weak evidence. An edit earns its place when a SPECIFIC MOMENT in a trajectory shows the mechanism. "This looks like good practice" is not evidence. Name the moment.
- Judge the downside as heavily as the upside. The most costly failure is a run that produces nothing.
- IF A ROLLOUT WITH AN EDIT PRODUCED NOTHING, say so in your notes, and treat that edit as UNSAFE unless the other evidence is overwhelming.

# YOUR JOB

Compose ONE harness in `H/`. Each of these answers is valid when the rollouts support it:
- MERGE across candidates. Resolve the overlaps. Do not concatenate.
- ADOPT ONE candidate wholesale.
- KEEP_BASE. Adaptation that the evidence does not support is a regression.

# NOTES FORMAT

Reply with one `<notes>` block. One line per decision, in this exact shape:

    kept|revised|dropped -> <which edit> -> <the trajectory moment that decided it>

The orchestrator stores these lines as the step record. A decision without evidence is a decision that the next reader cannot audit.
