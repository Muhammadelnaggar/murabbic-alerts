export function track(name, meta = {}) {
try { t.event(name, meta); } catch (e) {}
}
