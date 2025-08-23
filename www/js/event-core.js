export async function save(eventType, payload) {
  try {
    const ctx = window.getAnimalFromContext ? window.getAnimalFromContext() : {};
    console.log("🚀 getContext() =", ctx);

    const body = {
      type: eventType,
      ...payload,
      userId: ctx.userId || localStorage.getItem("userId") || null,
    };

    console.log("📦 Payload to save:", body);

    const headers = {
      "Content-Type": "application/json",
      "X-User-Id": body.userId || "",
    };

    console.log("📡 Sending fetch to /api/events with headers:", headers);

    const res = await fetch("/api/events", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    console.log("🌐 Response status:", res.status);

    if (!res.ok) {
      const text = await res.text();
      console.error("❌ Server responded with:", text);
      throw new Error("Server error: " + text);
    }

    return await res.json();
  } catch (err) {
    console.error("🔥 save() failed:", err);
    throw err;
  }
}
