// /js/track-calving.js
import { track } from '/js/track-core.js';

export const onCalvingPrefill = (m = {}) => track('calving_prefill', m);
export const onCalvingSave    = (m = {}) => track('calving_save', m);
