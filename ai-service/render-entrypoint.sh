#!/bin/sh
set -eu

mkdir -p /data/db /data/uploads
chown scholarship:scholarship /data /data/db /data/uploads
exec gosu scholarship "$@"
