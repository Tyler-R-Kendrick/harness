---
description: To run the shell command given after a $ sign
examples:
  - $ ls -la
  - $ cat README.md
kind: script
match: '^\s*\$\s'
holes:
  command:
    description: the command line after the $
    source: pattern
    pattern: '^\s*\$\s*(.+)$'
origin: seed
---
{{command}}
