#!/bin/sh
#
# Every bee starts here, whatever it runs. Two jobs, both part of the bee
# contract rather than of either bee:
#
#   BEE_FORWARD   "PORT=HOST:PORT ...": listen on 127.0.0.1:PORT inside the bee
#                 and relay to HOST:PORT. A store that only answers to its own
#                 address (http://localhost:8080/, say) can then be reached from
#                 another machine while the bee still asks for that address.
#   BEE_LIFETIME  whole seconds the bee may exist. It is a hard stop, SIGTERM and
#                 then SIGKILL five seconds later, so a hung browser or a lost
#                 conductor cannot keep a bee alive past its run.
#
# POSIX sh, because the protocol bee's image is Alpine and has no bash.
set -eu

: "${BEE_LIFETIME:?BEE_LIFETIME must say how many seconds this bee may live}"

for forward in ${BEE_FORWARD:-}; do
	port=${forward%%=*}
	upstream=${forward#*=}
	socat "TCP-LISTEN:${port},bind=127.0.0.1,fork,reuseaddr" "TCP:${upstream}" &
done

exec timeout -k 5 "${BEE_LIFETIME}" "$@"
