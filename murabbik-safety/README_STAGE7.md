# مُرَبِّيك — Stage7، حفظ علامات تغيّر البيانات داخل معاملات Firestore

**حالة الكود:** مرشح محلي غير منشور، القراءة المُجهّزة موقوفة بالكود. هذا ليس إصلاحًا مكتملًا لبطء GET.

## نقطة البداية المثبتة

- مرشح Stage6: `server_stage6_candidate.js`, SHA256: `297ad40aae1deabb3cc7d6ebb56cddea4cc500197f040913d0aef36f05950adf`.
- مرشح Stage7 الناتج: `server_stage7_candidate.js`, SHA256: `d51b2e397798f54782be6872337e095e7192f014f7e9b00a8ffb3b1a69197a69`.
- التغيير الوحيد أربع إضافات `appendToTransactionIfEnabled` داخل معاملات Firestore الناجحة، تحت إعداد `MURABBIK_PREPARED_MUTATION_TRACKING=1` الذي يظل **مطفأ افتراضيًا**.

## المسارات الأربعة المغطاة هنا

1. `POST /api/vaccination/farm-program` — بعد كتابة نسخة برنامج التحصينات وإعداداته، وقبل نجاح المعاملة.
2. `POST /api/abortion/save` — بعد كتابة حدث الإجهاض وتحديث الحيوان، لا عند اكتشاف تكرار الإجهاض.
3. `POST /api/daily-milk/session/save` — بعد تحديث الحلبة (collecting أو complete)، لا عند رفض الحلبة.
4. `POST /api/hoof-trimming/save` — عند إنشاء الحدث لأول مرة، لا عند وجوده سابقًا.

**إجمالي المسارات المغطاة في Stage6+7 = 18** وليس كل المسارات.

## الاختبارات

`python3 build_stage7.py` يعيد بناء نفس المرشح من Stage6 ببصمة SHA256 مطلوبة، ويرفض أي أساس آخر.

`node --check server_stage7_candidate.js`

`node --test tests/test-mutation-barrier.cjs test-prepared-read.cjs test-get-integration.cjs test-prepared-publisher.cjs test_stage7_atomic_routes.cjs`

نتيجة هذه الحزمة: **62 اختبارًا ناجحًا، 0 فشل**، Mock/Static وليست Firestore فعليًا. `stage6_to_stage7.patch` يصف الفروق الأربعة كاملة. إزالة الإضافات الأربع ترجع Stage6 حرفيًا.

## ممنوع النشر وتفعيل التسريع

- `ALL_SMART_ALERT_SOURCES_MIGRATED_AND_CERTIFIED=false` ما زال ثابتًا.
- لا تفعل `MURABBIK_PREPARED_READ_ENABLE` أو `MURABBIK_PREPARED_MUTATION_TRACKING` على Render.
- **غير مغطّى:** الاستيراد الجماعي والتصحيح/الحذف عبر كل القنوات، بعض عمليات تحديث الحيوانات والتحصين، BVD التاريخي، إغلاق الآثار الجانبية من GET، ومواعيد المصادر الـ11 بتوقيت المزرعة.
- تحديث وثيقة Generation واحدة لكل مزرعة قد يُحدث **write contention** في المزارع شديدة النشاط؛ يجب قياسه قبل تمكين الميزة، وعدم استنتاج أداء 1000 مستخدم من الاختبارات الحالية.
- لا تغيّر `main`، ولا Render، ولا تنشر المرشح قبل مراجعة تكافؤ وظيفية وتشغيلية فعلية.

## عند الاستكمال

اقرأ `README_CONTINUE_GITHUB.md`، ثم كود Stage7 وفروقه، وحدد مسارات الكتابة المتبقية **بأدلة من الكود**، ولا تكرر الفحص النظري بلا إصلاحات. راقب خطر تنازع تحديث الوثيقة المركزية؛ إن لم تثبت كفاءته، أعد تقييم التصميم قبل توسيع التغطية.