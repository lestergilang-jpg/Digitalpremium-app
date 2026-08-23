# Analisa & Implementasi Pemindahan State ke Database

## Jawaban Singkat
**Sangat bisa.** Bahkan ini adalah **best practice**. Menyimpan state (seperti session cookies Netflix) secara langsung ke database jauh lebih baik daripada menyimpannya di file JSON lalu disinkronkan melalui Google Drive. Cara ini akan menyederhanakan arsitektur, menghilangkan delay sinkronisasi (ribet dan sering konflik), serta membuat bot bisa berjalan di server/environment manapun tanpa perlu setup Google Drive Desktop.

## Analisa Project Anda Saat Ini
Berdasarkan hasil analisa pada struktur project:
1. **Model Database Sudah Siap**: Di dalam NestJS API Anda, sudah terdapat model `AccountSession` (`apps/api/src/database/models/account-session.model.ts`) yang dipetakan ke tabel `account_session`. Tabel ini sudah memiliki kolom yang tepat: `platform` (misal: "netflix"), `identifier` (email akun), dan `session_data` (format JSON).
2. **Logika Bot Saat Ini**: Pada file `apps/bot2/src/modules/netflix/services/NetflixGetTokenService.ts`, bot saat ini membaca path lokal hasil sinkronisasi GDrive (`getDataRoot()`) menggunakan modul `fs`:
   ```typescript
   const sessionPath = path.join(getDataRoot(), "session_data", `netflix_${emailFileName}.json`);
   const sessionData = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
   ```

## Langkah-langkah Implementasi (Action Plan)

### 1. Buat Endpoint API Baru (di `apps/api`)
Kita perlu membuat endpoint internal atau endpoint public/khusus bot untuk melakukan `GET` dan `POST` data sesi.
- **Tambahkan di public/internal Controller**:
  Buat endpoint seperti `GET /internal/sessions/:platform/:identifier` dan `POST /internal/sessions`.
- **Logika Service**:
  Gunakan `accountSessionRepository` untuk melakukan *upsert* data berdasarkan platform (misal: "netflix") dan identifier (email).
  *Catatan: Mengingat tabel ini ada di skema tenant, jika bot mengelola akun lintas tenant, pastikan API menerima parameter `tenant_id` atau integrasikan pencarian lintas tenant.*

### 2. Update Modul Bot (di `apps/bot2`)
Ubah cara bot mendapatkan dan menyimpan state (khususnya untuk Netflix).

**Sebelumnya (Membaca File Lokal):**
```typescript
const sessionPath = path.join(getDataRoot(), "session_data", `netflix_${emailFileName}.json`);
const sessionData = JSON.parse(fs.readFileSync(sessionPath, "utf-8"));
```

**Ubah Menjadi (HTTP Request ke API):**
```typescript
const apiUrl = `http://localhost:3000/internal/sessions/netflix/${emailFileName}`; // sesuaikan base url
const fetchResponse = await fetch(apiUrl, { method: "GET" });

if (!fetchResponse.ok) {
  throw new Error(`Session cookies not found in database.`);
}
const sessionData = await fetchResponse.json();
```
*(Catatan: Anda juga bisa menggunakan Socket.io yang sudah terhubung di bot2, misalnya dengan emit `get_session` dan `save_session`).*

### 3. Eksekusi Script Migrasi State (Opsional)
Jika Anda sudah memiliki banyak file JSON di Google Drive yang datanya tidak boleh hilang, Anda dapat membuat skrip sederhana satu kali jalan (bisa ditempatkan di `bot2` atau skrip independen) yang membaca semua file JSON di folder `VolveBotData/session_data`, lalu melakukan *POST* ke endpoint API baru untuk memindahkannya ke database.

---
Dengan menerapkan ini, Google Drive tidak lagi diperlukan untuk sinkronisasi state. Proses `get token` di bot akan menjadi lebih stabil dan terpusat.
