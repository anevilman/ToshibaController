"""Local proof for Toshiba AC NA: set Cool or Fan with the beep flag off.

Run: .venv\\Scripts\\python test_app.py
Then open http://127.0.0.1:8765 on this PC.
The Toshiba password is used once to fetch a device key and is not saved.
"""

import asyncio
import json
import logging

import httpx
import socket
import struct
import threading
from ctypes import byref, c_ulong, create_string_buffer, windll
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from ipaddress import IPv4Network
from pathlib import Path

from msmart.cloud import ApiError, NetHomePlusCloud
from msmart.const import DeviceType
from msmart.device import AirConditioner as AC
from msmart.discover import Discover
from msmart.lan import Security

LOG = logging.getLogger("test_app")
ROOT = Path(__file__).resolve().parent
DEVICE_PATH = ROOT / "data" / "device.json"
HOST = "127.0.0.1"
PORT = 8765

MODES = {
    "cool": AC.OperationalMode.COOL,
    "fan": AC.OperationalMode.FAN_ONLY,
}

LOOP = None
LOCK = asyncio.Lock()
STATE_LOCK = threading.Lock()
FOUND = {}
DEVICE = None
STATE = {
    "linked": False,
    "device_name": None,
    "device_ip": None,
    "device_id": None,
    "online": False,
    "power": None,
    "mode": None,
    "target_c": None,
    "indoor_c": None,
    "busy": False,
    "message": "Looking for the AC on the network.",
    "error": None,
    "devices": [],
    "trace": [],
}


def publish(**kwargs):
    with STATE_LOCK:
        STATE.update(kwargs)


def snapshot():
    with STATE_LOCK:
        data = dict(STATE)
        data["devices"] = list(STATE["devices"])
    return data


def broadcast_targets():
    """Subnet broadcasts. A global broadcast leaves via the VPN on this PC."""
    targets = []
    size = c_ulong(0)
    windll.iphlpapi.GetIpAddrTable(None, byref(size), False)
    buf = create_string_buffer(size.value)
    if windll.iphlpapi.GetIpAddrTable(buf, byref(size), False) != 0:
        return ["255.255.255.255"]
    count = struct.unpack_from("<I", buf.raw, 0)[0]
    offset = 4
    for _ in range(count):
        addr, _index, mask, _bcast, _reasm, _unused, _kind = struct.unpack_from(
            "<IIIIIHH", buf.raw, offset)
        offset += 24
        ip = socket.inet_ntoa(struct.pack("<I", addr))
        netmask = socket.inet_ntoa(struct.pack("<I", mask))
        if ip.startswith("127.") or ip.startswith("169.254.") or ip == "0.0.0.0":
            continue
        network = IPv4Network(f"{ip}/{netmask}", strict=False)
        if network.prefixlen < 16 or network.prefixlen > 30:
            continue
        broadcast = str(network.broadcast_address)
        if broadcast not in targets:
            targets.append(broadcast)
    return targets or ["255.255.255.255"]


def load_saved():
    if not DEVICE_PATH.exists():
        return None
    return json.loads(DEVICE_PATH.read_text(encoding="utf-8"))


def save_device(info):
    DEVICE_PATH.parent.mkdir(exist_ok=True)
    temporary = DEVICE_PATH.with_suffix(".tmp")
    temporary.write_text(json.dumps(info, indent=2), encoding="utf-8")
    temporary.replace(DEVICE_PATH)


def public_state(device):
    mode = device.operational_mode.name if device.operational_mode is not None else None
    return {
        "online": bool(device.online),
        "power": bool(device.power_state),
        "mode": mode,
        "target_c": device.target_temperature,
        "indoor_c": device.indoor_temperature,
    }


async def find_devices():
    found = {}
    for target in broadcast_targets():
        LOG.info("Searching %s", target)
        devices = await Discover.discover(
            target=target, timeout=4, auto_connect=False, discovery_packets=2)
        for device in devices:
            if device.type != DeviceType.AIR_CONDITIONER:
                continue
            found[device.id] = {
                "id": device.id,
                "name": device.name,
                "ip": device.ip,
                "port": device.port,
            }
        if found:
            break
    return found


