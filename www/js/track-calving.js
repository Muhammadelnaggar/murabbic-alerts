// تتبّع ذكي منفصل — بلا أي تأثير بصري
export function onCalvingSave(meta = {}) {
try { t.event('calving_save', meta); } catch (e) {}
}
export function onCalvingPrefill(meta = {}) {
try { t.event('calving_prefill', meta); } catch (e) {}
}
