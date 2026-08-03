# Pi unattended containment

`run-contained.sh` is the whole-process isolation profile for unattended work.
It mounts only the selected task workspace as writable, uses a container-local
Pi home, drops Linux capabilities, denies privilege escalation, and disables
network access. It does not mount host Pi sessions/auth, SSH/cloud credentials,
Docker socket, or unrelated source trees.

Build once from the `pi/` context so the pinned harness is embedded read-only
in the image and linked into the separate agent volume at startup:

```bash
docker build -t pi-harness:0.83.0 -f pi/containment/Dockerfile.pi pi
```

Validate loading or run a task that uses a model available inside the isolated
network namespace:

```bash
pi/containment/run-contained.sh /absolute/task/workspace -p "task"
```

The network-denied profile is the safe default and cannot call this machine's
LAN inference service or package registries, so it is not yet a usable coding
path with the current remote model. Create a separately reviewed narrow relay
or use Gondolin/OpenShell before enabling inference; do not replace
`--network=none` with unrestricted bridge networking for untrusted unattended
work. The image and launcher are an implemented containment base, not evidence
that R-5's live escape matrix passed.
