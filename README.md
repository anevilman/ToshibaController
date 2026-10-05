# ToshibaController

Custom control for a Toshiba window AC bedroom unit: an [SLWF-01 Pro](https://github.com/smartlightme/slwf-01pro) Wi‑Fi stick runs ESPHome firmware with a night Cool/Fan schedule, and a small local web app lets someone change settings outside that window (e.g. daytime manual control).

**Why it exists:** The unit’s built-in scheduler stopped being reliable after an update. Instead of the old thermometer-hack workaround, this project puts scheduling on the stick and gives a phone-friendly page on the house PC as the remote. The IR remote still works; the Toshiba cloud app is not used day-to-day.

## Stack

- **Firmware:** ESPHome on ESP8266 (SLWF-01 Pro / Midea-protocol UART)
- **Web remote:** Node HTTPS page + stick proxy (`web/`)
- **Earlier probe:** Python + [msmart-ng](https://github.com/mill1000/midea-msmart) (`test_app.py`)

## What is here

| Path | Role |
|------|------|
| `firmware/slwf-01pro.yaml` | ESPHome config: mode, fan, Eco, panel light, night cycle |
| `web/` | Bedroom page; `server.js` serves HTTPS and proxies `/stick` so a phone can install it as a home-screen app |
| `test_app.py` | Early LAN check via NetHome Plus device key (key not committed) |

## Night cycle

The cycle runs **on the stick**. While Schedule is on and the clock is inside the window (default **20:00–08:00**), it alternates Cool and Fan (default **9 min Cool / 11 min Fan**). Outside that window it leaves the unit alone. Phase follows the clock, so a restart picks up the correct slot.

The page reads live state from the stick and writes mode, fan, and schedule settings back to it.

## Run the page

`web/certs/` is gitignored. Put `air.pfx` and `passphrase.txt` there, set `STICK_HOST` in `web/server.js`, then:

```bash
node web/server.js
```

Listens on port **8443**.

## Firmware

Copy `firmware/secrets.yaml.example` to `firmware/secrets.yaml` and set the timezone (stays out of git). Wi‑Fi password is not compiled in; the stick keeps the network from setup. If that login is missing, it opens the `AC-wifi` setup network.

```bash
cd firmware
esphome run slwf-01pro.yaml
```

Build output and `*.bin` files are gitignored. `firmware/vendor/yaml/slwf01pro24.yaml` is the SmartLight board file the UART pins come from.

## Test app

```bash
python -m venv .venv
.venv/Scripts/pip install -r requirements.txt   # Windows
.venv/bin/pip install -r requirements.txt       # macOS / Linux
.venv/Scripts/python test_app.py                # or .venv/bin/python
```

Open http://127.0.0.1:8765. If the unit accepts a key, it is stored in gitignored `data/device.json`.

## Resume / portfolio note

This is a real house utility project: firmware + companion UI for reliable night cooling and daytime manual control after the stock scheduler failed.
