#!/usr/bin/env bash
# Generate the self-signed certificate the containerised proxy serves.
#
#   ./make-cert.sh 192.168.1.51            # the LAN address of this machine
#   ./make-cert.sh lwfa.home 192.168.1.51  # a name and an address
#
# Run in a container, so openssl is not needed on the host. Nothing here
# touches the system trust store.
#
# # Why the address must be in the certificate
#
# A browser checks the name it dialled against the certificate's subjectAltName
# and ignores the Common Name entirely. A certificate without the IP in its SAN
# is rejected by every current browser however carefully it was trusted, which
# looks like the trust step having silently failed.
#
# # What this cannot do
#
# Make the certificate trusted. It is self-signed, so each device has to be
# told to accept it once. On iOS and iPadOS that is two steps, and the second
# is the one people miss:
#
#   1. Open http://<address>:8880/ and install the profile. Plain HTTP on
#      purpose: the device cannot fetch the certificate over the HTTPS that
#      certificate is for, because it does not trust it yet.
#   2. Settings > General > About > Certificate Trust Settings, and turn it on
#      under "Enable full trust for root certificates".
#
# Without step 2 the certificate is installed and still not trusted, so the
# page loads with a warning and WebCodecs stays off, which shows up as video
# that works but looks worse than it should.
#
# If that is too much friction, and it reasonably might be: use
# `tailscale serve` instead. Tailscale issues a real Let's Encrypt certificate
# for the machine's *.ts.net name, which every device already trusts, so there
# is nothing to install anywhere.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")"

if [ $# -eq 0 ]; then
  echo "usage: $0 <lan-address> [more names or addresses...]" >&2
  echo "example: $0 192.168.1.51" >&2
  exit 1
fi

# Split the arguments into DNS names and IP addresses, because a SAN entry has
# to declare which it is and a browser will not match an address given as DNS.
sans=""
primary="$1"
for name in "$@"; do
  if [[ "$name" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    sans="${sans:+$sans,}IP:$name"
  else
    sans="${sans:+$sans,}DNS:$name"
  fi
done

mkdir -p certs

echo "generating a certificate for: $sans"
docker run --rm -v "$PWD/certs:/certs" -w /certs alpine/openssl:latest \
  req -x509 -newkey rsa:2048 -nodes -days 3650 \
  -keyout lwfa.key -out lwfa.crt \
  -subj "/CN=$primary" \
  -addext "subjectAltName=$sans" \
  -addext "basicConstraints=critical,CA:TRUE" \
  >/dev/null 2>&1

# The container writes as root; make them readable so nginx in the container
# and a human on the host can both use them.
docker run --rm -v "$PWD/certs:/certs" alpine:latest \
  sh -c 'chmod 644 /certs/lwfa.crt && chmod 640 /certs/lwfa.key'

echo
echo "wrote certs/lwfa.crt and certs/lwfa.key"
echo
echo "next:"
echo "  docker compose up -d"
echo "  http://$primary:8880/    <- install the certificate on each device first"
echo "  https://$primary:8443/   <- then open lwfa here"
