const state = {
  mode: "Off",
  fan: "Low",
  scheduleFan: "Low",
  start: "20:00:00",
  end: "08:00:00",
  cool: 9,
  fanMinutes: 11,
  schedule: false,
  phase: "idle",
  secondsLeft: 0,
  eco: false,
};

const home = document.getElementById("home");
const schedule = document.getElementById("schedule");
const banner = document.getElementById("banner");
const title = document.getElementById("title");
const coolInput = document.getElementById("cool-min");
const fanInput = document.getElementById("fan-min");
const sheet = document.getElementById("sheet");
const face = document.getElementById("face");

let clock = { which: "start", hour: 8, minute: 0, ap: "PM" };
let online = false;
let ecoWatch = null;

function armEcoWatch() {
  if (ecoWatch) return;
  const watch = { sent: false, pending: null };
  ecoWatch = watch;
  window.setTimeout(() => {
    if (ecoWatch !== watch || watch.sent || !state.eco) return;
    watch.sent = true;
    post("/climate/" + encodeURIComponent("Air Conditioner") + "/set?preset=NONE").catch(() => setOnline(false));
  }, 50);
  window.setTimeout(() => {
    if (ecoWatch !== watch) return;
    ecoWatch = null;
    if (watch.sent) state.eco = false;
    else if (watch.pending != null) state.eco = watch.pending;
    render();
  }, 500);
}

function cancelEcoWatch() {
  ecoWatch = null;
}

function noteEco(ecoOn) {
  if (!ecoWatch) {
    state.eco = ecoOn;
    return;
  }
  ecoWatch.pending = ecoOn;
  if (!ecoOn || ecoWatch.sent) return;
  ecoWatch.sent = true;
  post("/climate/" + encodeURIComponent("Air Conditioner") + "/set?preset=NONE").catch(() => setOnline(false));
}

function pad(n) {
  return String(n).padStart(2, "0");
}

function fromValue(value) {
  const parts = String(value || "00:00:00").split(":");
  const hh = Number(parts[0]) || 0;
  const minute = Number(parts[1]) || 0;
  const ap = hh >= 12 ? "PM" : "AM";
  let hour = hh % 12;
  if (hour === 0) hour = 12;
  return { hour, minute, ap };
}

function toValue(hour, minute, ap) {
  let h = hour % 12;
  if (ap === "PM") h += 12;
  return pad(h) + ":" + pad(minute) + ":00";
}

function showClockText(value, hmId, apId) {
  const faceTime = fromValue(value);
  document.getElementById(hmId).textContent = faceTime.hour + ":" + pad(faceTime.minute);
  document.getElementById(apId).textContent = faceTime.ap;
}

async function post(path) {
  const response = await fetch("/stick" + path, { method: "POST" });
  if (!response.ok) throw new Error(String(response.status));
}

function formatLeft(seconds) {
  const whole = Math.max(0, Math.floor(Number(seconds) || 0));
  const minutes = Math.floor(whole / 60);
  const remain = whole % 60;
  return minutes + ":" + pad(remain);
}

function setOnline(next) {
  online = next;
  banner.hidden = next;
}

function render() {
  title.textContent = state.mode === "Off" ? "Off" : state.mode;
  document.querySelectorAll(".mode").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.mode === state.mode ? "true" : "false");
  });
  document.querySelectorAll(".speed").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.speed === state.fan ? "true" : "false");
  });
  document.querySelectorAll(".sched-speed").forEach((button) => {
    button.setAttribute("aria-pressed", button.dataset.speed === state.scheduleFan ? "true" : "false");
  });
  const eco = document.getElementById("eco");
  eco.setAttribute("aria-pressed", state.eco ? "true" : "false");
  document.getElementById("eco-label").textContent = state.eco ? "On" : "Off";
  const scheduleToggle = document.getElementById("schedule-toggle");
  scheduleToggle.setAttribute("aria-pressed", state.schedule ? "true" : "false");
  document.getElementById("schedule-label").textContent = state.schedule ? "On" : "Off";
  const phaseNames = { cool: "Cool", fan: "Fan", waiting: "Waiting", idle: "Idle", "no clock": "No clock" };
  document.getElementById("phase-name").textContent = phaseNames[state.phase] || "Idle";
  const phaseLeft = document.getElementById("phase-left");
  phaseLeft.textContent = state.phase === "cool" || state.phase === "fan" ? formatLeft(state.secondsLeft) + " left" : "";
  showClockText(state.start, "start-hm", "start-ap");
  showClockText(state.end, "end-hm", "end-ap");
  if (document.activeElement !== coolInput) coolInput.value = String(state.cool);
  if (document.activeElement !== fanInput) fanInput.value = String(state.fanMinutes);
}