async def connect_saved(saved):
    global DEVICE
    device = AC(
        ip=saved["ip"], port=int(saved["port"]), device_id=int(saved["id"]))
    device.set_max_connection_lifetime(90)
    await device.authenticate(saved["token"], saved["key"])
    await device.refresh()
    DEVICE = device
    publish(
        linked=True,
        device_name=saved.get("name"),
        device_ip=saved["ip"],
        device_id=saved["id"],
        error=None,
        **public_state(device),
    )
    if device.online:
        publish(message="Connected. Cool and Fan send one silent command each.")
    else:
        publish(message="The key was accepted, but the AC did not answer a status read.")


class MideaAirCloud(NetHomePlusCloud):
    """Same server as NetHome Plus, with the Midea Air application id."""

    APP_ID = "1117"

    def __init__(self, region="US", *, account=None, password=None, **kwargs):
        super().__init__(region, account=account, password=password, **kwargs)
        self._security = MideaAirCloud._Security()

    class _Security(NetHomePlusCloud._Security):
        APP_KEY = "ff0cf6f5f0c3471de36341cab3f7a9af"


def udp_variants(device_id):
    raw_ids = (
        ("little", device_id.to_bytes(6, "little")),
        ("big", device_id.to_bytes(6, "big")),
        ("reversed", bytes(reversed(device_id.to_bytes(8, "big")))),
    )
    return [(label, Security.udpid(raw).hex()) for label, raw in raw_ids]


TRACE = []


def add_trace(entry):
    TRACE.append(entry)
    publish(trace=list(TRACE))


async def logged_get_token(cloud, udpid, device_id, with_code, label):
    """Post one getToken call and keep the raw request and response."""
    data = {"udpid": udpid}
    if with_code:
        data["applianceCodes"] = str(device_id)
    endpoint = "/v1/iot/secure/getToken"
    body = cloud._build_request_body(data)
    body["sign"] = cloud._security.sign(endpoint, body)
    url = f"{cloud._base_url}{endpoint}"
    async with httpx.AsyncClient() as client:
        response = await client.post(url, data=body, timeout=10.0)
    add_trace({
        "label": label,
        "url": url,
        "status": response.status_code,
        "request": body,
        "response": response.text,
    })
    LOG.info("getToken %s status %s", label, response.status_code)
    LOG.info("getToken request %s", json.dumps(body))
    LOG.info("getToken response %s", response.text)
    parsed = json.loads(response.text)
    if int(parsed.get("errorCode", -1)) != 0:
        raise ApiError(parsed.get("msg"), code=int(parsed["errorCode"]))
    for item in (parsed.get("result") or {}).get("tokenlist") or []:
        if item.get("udpId") == udpid:
            return item["token"], item["key"]
    raise RuntimeError("the key list did not include this AC")


async def request_token(cloud, udpid, device_id, with_code):
    data = {"udpid": udpid}
    if with_code:
        data["applianceCodes"] = str(device_id)
    response = await cloud._api_request(
        "/v1/iot/secure/getToken",
        cloud._build_request_body(data),
    )
    for item in (response or {}).get("tokenlist") or []:
        if item.get("udpId") == udpid:
            return item["token"], item["key"]
    raise RuntimeError("the key list did not include this AC")


async def pull_tokens(cloud, device_id):
    """Ask for a key. Error 9999 is often a short cloud hiccup, so retry it."""
    last_error = None
    for with_code in (True, False):
        for attempt in range(3):
            found = {}
            system_error = False
            for label, udpid in udp_variants(device_id):
                try:
                    found[label] = await request_token(cloud, udpid, device_id, with_code)
                except ApiError as exc:
                    last_error = exc
                    if getattr(exc, "code", None) == 9999:
                        system_error = True
                        break
                except Exception as exc:
                    last_error = exc
            if found:
                return found
            if system_error and attempt < 2:
                await asyncio.sleep(1.5 * (attempt + 1))
                continue
            break
    return last_error


