---
description: Explains what this harness can do and how to ask it things
examples:
  - help
  - what can you do?
  - how does this work
holes:
  templates:
    description: the templates, one per line
    source: fact
origin: seed
---
I answer from templates before I spend any inference: a decision model picks the template that fits your request, and I fill it from what the harness knows, from your words, or from a choice among options. When none fits, a generator writes a new one (you are asked first), and it answers the next similar request for free. Rate an answer with /rate good or /rate bad <why>; a bad one is rewritten the next time it is chosen.

The templates I have:
{{templates}}