function applyEntity(message) {
  if (message.id === "select/Mode" && message.value) {
    if (state.mode === "Off" && message.value !== "Off") armEcoWatch();
    if (message.value === "Off") cancelEcoWatch();
    state.mode = message.value;
  }
  if (message.id === "select/Fan speed" && message.value) state.fan = message.value;
  if (message.id === "select/Schedule fan" && message.value) state.scheduleFan = message.value;
  if (message.id === "time/Window start" && message.value) state.start = message.value;
  if (message.id === "time/Window end" && message.value) state.end = message.value;
  if (message.id === "number/Cool minutes" && message.value != null) state.cool = Number(message.value);
  if (message.id === "number/Fan minutes" && message.value != null) state.fanMinutes = Number(message.value);
  if (message.id === "switch/Schedule") state.schedule = message.value === true || message.state === "ON";
  if (message.id === "text_sensor/Schedule phase" && message.value) state.phase = message.value;
  if (message.id === "sensor/Phase seconds" && message.value != null) state.secondsLeft = Number(message.value);
  if (message.id === "climate/Air Conditioner") noteEco(message.preset === "ECO");
  setOnline(true);
  render();
}

function connect() {
  const source = new EventSource("/stick/events");
  source.addEventListener("state", (event) => {
    try {
      applyEntity(JSON.parse(event.data));
    } catch (err) {
      console.error(err);
    }
  });
  source.addEventListener("ping", () => setOnline(true));
  source.onerror = () => {
    setOnline(false);
    source.close();
    window.setTimeout(connect, 3000);
  };
}

function showScreen(name) {
  const onHome = name === "home";
  home.hidden = !onHome;
  schedule.hidden = onHome;
  document.getElementById("nav-home").setAttribute("aria-current", onHome ? "page" : "false");
  document.getElementById("nav-schedule").setAttribute("aria-current", onHome ? "false" : "page");
  if (onHome) history.replaceState(null, "", "/");
  else history.replaceState(null, "", "#schedule");
}

document.getElementById("nav-home").addEventListener("click", () => showScreen("home"));
document.getElementById("nav-schedule").addEventListener("click", () => showScreen("schedule"));

document.querySelectorAll(".mode").forEach((button) => {
  button.addEventListener("click", async () => {
    const previous = state.mode;
    const next = button.dataset.mode;
    if (previous === "Off" && next !== "Off") armEcoWatch();
    if (next === "Off") cancelEcoWatch();
    state.mode = next;
    render();
    try {
      await post("/select/Mode/set?option=" + encodeURIComponent(state.mode));
    } catch (err) {
      state.mode = previous;
      if (previous === "Off") cancelEcoWatch();
      render();
      setOnline(false);
    }
  });
});

document.querySelectorAll(".speed").forEach((button) => {
  button.addEventListener("click", async () => {
    const previous = state.fan;
    state.fan = button.dataset.speed;
    render();
    try {
      await post("/select/Fan%20speed/set?option=" + encodeURIComponent(state.fan));
    } catch (err) {
      state.fan = previous;
      render();
      setOnline(false);
    }
  });
});

document.querySelectorAll(".sched-speed").forEach((button) => {
  button.addEventListener("click", async () => {
    const previous = state.scheduleFan;
    state.scheduleFan = button.dataset.speed;
    render();
    try {
      await post("/select/Schedule%20fan/set?option=" + encodeURIComponent(state.scheduleFan));
    } catch (err) {
      state.scheduleFan = previous;
      render();
      setOnline(false);
    }
  });
});

document.getElementById("eco").addEventListener("click", async () => {
  cancelEcoWatch();
  const previous = state.eco;
  state.eco = !state.eco;
  render();
  try {
    await post("/climate/" + encodeURIComponent("Air Conditioner") + "/set?preset=" + (state.eco ? "ECO" : "NONE"));
  } catch (err) {
    state.eco = previous;
    render();
    setOnline(false);
  }
});

document.getElementById("display").addEventListener("click", async () => {
  const button = document.getElementById("display");
  button.disabled = true;
  try {
    await post("/button/" + encodeURIComponent("Air Conditioner Display Toggle") + "/press");
  } catch (err) {
    setOnline(false);
  } finally {
    button.disabled = false;
  }
});

document.getElementById("schedule-toggle").addEventListener("click", async () => {
  const previous = state.schedule;
  state.schedule = !state.schedule;
  render();
  try {
    await post("/switch/Schedule/" + (state.schedule ? "turn_on" : "turn_off"));
  } catch (err) {
    state.schedule = previous;
    render();
    setOnline(false);
  }
});

function clampMinutes(value) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return null;
  return Math.min(180, Math.max(1, number));
}