def collect_appliances(node, found):
    if isinstance(node, dict):
        code = node.get("applianceCode")
        if code is None and ("type" in node or "sn" in node):
            code = node.get("id")
        if code is not None:
            try:
                found.append({
                    "id": int(code),
                    "name": node.get("name") or node.get("applianceName"),
                    "type": node.get("type"),
                })
            except (TypeError, ValueError):
                pass
        for value in node.values():
            collect_appliances(value, found)
    elif isinstance(node, list):
        for item in node:
            collect_appliances(item, found)


def summarize_appliances(listed):
    if not listed:
        return "none"
    parts = []
    for item in listed:
        name = item.get("name") or "unnamed"
        parts.append(f"{name} ({item['id']})")
    return ", ".join(parts)


async def list_appliances(cloud):
    response = await cloud._api_request(
        "/v1/appliance/user/list/get",
        cloud._build_request_body({}),
    )
    found = []
    collect_appliances(response, found)
    unique = []
    seen = set()
    for item in found:
        if item["id"] in seen:
            continue
        seen.add(item["id"])
        unique.append(item)
    return unique


async def fetch_token(lan, account, password):
    notes = []
    cloud = NetHomePlusCloud("US", account=account, password=password)
    await cloud.login()
    listed = await list_appliances(cloud)
    summary = summarize_appliances(listed)
    publish(message=f"NetHome Plus signed in. Devices on the account: {summary}.")
    notes.append(f"NetHome Plus devices: {summary}.")
    appliance_id = listed[0]["id"] if listed else lan.id
    udpid = udp_variants(appliance_id)[0][1]
    calls = (
        ("with appliance id", True),
        ("without appliance id", False),
    )
    for label, with_code in calls:
        try:
            token, key = await logged_get_token(cloud, udpid, appliance_id, with_code, label)
        except Exception as exc:
            notes.append(f"NetHome Plus {label} failed ({exc}).")
            continue
        candidate = AC(ip=lan.ip, port=lan.port, device_id=int(appliance_id))
        candidate.set_max_connection_lifetime(90)
        try:
            await candidate.authenticate(token, key)
        except Exception as exc:
            notes.append(f"NetHome Plus issued a key ({label}), but the AC rejected it ({exc}).")
            continue
        return token, key, int(appliance_id)
    notes.append("The request and response are in the browser console.")
    raise RuntimeError(" ".join(notes))


async def link(device_id, account, password):
    record = FOUND.get(int(device_id))
    if record is None:
        raise RuntimeError("That AC is no longer in the search results. Search again.")
    if not account or not password:
        raise RuntimeError("Enter the name and password from the Toshiba AC NA app.")
    TRACE.clear()
    publish(trace=[])
    lan = AC(ip=record["ip"], port=int(record["port"]), device_id=int(record["id"]))
    token, key, used_id = await fetch_token(lan, account.strip(), password)
    saved = {
        "ip": record["ip"],
        "port": record["port"],
        "id": used_id,
        "name": record["name"],
        "token": token,
        "key": key,
    }
    save_device(saved)
    await connect_saved(saved)


async def set_mode(mode_name):
    if DEVICE is None:
        raise RuntimeError("Connect the AC before sending a mode.")
    mode = MODES[mode_name]
    await DEVICE.refresh()
    if not DEVICE.online:
        publish(online=False, message="The AC did not answer.")
        raise RuntimeError("The AC did not answer. It may be asleep or the phone app may be holding the connection.")
    # One state command. The beep bit stays off. Clearing the dirty set
    # avoids a second property write, which is another chance to chirp.
    DEVICE.power_state = True
    DEVICE.operational_mode = mode
    DEVICE._sound = False
    DEVICE._updated_properties.clear()
    await DEVICE.apply()
    await DEVICE.refresh()
    reported = DEVICE.operational_mode.name if DEVICE.operational_mode is not None else None
    publish(error=None, message=f"Sent {mode_name} with beep off. Unit now reports {reported}.", **public_state(DEVICE))
    return reported


