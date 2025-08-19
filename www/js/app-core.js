(() => {
'use strict';
window.dataLayer = window.dataLayer || [];
if (!window.t) window.t = {};
window.t.event = function(name, props){
try {
window.dataLayer.push({ event: name, ts: Date.now(), ...(props||{}) });
} catch (_) { /* لا توقف الصفحة */ }
};
document.addEventListener('DOMContentLoaded', function(){
window.t.event('page_view', { page: location.pathname });
});
})();
