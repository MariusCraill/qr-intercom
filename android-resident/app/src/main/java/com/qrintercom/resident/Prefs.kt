package com.qrintercom.resident

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map

val Context.dataStore: DataStore<Preferences> by preferencesDataStore(name = "intercom_prefs")

object Prefs {
    private val KEY_TOKEN = stringPreferencesKey("auth_token")
    private val KEY_RESIDENT_ID = stringPreferencesKey("resident_id")
    private val KEY_RESIDENT_NAME = stringPreferencesKey("resident_name")
    private val KEY_RESIDENT_UNIT = stringPreferencesKey("resident_unit")
    private val KEY_SERVER = stringPreferencesKey("server_url")

    suspend fun saveLogin(context: Context, token: String, id: String, name: String, unit: String, server: String) {
        context.dataStore.edit { prefs ->
            prefs[KEY_TOKEN] = token
            prefs[KEY_RESIDENT_ID] = id
            prefs[KEY_RESIDENT_NAME] = name
            prefs[KEY_RESIDENT_UNIT] = unit
            prefs[KEY_SERVER] = server
        }
    }

    suspend fun clear(context: Context) {
        context.dataStore.edit { it.clear() }
    }

    suspend fun getToken(context: Context): String? =
        context.dataStore.data.map { it[KEY_TOKEN] }.first()

    suspend fun getResidentId(context: Context): String? =
        context.dataStore.data.map { it[KEY_RESIDENT_ID] }.first()

    suspend fun getResidentName(context: Context): String? =
        context.dataStore.data.map { it[KEY_RESIDENT_NAME] }.first()

    suspend fun getResidentUnit(context: Context): String? =
        context.dataStore.data.map { it[KEY_RESIDENT_UNIT] }.first()

    suspend fun getServer(context: Context): String =
        context.dataStore.data.map { it[KEY_SERVER] ?: Urls.BASE }.first()

    suspend fun isLoggedIn(context: Context): Boolean =
        getToken(context) != null
}
