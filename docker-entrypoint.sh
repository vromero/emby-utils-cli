#!/bin/sh
set -e

# docker-entrypoint.sh — delegates to the emby CLI binary.
#
# If the first argument looks like a CLI subcommand (doesn't start with "-"),
# we prepend "emby" so both forms work:
#   docker run emby-utils system info       → emby system info
#   docker run emby-utils --help            → emby --help
#   docker run emby-utils init --config ... → emby init --config ...

exec node /app/dist/bin.js "$@"
