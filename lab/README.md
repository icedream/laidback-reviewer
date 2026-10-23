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
