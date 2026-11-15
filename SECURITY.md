# Security policy

## Reporting a vulnerability

Please do **not** report a security problem in a public issue, pull request or
forum post.

Report it privately through GitHub instead: open the **Security** tab of this
repository, then **Report a vulnerability**.

No such button? Private reporting is not enabled yet: open an issue that only
asks the maintainers for a private contact, without any detail of the problem,
and send the report there.

Include, when you can:

- the version of the integration and of Gladys;
- what an attacker can do, and the steps to reproduce it;
- the log lines that help (remove tokens, passwords and addresses first).

The fix ships as a new version of the integration, and the advisory is
published once users can update.

## Supported versions

Only the latest release receives security fixes: update the integration from
Gladys before reporting a problem.

## Scope

In scope: the code of this repository and the Docker image it publishes —
including the receiver, which listens on the local network for syslog messages
from any sender (parsing, framing, rate limits, allowed senders).

The integration stores no secret. Under `/data` it keeps only the list of the
senders seen (IP address, host name, first and last seen), never the messages:
those stay in memory (the last one of each sender, the last severe ones, at
most 500 waiting in the receiver). The receiver ports are published on the
local network by Gladys (shown at install); syslog has no authentication, so
use the allowed senders to restrict them, and do not expose these ports to the
internet.

Out of scope: Gladys Assistant itself (see its
[security policy](https://github.com/GladysAssistant/Gladys/security/policy)),
and the devices that send their logs.
