---
description: To see the contents of a file
examples:
  - show me README.md
  - print the file notes/todo.md
  - open the readme
kind: script
holes:
  path:
    description: the file to show
    source: choice
    fact: files
origin: seed
---
cat '{{path}}'