async function commitMinutes(field) {
  const input = field === "cool" ? coolInput : fanInput;
  const key = field === "cool" ? "cool" : "fanMinutes";
  const next = clampMinutes(input.value);
  if (next == null) {
    input.value = String(state[key]);
    return;
  }
  const previous = state[key];
  state[key] = next;
  input.value = String(next);
  const name = field === "cool" ? "Cool minutes" : "Fan minutes";
  try {
    await post("/number/" + encodeURIComponent(name) + "/set?value=" + next);
  } catch (err) {
    state[key] = previous;
    input.value = String(previous);
    setOnline(false);
  }
}

document.querySelectorAll(".nudge").forEach((button) => {
  button.addEventListener("click", () => {
    const field = button.dataset.field;
    const input = field === "cool" ? coolInput : fanInput;
    const current = clampMinutes(input.value) || 1;
    input.value = String(current + Number(button.dataset.dir));
    commitMinutes(field);
  });
});
coolInput.addEventListener("change", () => commitMinutes("cool"));
fanInput.addEventListener("change", () => commitMinutes("fan"));

function paintClock() {
  document.getElementById("clock-hm").textContent = clock.hour + ":" + pad(clock.minute);
  document.getElementById("ap-am").setAttribute("aria-pressed", clock.ap === "AM" ? "true" : "false");
  document.getElementById("ap-pm").setAttribute("aria-pressed", clock.ap === "PM" ? "true" : "false");
  const hourAngle = ((clock.hour % 12) * 30) + (clock.minute * 0.5);
  document.getElementById("hour-hand").style.transform = "rotate(" + hourAngle + "deg)";
  document.getElementById("minute-hand").style.transform = "rotate(" + (clock.minute * 6) + "deg)";
  document.querySelectorAll(".hour-num").forEach((button) => {
    button.setAttribute("aria-pressed", Number(button.dataset.hour) === clock.hour ? "true" : "false");
  });
  document.querySelectorAll(".min-dot").forEach((button) => {
    button.setAttribute("aria-pressed", Number(button.dataset.minute) === clock.minute ? "true" : "false");
  });
}

function openClock(which) {
  clock.which = which;
  const source = which === "start" ? state.start : state.end;
  const parsed = fromValue(source);
  clock.hour = parsed.hour;
  clock.minute = parsed.minute;
  clock.ap = parsed.ap;
  document.getElementById("clock-title").textContent = which === "start" ? "Start" : "End";
  paintClock();
  sheet.hidden = false;
}

function closeClock() {
  sheet.hidden = true;
}

function placeFace() {
  for (let n = 1; n <= 12; n += 1) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "hour-num";
    button.dataset.hour = String(n);
    button.textContent = String(n);
    const angle = (n % 12) * Math.PI / 6;
    button.style.left = (50 + Math.sin(angle) * 34) + "%";
    button.style.top = (50 - Math.cos(angle) * 34) + "%";
    button.addEventListener("click", () => {
      clock.hour = n;
      paintClock();
    });
    face.appendChild(button);
  }
  for (let step = 0; step < 12; step += 1) {
    const minute = step * 5;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "min-dot";
    button.dataset.minute = String(minute);
    button.setAttribute("aria-label", minute + " minutes");
    const angle = step * Math.PI / 6;
    button.style.left = (50 + Math.sin(angle) * 46) + "%";
    button.style.top = (50 - Math.cos(angle) * 46) + "%";
    button.addEventListener("click", () => {
      clock.minute = minute;
      paintClock();
    });
    face.appendChild(button);
  }
}

document.getElementById("open-start").addEventListener("click", () => openClock("start"));
document.getElementById("open-end").addEventListener("click", () => openClock("end"));
document.getElementById("clock-cancel").addEventListener("click", closeClock);
document.getElementById("ap-am").addEventListener("click", () => { clock.ap = "AM"; paintClock(); });
document.getElementById("ap-pm").addEventListener("click", () => { clock.ap = "PM"; paintClock(); });
document.getElementById("min-down").addEventListener("click", () => {
  clock.minute = (clock.minute + 59) % 60;
  paintClock();
});
document.getElementById("min-up").addEventListener("click", () => {
  clock.minute = (clock.minute + 1) % 60;
  paintClock();
});
document.getElementById("clock-set").addEventListener("click", async () => {
  const value = toValue(clock.hour, clock.minute, clock.ap);
  const key = clock.which === "start" ? "start" : "end";
  const previous = state[key];
  state[key] = value;
  render();
  closeClock();
  const name = key === "start" ? "Window start" : "Window end";
  try {
    await post("/time/" + encodeURIComponent(name) + "/set?value=" + encodeURIComponent(value));
  } catch (err) {
    state[key] = previous;
    render();
    setOnline(false);
  }
});
sheet.addEventListener("click", (event) => {
  if (event.target === sheet) closeClock();
});

if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

placeFace();
render();
showScreen(location.hash === "#schedule" ? "schedule" : "home");
connect();
