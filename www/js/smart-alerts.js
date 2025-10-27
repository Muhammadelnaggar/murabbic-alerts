// /js/smart-alerts.js
// ======================
// مُرَبِّك – نظام تنبيهات فوري بصوت Popup
// يعتمد على buildTimelineAlertsFor() من alerts-engine.js

import { buildTimelineAlertsFor } from '/js/alerts-engine.js';
import { getAnimalEvents } from '/js/api.js';

const audio = new Audio('/sounds/alert.mp3'); // ضع صوتك هنا (ملف قصير mp3 في www/sounds)

export async function showSmartAlerts(animal){
  try {
    const events = await getAnimalEvents(animal.id || animal.animalNumber);
    const alerts = buildTimelineAlertsFor(animal, events, new Date());
    if (!alerts.length) return;

    alerts.forEach(a => renderPopup(a));
    playSound();
  } catch(err){
    console.error('⚠️ smart-alerts error:', err);
  }
}

function renderPopup(alert){
  const popup = document.createElement('div');
  popup.className = `murabbik-popup ${alert.level}`;
  popup.innerHTML = `
    <div class="head">${alert.name}</div>
    <div class="msg">${alert.message}</div>
    ${alert.link ? `<a href="${alert.link}" class="link">فتح الصفحة</a>` : ''}
  `;
  document.body.appendChild(popup);
  setTimeout(()=> popup.classList.add('show'), 50);
  setTimeout(()=> closePopup(popup), 15000);
  popup.addEventListener('click', ()=> closePopup(popup));
}

function closePopup(el){
  el.classList.remove('show');
  setTimeout(()=> el.remove(), 300);
}

function playSound(){
  try { audio.currentTime = 0; audio.play().catch(()=>{}); } catch(e){}
}

// ====== تنسيقات CSS داخلية ======
const style = document.createElement('style');
style.textContent = `
.murabbik-popup{
  position:fixed;
  top:20px;
  right:-400px;
  width:280px;
  padding:12px 14px;
  border-radius:14px;
  color:#fff;
  font:15px 'Cairo',sans-serif;
  box-shadow:0 4px 12px rgba(0,0,0,.15);
  transition:all .4s ease;
  z-index:999999;
  cursor:pointer;
  backdrop-filter: blur(8px);
}
.murabbik-popup.show{ right:20px; opacity:1; }
.murabbik-popup .head{font-weight:900;margin-bottom:4px;}
.murabbik-popup .msg{font-size:14px;line-height:1.4;}
.murabbik-popup .link{
  display:inline-block;
  margin-top:6px;
  background:rgba(255,255,255,.2);
  color:#fff;
  padding:4px 8px;
  border-radius:8px;
  font-weight:700;
  text-decoration:none;
}
.murabbik-popup.info{background:#0ea05a;}
.murabbik-popup.notice{background:#facc15;color:#222;}
.murabbik-popup.warning{background:#fb923c;}
.murabbik-popup.alert{background:#dc2626;}
`;
document.head.appendChild(style);
