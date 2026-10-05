// Night cycle for the bedroom air conditioner. The phase is the wall-clock
// slot counted from the start time. This file does not talk to the dongle.
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "schedule.json");
const FANS = ["Auto", "Low", "Medium", "High", "Silent", "Turbo"];
const DAY = 24 * 60 * 60;

const defaults = {
  enabled: false,
  start: "20:00:00",
  end: "08:00:00",
  coolMinutes: 9,
  fanMinutes: 11,
  scheduleFan: "Low",
};

function clampMinutes(value, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(180, Math.max(1, number));
}

function parseClock(value, fallback) {
  const parts = String(value || "").split(":");
  const hour = Number(parts[0]);
  const minute = Number(parts[1]);
  const second = parts.length > 2 ? Number(parts[2]) : 0;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return fallback;
  if (!Number.isInteger(minute) || minute < 0 || minute > 59) return fallback;
  if (!Number.isInteger(second) || second < 0 || second > 59) return fallback;
  return [hour, minute, second].map((part) => String(part).padStart(2, "0")).join(":");
}

function clockSeconds(value) {
  const [hour, minute, second] = value.split(":").map(Number);
  return hour * 3600 + minute * 60 + second;
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return normalize(saved);
  } catch (err) {
    return { ...defaults };
  }
}

function normalize(input) {
  const fan = FANS.includes(input.scheduleFan) ? input.scheduleFan : defaults.scheduleFan;
  return {
    enabled: input.enabled === true,
    start: parseClock(input.start, defaults.start),
    end: parseClock(input.end, defaults.end),
    coolMinutes: clampMinutes(input.coolMinutes, defaults.coolMinutes),
    fanMinutes: clampMinutes(input.fanMinutes, defaults.fanMinutes),
    scheduleFan: fan,
  };
}

function saveSettings(settings) {
  const next = normalize(settings);
  const temp = FILE + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(next, null, 2));
  fs.renameSync(temp, FILE);
  return next;
}

function insideWindow(nowSec, startSec, endSec) {
  if (startSec === endSec) return false;
  if (startSec < endSec) return nowSec >= startSec && nowSec < endSec;
  return nowSec >= startSec || nowSec < endSec;
}

function slot(now, settings) {
  if (!settings.enabled) return { phase: "idle", secondsLeft: 0 };
  const nowSec = now.getHours() * 3600 + now.getMinutes() * 60 + now.getSeconds();
  const startSec = clockSeconds(settings.start);
  const endSec = clockSeconds(settings.end);
  if (!insideWindow(nowSec, startSec, endSec)) return { phase: "waiting", secondsLeft: 0 };
  let offset = nowSec - startSec;
  if (offset < 0) offset += DAY;
  const cool = settings.coolMinutes * 60;
  const fan = settings.fanMinutes * 60;
  const into = offset % (cool + fan);
  if (into < cool) return { phase: "cool", secondsLeft: cool - into };
  return { phase: "fan", secondsLeft: cool + fan - into };
}

function view(now, settings) {
  return { ...settings, ...slot(now, settings) };
}

module.exports = { loadSettings, saveSettings, slot, view, defaults };
