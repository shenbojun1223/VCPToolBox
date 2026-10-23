# ServerProjectForge

Server-side direct/hybridservice build of ProjectForge. Core provenance:
shenbojun1223/VCPChat 179712c366c7a7afc2c7df6a758938d14a42f44c. The plugin manifest retains the server-specific name
to avoid distributed tool routing collisions. fileKit is included locally.

## Installation
Install the VCPToolBox host dependencies using its lockfile, then install this plugin's
local dependencies with npm ci in Plugin/ServerProjectForge after a lockfile is provided.
Do not install or rebuild dependencies under a running production instance.
pdf-parse is pinned to 1.1.1 because fileKit uses its function API; host pdf-parse 2.x
is not a drop-in replacement. diff-match-patch and mammoth are pinned to the deployed
compatible versions. SQLite, glob, ExcelJS and validators resolve from the host.
chardet is optional; missing it selects the existing UTF-8 fallback.

Provide a private config.env with explicitly authorized WORKSPACES and an absolute
PROJECTFORGE_DB_PATH. No machine configuration or credentials are distributed here.
AUTORESUME_CONFIG_PATH and CATALOG_CONFIG_PATH default off. Enabling either is an
explicit data-sharing/ownership decision, not part of installing source files.

Native AST runtimes are excluded from Git; see bin/README.md. Existing deployments
must preserve their verified runtime. Missing runtime degrades symbol support.

## Mainline integration scope
Includes the reviewed catalogHost cache-miss fix from 179712c366c7a7afc2c7df6a758938d14a42f44c; the live server
publisher has not been restarted or upgraded to that cache-miss fix by this Git task.
The companion shutdown repair is inherited from 7a36ff730d88426a41fe9a70e30ef2bd8ba5db7c.
PI probe files are historical validated drivers, not automatically launched workers.
Do not reuse their machine-local checkpoints or credentials on another host.
