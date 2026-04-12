// /js/import-profiles.js

function normKey(v) {
  return String(v || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export const DairyCompProfile = {
  key: "dairycomp",
  label: "DairyComp",

  detect: {
    requiredHeadersAny: ["id", "bdat", "milk", "rpro", "tbrd"],
    preferredHeaders: ["sid", "dim", "lact", "status", "breed", "lcalv", "lserv"],
    forbiddenHeaders: []
  },

  columnMap: {
    animalNumber: ["id", "animal id", "animal number", "number"],
    animalType: ["type", "species", "animal type", "kind"],
    breed: ["breed"],
    birthDate: ["bdat", "birth date", "birthdate", "dob", "date of birth"],
    productionStatus: ["status", "prod", "production status", "lactation status"],
    dailyMilk: ["milk", "milk yield", "daily milk", "yield"],
    reproductiveStatus: ["rpro", "repro", "repro status", "reproductive status"],
    servicesCount: ["tbrd", "times bred", "services", "service count", "breedings"],
    lactationNumber: ["lact", "lactation", "lactation no"],
    sireNumber: ["sid", "sire", "sire id", "bull id", "sire bull id", "bull number"],
    lastCalvingDate: ["lcalv", "last calving", "last calving date", "calving date", "fresh date"],
    lastInseminationDate: ["lserv", "last service", "service date", "last breeding date", "last insemination date"],
    daysInMilk: ["dim", "days in milk"]
  },

  valueMap: {
    animalType: {
      "cow": "بقرة",
      "cattle": "بقرة",
      "dairy cow": "بقرة",
      "buffalo": "جاموسة",
      "water buffalo": "جاموسة",
      "dairy buffalo": "جاموسة"
    },

    productionStatus: {
      "lactating": "حلاب",
      "milking": "حلاب",
      "in milk": "حلاب",
      "dry": "جاف",
      "dry cow": "جاف",
      "close-up": "جاف",
      "close up": "جاف",
      "waiting calving": "جاف",
      "springer": "جاف",
      "prefresh": "جاف"
    },

    reproductiveStatus: {
      "preg": "عشار",
      "pregnant": "عشار",
      "confirmed pregnant": "عشار",

      "bred": "ملقحة",
      "inseminated": "ملقحة",
      "served": "ملقحة",
      "mated": "ملقحة",

      "open": "مفتوحة",
      "empty": "مفتوحة",
      "not pregnant": "مفتوحة",

      "fresh": "حديث الولادة",
      "just calved": "حديث الولادة",
      "new calver": "حديث الولادة",

      "aborted": "إجهاض",
      "abort": "إجهاض"
    }
  },

  inferRules: {
    animalType(row) {
      if (row.animalType) return row.animalType;

      const breed = String(row.breed || "").trim();
      if (["بلدي", "هجين إيطالي", "هجين هندي"].includes(breed)) return "جاموسة";
      if (["هولشتاين", "جيرسي", "مونبليار", "سيمينتال", "خليط"].includes(breed)) return "بقرة";

      return "";
    },

    productionStatus(row) {
      if (row.productionStatus) return row.productionStatus;

      const milk = Number(row.dailyMilk || 0);
      const rawStatus = String(row._rawStatus || "").toLowerCase();

      if (milk > 0) return "حلاب";
      if (["dry", "dry cow", "close-up", "close up", "waiting calving", "springer", "prefresh"].includes(rawStatus)) {
        return "جاف";
      }

      return "";
    },

    reproductiveStatus(row) {
      if (row.reproductiveStatus) return row.reproductiveStatus;
      return "";
    }
  },

  requiredInternalFields: [
    "animalNumber",
    "animalType",
    "breed",
    "birthDate",
    "productionStatus",
    "dailyMilk",
    "reproductiveStatus",
    "servicesCount",
    "lactationNumber",
    "sireNumber",
    "lastCalvingDate",
    "lastInseminationDate",
    "daysInMilk"
  ],

  normalize: {
    animalNumber: "string",
    animalType: "string",
    breed: "string",
    birthDate: "date",
    productionStatus: "string",
    dailyMilk: "number",
    reproductiveStatus: "string",
    servicesCount: "integer",
    lactationNumber: "integer",
    sireNumber: "string",
    lastCalvingDate: "date",
    lastInseminationDate: "date",
    daysInMilk: "integer"
  },

  confidenceRules: {
    profileMatch(headers) {
      const h = headers.map(normKey);
      let score = 0;

      if (h.includes("id")) score += 3;
      if (h.includes("bdat")) score += 3;
      if (h.includes("milk")) score += 2;
      if (h.includes("rpro")) score += 3;
      if (h.includes("tbrd")) score += 4;
      if (h.includes("lact")) score += 2;
      if (h.includes("sid")) score += 2;
      if (h.includes("dim")) score += 2;

      return score;
    }
  }
};

export const DelProProfile = {
  key: "delpro",
  label: "DelPro",

  detect: {
    requiredHeadersAny: ["animal number", "birth date"],
    preferredHeaders: ["sire bull id", "dam number", "repro status", "milk yield"],
    forbiddenHeaders: []
  },

  columnMap: {
    animalNumber: ["animal number", "animal id", "number"],
    animalType: ["species", "animal type", "type"],
    breed: ["breed"],
    birthDate: ["birth date", "date of birth"],
    productionStatus: ["production status", "status"],
    dailyMilk: ["milk yield", "milk", "daily milk"],
    reproductiveStatus: ["repro status", "reproductive status"],
    servicesCount: ["times bred", "tbrd", "service count", "number of services", "breedings"],
    lactationNumber: ["lactation", "lactation no"],
    sireNumber: ["sire bull id", "sire id", "bull id", "orn"],
    lastCalvingDate: ["last calving date", "calving date"],
    lastInseminationDate: ["last insemination date", "service date"],
    daysInMilk: ["days in milk", "dim"],
    damNumber: ["dam number", "dam id"]
  },

  valueMap: {
    animalType: {
      "cow": "بقرة",
      "buffalo": "جاموسة"
    },

    productionStatus: {
      "lactating": "حلاب",
      "milking": "حلاب",
      "dry": "جاف",
      "close-up": "جاف",
      "waiting calving": "جاف"
    },

    reproductiveStatus: {
      "pregnant": "عشار",
      "bred": "ملقحة",
      "open": "مفتوحة",
      "fresh": "حديث الولادة",
      "aborted": "إجهاض"
    }
  },

  inferRules: {
    animalType(row) {
      if (row.animalType) return row.animalType;

      const b = String(row.breed || "").trim();
      if (["بلدي", "هجين إيطالي", "هجين هندي"].includes(b)) return "جاموسة";
      if (["هولشتاين", "جيرسي", "مونبليار", "سيمينتال", "خليط"].includes(b)) return "بقرة";

      return "";
    },

    productionStatus(row) {
      if (row.productionStatus) return row.productionStatus;
      if (Number(row.dailyMilk || 0) > 0) return "حلاب";
      return "";
    },

    reproductiveStatus(row) {
      if (row.reproductiveStatus) return row.reproductiveStatus;
      return "";
    }
  },

  requiredInternalFields: [
    "animalNumber",
    "animalType",
    "breed",
    "birthDate",
    "productionStatus",
    "dailyMilk",
    "reproductiveStatus",
    "servicesCount",
    "lactationNumber",
    "sireNumber",
    "lastCalvingDate",
    "lastInseminationDate",
    "daysInMilk"
  ],

  normalize: {
    animalNumber: "string",
    animalType: "string",
    breed: "string",
    birthDate: "date",
    productionStatus: "string",
    dailyMilk: "number",
    reproductiveStatus: "string",
    servicesCount: "integer",
    lactationNumber: "integer",
    sireNumber: "string",
    lastCalvingDate: "date",
    lastInseminationDate: "date",
    daysInMilk: "integer"
  },

  confidenceRules: {
    profileMatch(headers) {
      const h = headers.map(normKey);
      let score = 0;

      if (h.includes("animal number")) score += 4;
      if (h.includes("birth date")) score += 4;
      if (h.includes("sire bull id")) score += 2;
      if (h.includes("milk yield")) score += 2;
      if (h.includes("times bred")) score += 3;

      return score;
    }
  }
};

export const MurabbikNativeProfile = {
  key: "murabbik_native",
  label: "Murabbik Native",

  detect: {
    requiredHeadersAny: ["animalnumber", "animaltype", "breed", "birthdate"],
    preferredHeaders: ["productionstatus", "reproductivestatus", "dailymilk"],
    forbiddenHeaders: []
  },

  columnMap: {
    animalNumber: ["animalnumber"],
    animalType: ["animaltype"],
    breed: ["breed"],
    birthDate: ["birthdate"],
    productionStatus: ["productionstatus"],
    dailyMilk: ["dailymilk"],
    reproductiveStatus: ["reproductivestatus"],
    servicesCount: ["servicescount"],
    lactationNumber: ["lactationnumber"],
    sireNumber: ["sirenumber"],
    lastCalvingDate: ["lastcalvingdate"],
    lastInseminationDate: ["lastinseminationdate"],
    daysInMilk: ["daysinmilk"]
  },

  valueMap: {},
  inferRules: {},

  requiredInternalFields: [
    "animalNumber",
    "animalType",
    "breed",
    "birthDate",
    "productionStatus",
    "dailyMilk",
    "reproductiveStatus",
    "servicesCount",
    "lactationNumber",
    "sireNumber",
    "lastCalvingDate",
    "lastInseminationDate",
    "daysInMilk"
  ],

  normalize: {
    animalNumber: "string",
    animalType: "string",
    breed: "string",
    birthDate: "date",
    productionStatus: "string",
    dailyMilk: "number",
    reproductiveStatus: "string",
    servicesCount: "integer",
    lactationNumber: "integer",
    sireNumber: "string",
    lastCalvingDate: "date",
    lastInseminationDate: "date",
    daysInMilk: "integer"
  },

  confidenceRules: {
    profileMatch(headers) {
      const h = headers.map(v => normKey(v).replace(/\s+/g, ""));
      let score = 0;

      if (h.includes("animalnumber")) score += 5;
      if (h.includes("animaltype")) score += 5;
      if (h.includes("reproductivestatus")) score += 4;

      return score;
    }
  }
};

export const IMPORT_PROFILES = [
  MurabbikNativeProfile,
  DairyCompProfile,
  DelProProfile
];
