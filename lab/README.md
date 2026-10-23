# Lab host pieces

`laidback-lab.service` is the whole install for the default setting, `egress: none`: no container in the lab
may reach the network, which covers a database, a cache, a routing daemon, `helm template` and running an
image the review just built. Run it as the lab user's own unit, never root's.

`nftables.conf` and `squid.conf` are only for `egress: registries`, where a build resolves dependencies from
an allow-list of hostnames. That needs a proxy, because registry IPs rotate; if you are not running one, do
not load either file.

Open egress is a config value, not a file here: it means a pull request's build script can reach anything,
and every artifact says so.

## Where the daemon binds

Loopback is not enough when the bot runs in a container: `host.docker.internal` is the docker bridge
gateway, and a daemon on `127.0.0.1` refuses that connection. Bind the gateway address instead,
`--host 172.17.0.1` for the default bridge: reachable from containers on this host, unreachable from the
LAN. The token is what keeps other containers on that bridge from using it.

## What the runtime needs from the unit

Three things, each found by watching a job die:

- `Delegate=yes`, so the service owns a cgroup subtree. Without it runc refuses with
  `unable to apply cgroup configuration: ... permission denied`.
- A real user runtime directory, `XDG_RUNTIME_DIR=/run/user/<uid>`, plus `loginctl enable-linger lab`.
  With a private `/run/<name>` instead, podman falls back to cgroupfs and rejects the quotas the harness
  asks for, so no container starts.
- No `NoNewPrivileges`. Rootless podman escalates through `newuidmap` and `newgidmap`; blocking it fails
  with `newuidmap: Could not set caps` even though the binaries carry `cap_setuid=ep`. In a drop-in, reset
  it with `NoNewPrivileges=no`: an empty value clears list settings only.

The quotas are not decoration. Drop them and a pull request's build script runs unthrottled on the machine
that also runs the inference server.