async def search():
    global FOUND
    found = await find_devices()
    FOUND = found
    if not found:
        publish(message="No AC answered. The dongle and this PC both need to be on the house Wi-Fi.")
        return
    names = ", ".join(item["name"] or str(item["id"]) for item in found.values())
    publish(
        devices=[{"id": item["id"], "name": item["name"], "ip": item["ip"]} for item in found.values()],
        message=f"Found {names}. Sign in with the Toshiba AC NA account that owns it.",
    )


async def startup():
    saved = load_saved()
    if saved:
        try:
            await connect_saved(saved)
            return
        except Exception as exc:
            LOG.warning("Saved key failed: %s", exc)
            publish(linked=False, error=str(exc), message="The saved key was rejected. Sign in again.")
    try:
        await search()
    except Exception as exc:
        LOG.exception("Search failed")
        publish(error=str(exc), message="Search failed.")


async def locked(coro):
    async with LOCK:
        return await coro


def run_async(coro, timeout):
    future = asyncio.run_coroutine_threadsafe(coro, LOOP)
    return future.result(timeout)


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        LOG.info("http %s", fmt % args)

    def _send(self, status, payload, content_type):
        body = payload if isinstance(payload, bytes) else payload.encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _json(self, status, data):
        self._send(status, json.dumps(data), "application/json")

    def do_GET(self):
        if self.path.split("?", 1)[0] == "/api/state":
            self._json(200, snapshot())
            return
        if self.path.split("?", 1)[0] in ("/", "/index.html"):
            self._send(200, PAGE, "text/html; charset=utf-8")
            return
        self._json(404, {"error": "Not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length) if length else b"{}"
        try:
            body = json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError:
            self._json(400, {"error": "Expected JSON."})
            return
        path = self.path.split("?", 1)[0]
        publish(busy=True, error=None)
        status = 200
        try:
            if path == "/api/search":
                run_async(locked(search()), 30)
            elif path == "/api/link":
                run_async(locked(link(body.get("id"), body.get("account", ""), body.get("password", ""))), 180)
            elif path == "/api/mode":
                mode = body.get("mode")
                if mode not in MODES:
                    raise RuntimeError("Mode must be cool or fan.")
                run_async(locked(set_mode(mode)), 45)
            else:
                status = 404
                publish(error="Not found")
        except Exception as exc:
            LOG.warning("Request failed: %s", exc)
            publish(error=str(exc))
            status = 400
        finally:
            publish(busy=False)
        self._json(status, snapshot())


PAGE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AC test</title>
<style>
  body { font: 18px/1.4 system-ui, sans-serif; margin: 24px; max-width: 36rem; color: #1c1915; background: #f6f3ee; }
  h1 { font-size: 1.4rem; margin: 0 0 0.4rem; }
  p { margin: 0.4rem 0; }
  button { font: inherit; padding: 0.7rem 1.1rem; margin: 0.4rem 0.4rem 0 0; border: 0; border-radius: 8px; background: #0f6e6e; color: white; }
  button.secondary { background: #444; }
  button:disabled { opacity: 0.5; }
  label { display: block; margin-top: 0.8rem; }
  input { font: inherit; width: 100%; padding: 0.45rem; box-sizing: border-box; }
  .card { background: white; border-radius: 12px; padding: 16px; margin-top: 16px; }
  .error { color: #8a1f1f; }
  .muted { color: #555; font-size: 0.95rem; }
</style>
</head>
<body>
  <h1>AC mode test</h1>
  <p class="muted">Cool or Fan only. Each press turns the unit on in that mode and sends the beep flag off.</p>
  <p id="message"></p>
  <p id="error" class="error"></p>
  <div class="card" id="status"></div>
  <div class="card" id="login" hidden>
    <form id="link-form">
      <p>Use the email that signed in before. This asks only NetHome Plus for the key, and prints that request and response in the browser console. The password is not included. The password is not saved.</p>
      <label>Email or name <input name="account" type="text" autocomplete="username" required></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required></label>
      <input type="hidden" name="id" id="device-id">
      <p><button type="submit">Get key and connect</button>
      <button type="button" class="secondary" id="search">Search again</button></p>
    </form>
  </div>
  <div class="card" id="controls" hidden>
    <button type="button" id="cool">Cool</button>
    <button type="button" id="fan">Fan</button>
  </div>
<script>
const message = document.querySelector("#message");
const error = document.querySelector("#error");
const status = document.querySelector("#status");
const login = document.querySelector("#login");
const controls = document.querySelector("#controls");

function fahrenheit(celsius) {
  if (celsius === null || celsius === undefined) return "—";
  return (celsius * 9 / 5 + 32).toFixed(1) + " F (" + Number(celsius).toFixed(1) + " C)";
}

function modeLabel(mode) {
  if (mode === "COOL") return "Cool";
  if (mode === "FAN_ONLY") return "Fan";
  return mode || "—";
}

function render(state) {
  message.textContent = state.message || "";
  error.textContent = state.error || "";
  const devices = state.devices || [];
  login.hidden = state.linked;
  controls.hidden = !state.linked;
  if (!state.linked && devices.length) {
    document.querySelector("#device-id").value = devices[0].id;
  }
  const lines = [];
  if (state.device_name || state.device_ip) {
    lines.push((state.device_name || "AC") + " at " + (state.device_ip || ""));
  } else if (devices.length) {
    lines.push(devices.map(d => (d.name || "AC") + " at " + d.ip).join(", "));
  }
  if (state.linked) {
    lines.push(state.online ? "Online" : "No answer");
    lines.push("Power: " + (state.power ? "on" : "off"));
    lines.push("Mode: " + modeLabel(state.mode));
    lines.push("Set point: " + fahrenheit(state.target_c));
    lines.push("Room: " + fahrenheit(state.indoor_c));
  }
  status.textContent = lines.join(String.fromCharCode(10));
  status.style.whiteSpace = "pre-line";
  for (const button of document.querySelectorAll("button")) button.disabled = !!state.busy;
}

async function post(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {"Content-Type": "application/json"},
    body: JSON.stringify(body || {})
  });
  const data = await response.json();
  if (data.trace && data.trace.length) {
    data.trace.forEach((entry) => {
      let parsed = entry.response;
      try { parsed = JSON.parse(entry.response); } catch (err) { /* raw text */ }
      console.log(entry.label, entry.status, entry.url);
      console.log("request", entry.request);
      console.log("response", parsed);
    });
  }
  render(data);
}

document.querySelector("#link-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  post("/api/link", {
    id: form.get("id"),
    account: form.get("account"),
    password: form.get("password")
  });
  event.target.password.value = "";
});
document.querySelector("#search").addEventListener("click", () => post("/api/search"));
document.querySelector("#cool").addEventListener("click", () => post("/api/mode", {mode: "cool"}));
document.querySelector("#fan").addEventListener("click", () => post("/api/mode", {mode: "fan"}));

async function poll() {
  try {
    const response = await fetch("/api/state");
    render(await response.json());
  } catch (err) {
    error.textContent = "Page lost the local server.";
  }
}
poll();
setInterval(poll, 2000);
</script>
</body>
</html>
"""


def serve():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    LOG.info("Open http://%s:%s", HOST, PORT)
    server.serve_forever()


async def main():
    global LOOP
    LOOP = asyncio.get_running_loop()
    threading.Thread(target=serve, name="http", daemon=True).start()
    async with LOCK:
        await startup()
    await asyncio.Event().wait()


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
