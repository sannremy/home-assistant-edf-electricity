#!/usr/bin/with-contenv bashio

export EDF_USERNAME="$(bashio::config 'username')"
export EDF_CRON="$(bashio::config 'cron')"
export EDF_TEMPO_CRON="$(bashio::config 'tempocron')"

# Run script once
node edf.js
