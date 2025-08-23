// www/js/event-core.js

export const eventCore = {
  async save(eventType, payload) {
    try {
      const ctx = window.getAnimalFromContext?.() || {};
      console.log("🚀 getContext() = ", ctx);

      const fullPayload = {
        ...payload,
        eventType,
        userId: window.currentUserId || localStorage.getItem("userId") || "demo-user",
        source: location.pathname
      };
      console.log("📦 Payload to save:", fullPayload);

      const API_BASE = window.API_BASE || "";
      const res = await fetch(`${API_BASE}/api/events`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-User-Id": window.currentUserId || localStorage.getItem("userId") || "demo-user"
        },
        body: JSON.stringify(fullPayload)
      });

      console.log("🌐 Response status:", res.status);
      const data = await res.json().catch(() => ({}));
      console.log("🌐 Response data:", data);

      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      return data;
    } catch (err) {
      console.error("❌ eventCore.save error:", err);
      throw err;
    }
  }
};
