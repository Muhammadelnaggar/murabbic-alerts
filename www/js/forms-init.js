// /js/forms-init.js — Murabbik Central Gate (ESM)
// ✅ بوابة قطيع مركزية: تمنع أي حفظ/تسجيل لحيوان غير موجود أو خارج القطيع
// ✅ UI مركزي (Infobar) يدعم Actions بدون أعطال DOM
// ✅ لا تُجمّد الصفحة: تترك إدخال رقم الحيوان متاح دائمًا وتمنع "الحفظ فقط"

import { db } from "./firebase-config.js";
import { uniqueAnimalNumber } from "./form-rules.js";
import {
  collection, query, where, limit, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

/* ----------------- Helpers ----------------- */
function qs(k){ return new URL(location.href).searchParams.get(k) || ""; }
function firstNonEmpty(...v){ return v.find(x => String(x||"").trim() !== "") || ""; }
function today(){ return new Date().toISOString().slice(0,10); }

function getUid(){
  return String(
    window.__tenant?.userId ||
    localStorage.getItem("userId") ||
    localStorage.getItem("tenantId") ||
    localStorage.getItem("ownerUid") ||
    ""
  ).trim();
}

function normDigits(s){
  const map={'٠':'0','١':'1','٢':'2','٣':'3','٤':'4','٥':'5','٦':'6','٧':'7','٨':'8','٩':'9',
             '۰':'0','۱':'1','۲':'2','۳':'3','۴':'4','۵':'5','۶':'6','۷':'7','۸':'8','۹':'9'};
  return String(s||"").trim()
    .replace(/[^\d٠-٩۰-۹]/g,'')
    .replace(/[٠-٩۰-۹]/g, d=>map[d]);
}

function getNumberFromCtx(){
  return normDigits(firstNonEmpty(
    qs("number"), qs("animalNumber"), qs("animalId"),
    localStorage.getItem("lastAnimalId"),
    localStorage.getItem("currentAnimalId"),
    localStorage.getItem("lastAnimalNumber")
  ));
}

function getDateFromCtx(){
  return String(firstNonEmpty(
    qs("date"), qs("eventDate"),
    localStorage.getItem("lastEventDate"),
    localStorage.getItem("eventDate"),
    today()
  )).trim();
}

function getNumberFromDom(){
  const el = document.querySelector(
    "#animalNumber,#animalId,[name='animalNumber'],[name='animalId'],[data-field='animalNumber'],[data-field='animalId']"
  );
  return normDigits(el?.value || "");
}

function prefillCtx(){
  const n = getNumberFromCtx();
  const d = getDateFromCtx();

  const numEl = document.querySelector(
    "#animalNumber,#animalId,[name='animalNumber'],[name='animalId'],[data-field='animalNumber'],[data-field='animalId']"
  );
  const dtEl  = document.querySelector("#eventDate,[name='eventDate'],[data-field='eventDate']");

  if (numEl && !String(numEl.value||"").trim() && n) numEl.value = n;
  if (dtEl  && !String(dtEl.value||"").trim() && d) dtEl.value  = d;
}

function animalLabel(doc){
  const sp = String(doc?.species || doc?.animalTypeAr || doc?.animalType || "").trim();
  if (/جاموس/i.test(sp) || sp === "جاموس") return "هذه الجاموسة";
  if (/بقر/i.test(sp)   || sp === "أبقار")  return "هذه البقرة";
  return "هذا الحيوان";
}

/* ----------------- UI: Infobar (Central, with actions) ----------------- */
function ensureBar(){
  // لو الصفحة عاملة Infobar متقدم (زي calving) استخدمه كما هو
  let bar = document.getElementById("info");

  // fallback: أنشئ Infobar موحد إن لم يوجد
  if (!bar){
    const host = document.querySelector(".infobar-wrap")
      || document.querySelector(".mbk-form")
      || document.querySelector("main")
      || document.body;

    bar = document.createElement("div");
    bar.id = "info";
    bar.className = "infobar";
    bar.style.cssText =
      "margin:8px 0;padding:10px 12px;borde
