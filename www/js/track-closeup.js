// /js/track-closeup.js
import { track } from '/js/track-core.js';

export const onCloseupPrefill = (m = {}) => track('closeup_prefill', m);
export const onCloseupSave    = (m = {}) => track('closeup_save', m);
