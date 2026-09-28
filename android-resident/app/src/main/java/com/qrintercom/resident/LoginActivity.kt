package com.qrintercom.resident

import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.ProgressBar
import android.widget.TextView
import androidx.appcompat.app.AppCompatActivity
import androidx.lifecycle.lifecycleScope
import com.google.android.material.button.MaterialButton
import com.google.android.material.textfield.TextInputEditText
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject

class LoginActivity : AppCompatActivity() {
    private val client = TrustAllCerts.createClient()

    private lateinit var editPhone: TextInputEditText
    private lateinit var editPassword: TextInputEditText
    private lateinit var btnLogin: MaterialButton
    private lateinit var loginFormLayout: View
    private lateinit var registerFormLayout: View
    private lateinit var editRegUnit: TextInputEditText
    private lateinit var editRegName: TextInputEditText
    private lateinit var editRegPhone: TextInputEditText
    private lateinit var editRegEmail: TextInputEditText
    private lateinit var editRegPassword: TextInputEditText
    private lateinit var btnRegister: MaterialButton
    private lateinit var textToggle: TextView
    private lateinit var textError: TextView
    private lateinit var progress: ProgressBar

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_login)

        lifecycleScope.launch {
            if (Prefs.isLoggedIn(this@LoginActivity)) {
                startMainAndService()
                return@launch
            }
        }

        editPhone = findViewById(R.id.editPhone)
        editPassword = findViewById(R.id.editPassword)
        btnLogin = findViewById(R.id.btnLogin)
        loginFormLayout = findViewById(R.id.loginFormLayout)
        registerFormLayout = findViewById(R.id.registerFormLayout)
        editRegUnit = findViewById(R.id.editRegUnit)
        editRegName = findViewById(R.id.editRegName)
        editRegPhone = findViewById(R.id.editRegPhone)
        editRegEmail = findViewById(R.id.editRegEmail)
        editRegPassword = findViewById(R.id.editRegPassword)
        btnRegister = findViewById(R.id.btnRegister)
        textToggle = findViewById(R.id.textToggle)
        textError = findViewById(R.id.textError)
        progress = findViewById(R.id.progressLogin)

        textToggle.setOnClickListener {
            if (registerFormLayout.visibility == View.VISIBLE) {
                showLoginForm()
            } else {
                showRegisterForm()
            }
        }

        btnLogin.setOnClickListener {
            val phone = editPhone.text.toString().trim()
            val password = editPassword.text.toString().trim()

            if (phone.isEmpty() || password.isEmpty()) {
                showError("Phone and password required")
                return@setOnClickListener
            }

            setLoading(true)
            lifecycleScope.launch {
                try {
                    val result = withContext(Dispatchers.IO) { doLogin(phone, password) }
                    if (result.optBoolean("isSuccess", false)) {
                        val data = result.getJSONObject("data")
                        val token = data.getString("token")
                        val resident = data.getJSONObject("resident")
                        saveAndGo(token, resident)
                    } else {
                        showError(result.optString("error", "Login failed"))
                    }
                } catch (e: Exception) {
                    showError("Connection failed: ${e.message}")
                } finally {
                    setLoading(false)
                }
            }
        }

        btnRegister.setOnClickListener { onRegisterClick() }
    }

    private fun showRegisterForm() {
        loginFormLayout.visibility = View.GONE
        registerFormLayout.visibility = View.VISIBLE
        textToggle.text = getString(R.string.toggle_to_login)
        textError.visibility = View.GONE
    }

    private fun showLoginForm() {
        registerFormLayout.visibility = View.GONE
        loginFormLayout.visibility = View.VISIBLE
        textToggle.text = getString(R.string.toggle_to_register)
        textError.visibility = View.GONE
    }

    private fun onRegisterClick() {
        val unit = editRegUnit.text.toString().trim()
        val name = editRegName.text.toString().trim()
        val phone = editRegPhone.text.toString().trim()
        val email = editRegEmail.text.toString().trim()
        val password = editRegPassword.text.toString()

        if (unit.isEmpty() || name.isEmpty() || phone.isEmpty() || password.isEmpty()) {
            showError("Unit, name, phone and password required")
            return
        }

        setLoading(true)
        lifecycleScope.launch {
            try {
                val result = withContext(Dispatchers.IO) {
                    doRegister(unit, name, phone, email, password)
                }
                if (result.optBoolean("isSuccess", false)) {
                    val data = result.getJSONObject("data")
                    val token = data.getString("token")
                    val resident = data.getJSONObject("resident")
                    saveAndGo(token, resident)
                } else {
                    showError(result.optString("error", "Registration failed"))
                }
            } catch (e: Exception) {
                showError("Connection failed: ${e.message}")
            } finally {
                setLoading(false)
            }
        }
    }

    private fun saveAndGo(token: String, resident: JSONObject) {
        lifecycleScope.launch {
            val serverHost = Prefs.getServer(this@LoginActivity)
            Prefs.saveLogin(
                this@LoginActivity,
                token,
                resident.getString("id"),
                resident.getString("name"),
                resident.getString("unit"),
                serverHost
            )
            startMainAndService()
        }
    }

    private fun doLogin(phone: String, password: String): JSONObject {
        val json = JSONObject().apply {
            put("phone", phone)
            put("password", password)
        }
        return postJson("/auth/resident-login", json)
    }

    private fun doRegister(unit: String, name: String, phone: String, email: String, password: String): JSONObject {
        val json = JSONObject().apply {
            put("unit", unit)
            put("name", name)
            put("phone", phone)
            put("password", password)
            put("email", email.ifEmpty { "" })
        }
        return postJson("/auth/resident-register", json)
    }

    private fun postJson(path: String, json: JSONObject): JSONObject {
        val body = json.toString().toRequestBody("application/json".toMediaType())
        val request = Request.Builder()
            .url(Urls.rest(path))
            .post(body)
            .build()
        val response = client.newCall(request).execute()
        val responseBody = response.body?.string() ?: "{}"
        val jsonObj = JSONObject(responseBody)
        return if (response.isSuccessful) {
            JSONObject().apply {
                put("isSuccess", true)
                put("data", jsonObj)
            }
        } else {
            jsonObj.put("isSuccess", false)
        }
    }

    private fun showError(msg: String) {
        textError.text = msg
        textError.visibility = View.VISIBLE
    }

    private fun setLoading(loading: Boolean) {
        progress.visibility = if (loading) View.VISIBLE else View.GONE
        btnLogin.isEnabled = !loading
        btnRegister.isEnabled = !loading
    }

    private fun startMainAndService() {
        CallService.start(this@LoginActivity)
        startActivity(Intent(this, MainActivity::class.java))
        finish()
    }
}
