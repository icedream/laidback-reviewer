# Lab host pieces

`laidback-lab.service` is the whole install for the default setting, `egress: none`: no container in the lab
may reach the network, which covers a database, a cache, a routing daemon, `helm template` and running an
image the review just built. Run it as the lab user's own unit, never root's.

`nftables.conf` and `squid.conf` are only for `egress: registries`, where a build resolves dependencies from
an allow-list of hostnames. That needs a proxy, because registry IPs rotate; if you are not running one, do
not load either file.

Open egress is a config value, not a file here: it means a pull request's build script can reach anything,
and every artifact says so.
