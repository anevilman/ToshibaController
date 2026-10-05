# ToshibaController

Local control for a Toshiba AC NA bedroom unit. An [SLWF-01pro](https://github.com/smartlightme/slwf-01pro) Wi-Fi stick runs ESPHome and talks to the indoor board over UART. A phone page on the house PC is the remote.

The infrared remote still works after the stick is installed. The Toshiba cloud app is not used for day-to-day control.

## What is here

- `firmware/slwf-01pro.yaml` — ESPHome config for the stick (ESP8266). Mode, fan speed, Eco, the panel light, and the night cycle.
- `web/` — the bedroom page. `server.js` serves it over HTTPS and proxies `/stick` to the dongle so a phone can install it as a home-screen app.
- `test_app.py` — an earlier LAN check with [msmart-ng](https://github.com/mill1000/midea-msmart). It asks NetHome Plus for a device key once, then can set Cool or Fan. The password is not saved.

## Night cycle

The cycle runs on the stick. While Schedule is on and the time is inside the window (default 20:00–08:00), it alternates Cool and Fan. The default stretch is 9 minutes of Cool, then 11 minutes of Fan. Outside that window it leaves the unit as it is. The phase follows the clock, so a restart picks up the slot for the current time.

The page reads live state from the stick and writes mode, fan, and schedule settings straight back to it.

## Run the page

`web/certs/` is gitignored. Put `air.pfx` and `passphrase.txt` there, set `STICK_HOST` in `web/server.js`, then:

```
node web/server.js
```

The page listens on port 8443.

## Firmware

Copy `firmware/secrets.yaml.example` to `firmware/secrets.yaml` and set the timezone. That file stays out of git. The config does not compile in a Wi-Fi password; the stick keeps the network saved at setup. If that login is missing, it opens the `AC-wifi` setup network.

```
cd firmware
esphome run slwf-01pro.yaml
```

Build output and `*.bin` files are gitignored. `firmware/vendor/yaml/slwf01pro24.yaml` is the SmartLight board file the UART pins come from.

## Test app

```
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt
.venv\Scripts\python test_app.py
```

Open http://127.0.0.1:8765. If the unit accepts a key, it is stored in gitignored `data/device.json`.
