---
description: Lists the files in the working directory
examples:
  - what files are here?
  - list the files
  - which files do I have
holes:
  files:
    description: the files under the working directory, one per line
    source: fact
origin: seed
---
Files in {{cwd}}:
{{files}}
