#!/usr/bin/with-contenv bashio

export EDF_USERNAME="$(bashio::config 'username')"
export EDF_CRON="$(bashio::config 'cron')"

# Run script once
node edf.js
