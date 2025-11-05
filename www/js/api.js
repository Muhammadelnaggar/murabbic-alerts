// api.js — Murabbik Alerts API Base
console.log("✅ api.js loaded");

window.API_BASE = "https://murabbic-alerts.onrender.com";

export async function apiGet(path){
  const uid = window.userId || localStorage.getItem("userId");
  const r = await fetch(`${API_BASE}${path}`, {
    headers: {
      "X-User-Id": uid || ""
    }
  });
  return r.json();
}
