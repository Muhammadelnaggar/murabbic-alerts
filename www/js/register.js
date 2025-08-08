// register.js
import { auth, db } from './firebase-config.js';
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { doc, setDoc, serverTimestamp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const form = document.getElementById("registerForm");
const countrySelect = document.getElementById("country");
const governorateSelect = document.getElementById("governorate");

const regionsByCountry = {
  "مصر": ["القاهرة", "الجيزة", "الإسكندرية", "المنوفية", "الدقهلية", "الشرقية", "كفر الشيخ", "الغربية", "البحيرة", "الفيوم", "بني سويف", "المنيا", "أسيوط", "سوهاج", "قنا", "الأقصر", "أسوان", "البحر الأحمر", "شمال سيناء", "جنوب سيناء", "الوادي الجديد", "مطروح"],
  "السعودية": ["الرياض", "مكة", "المدينة", "القصيم", "الشرقية", "عسير", "تبوك", "حائل", "نجران", "جازان", "الباحة", "الجوف", "الحدود الشمالية"]
};

countrySelect.addEventListener("change", () => {
  const selectedCountry = countrySelect.value;
  governorateSelect.innerHTML = `<option value="">-- اختر المحافظة --</option>`;
  if (regionsByCountry[selectedCountry]) {
    regionsByCountry[selectedCountry].forEach(region => {
      const option = document.createElement("option");
      option.value = region;
      option.textContent = region;
      governorateSelect.appendChild(option);
    });
  }
});

form.addEventListener("submit", async (e) => {
  e.preventDefault();

  const fullName = document.getElementById("name").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const password = document.getElementById("password").value;
  const confirmPassword = document.getElementById("confirmPassword").value;
  const userType = document.getElementById("userType").value;
  const country = document.getElementById("country").value;
  const governorate = document.getElementById("governorate").value;
  const emailInput = document.getElementById("email").value.trim();
  const email = emailInput || `${phone}@murabbik.com`; // بريد وهمي لو الإيميل فارغ

  if (!fullName || !phone || !password || !confirmPassword || !userType || !country || !governorate) {
    alert("❗ جميع الحقول مطلوبة ما عدا البريد الإلكتروني");
    return;
  }

  if (password !== confirmPassword) {
    alert("❗ كلمة المرور وتأكيدها غير متطابقين");
    return;
  }

  try {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const uid = userCredential.user.uid;

    await setDoc(doc(db, "users", uid), {
      fullName,
      phone,
      userType,
      country,
      governorate,
      email,
      createdAt: serverTimestamp()
    });

    alert("✅ تم التسجيل بنجاح! الرجاء تسجيل الدخول");
    window.location.href = "login.html";

  } catch (err) {
    console.error(err);
    if (err.code === 'auth/email-already-in-use') {
      alert("❗ هذا البريد الإلكتروني مستخدم من قبل");
    } else {
      alert("❌ فشل في التسجيل: " + err.message);
    }
  }
});
