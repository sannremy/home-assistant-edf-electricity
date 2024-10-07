# EDF - Addon for Home Assistant

Get daily power consumption from [EDF](https://particulier.edf.fr/) to Home Assistant as 2 states: one value for the kWh, and the other one for the cost in €. The update occurs every 3 hours.

### Motivation

I wanted to get all metrics about power, water consumptions in one place: Home Assistant. I reached out to know if there's any plan for a public API, unfortunately they told me it was only for companies.

## Pre-requisites

EDF has a 2FA, the verification code needs to be sent through email (works with Gmail).
For that, you need to set up a new [IMAP integration](https://www.home-assistant.io/integrations/imap) and allow Home Assistant to check your Gmail inbox.

Make sure that the *IMAP search* field checks only for newer code.
```
X-GM-RAW "in:unread newer_than:1h from:dc-dsi-mcp-nasso-smartpush@edf.fr"
```

Once the verification code is sent, Home Assistant has to extract the code and put it in a state so that the add-on can read it. This is can easily done with the HA templates:

```
- trigger:
    - platform: event
      event_type: imap_content
      id: edf_code
      event_data:
        sender: dc-dsi-mcp-nasso-smartpush@edf.fr
  sensor:
    - name: edf_code
      state: >
        {{ trigger.event.data["text"]
          | regex_findall_index("([0-9]{6})") }}
      attributes:
        subject: >
          {{ trigger.event.data["subject"] }}
        date: >
          {{ trigger.event.data["date"] }}
```

## Installation

 - Add the add-ons repository to your Home Assistant: `https://github.com/sannremy/home-assistant-edf-electricity`.
 - Install the *EDF - Electricity consumption* add-on.
 - Configure the add-on with your EDF email address.

## Configuration

|Option|Required|Description|
|---------|--------|-----------|
|`username`|Yes|The email address to login on EDF.|
|`cron`|No|This will fetch the daily consumption. Default is every 3 hours: `0 */3 * * *`. If set, it will override the time when the job runs.|

## Contributing

Feel free to contribute by submitting issues and pull requests.
