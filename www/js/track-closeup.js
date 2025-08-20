export function onCloseupSave(meta = {}) {
try { t.event('closeup_save', meta); } catch (e) {}
}
export function onCloseupPrefill(meta = {}) {
try { t.event('closeup_prefill', meta); } catch (e) {}
}
