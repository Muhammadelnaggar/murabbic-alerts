<!DOCTYPE html>
<html lang="ar">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>مربي جديد</title>
  <style>
    * {
      box-sizing: border-box;
    }

    html, body {
      margin: 0;
      padding: 0;
      height: 100%;
      font-family: 'Segoe UI', Tahoma, sans-serif;
      background-color: #f0f8ff;
      direction: rtl;
    }

    .container {
      height: 100%;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      padding: 20px;
    }

    .form-box {
      background-color: white;
      padding: 20px;
      border-radius: 12px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.1);
      width: 100%;
      max-width: 400px;
    }

    .form-box img {
      width: 80px;
      margin: 0 auto 20px;
      display: block;
    }

    h2 {
      text-align: center;
      margin-bottom: 20px;
      color: #2e7d32;
    }

    input {
      width: 100%;
      padding: 12px;
      margin-bottom: 15px;
      border-radius: 6px;
      border: 1px solid #ccc;
      font-size: 16px;
    }

    button {
      width: 100%;
      padding: 12px;
      background-color: #2e7d32;
      color: white;
      border: none;
      font-size: 16px;
      border-radius: 6px;
      cursor: pointer;
    }

    button:hover {
      background-color: #1b5e20;
    }

    .login-link {
      text-align: center;
      margin-top: 15px;
      font-size: 14px;
    }

    .login-link a {
      color: #2e7d32;
      text-decoration: none;
    }

    .login-link a:hover {
      text-decoration: underline;
    }
  </style>
</head>
<body>

  <div class="container">
    <div class="form-box">
      <img src="images/logo.png" alt="شعار مربيك">
      <h2>مربي جديد</h2>

      <form id="registerForm">
        <input type="text" name="username" placeholder="الاسم الكامل" required />
        <input type="tel" name="phone" placeholder="رقم الهاتف" required />
        <input type="password" name="password" placeholder="كلمة المرور" required />
        <input type="password" name="confirmPassword" placeholder="تأكيد كلمة المرور" required />
        <button type="submit">إنشاء حساب 👤</button>
      </form>

      <div class="login-link">
        لديك حساب؟ <a href="login.html">سجّل الدخول</a>
      </div>
    </div>
  </div>

  <script>
    document.getElementById("registerForm").addEventListener("submit", async function (e) {
      e.preventDefault();

      const fullName = this.username.value;
      const phone = this.phone.value;
      const password = this.password.value;
      const confirm = this.confirmPassword.value;

      if (password !== confirm) {
        alert("❌ كلمتا المرور غير متطابقتين");
        return;
      }

      try {
        const res = await fetch('/api/users', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: fullName, phone, password })
        });

        if (!res.ok) {
          alert("فشل في إنشاء الحساب");
          return;
        }

        const data = await res.json();
        localStorage.setItem("user_id", data.user.id);
        window.location.href = "login.html";
      } catch (err) {
        console.error(err);
        alert("حدث خطأ أثناء التسجيل");
      }
    });
  </script>

</body>
</html>
